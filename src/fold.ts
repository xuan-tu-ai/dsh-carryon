/**
 * One CarryOn fold over a dsh compaction region: Tracker → Compiler → Validator → commit (§3.3, Appendix A.1
 * "Update Procedure"). Port of carrycode `CarryOnRuntime.fold` (`src/carrycode/runtime.py`) without the trigger,
 * which dsh owns, and without the Grounder (carrycode M2).
 *
 * The fold works on copies: the committed state passed in is never changed. A rejected fold reports why; the
 * engine turns that into a failed compaction, so the session surface stays as it was.
 *
 * @module dsh-carryon/fold
 */

import { EvidencePackage, ExecutionContext, type Candidate } from './records.ts'
import { CandidateRegistry, CarrierStore } from './registry.ts'
import type { Compiler, Tracker } from './roles.ts'
import type { CarryOnState } from './state.ts'
import { validate } from './validator.ts'
import { estimateTokens, messageText, projectTail, renderCheckpoint, stepTexts, type ViewMessage } from './view.ts'

const SUMMARY_OPEN = '<compacted-summary>'
const SUMMARY_CLOSE = '</compacted-summary>'
const CHECKPOINT_BLOCK = /<carryon_checkpoint>[\s\S]*?<\/carryon_checkpoint>/g

/** Placeholder task when the first fold's region holds no user message. */
export const UNKNOWN_TASK = '(The original task was not in the folded history.)'

/**
 * The interaction messages of a compaction region, as the runtime roles see them.
 *
 * dsh hands `summarize()` the system head followed by the shadowed region, and the region of every fold after the
 * first starts with the previous checkpoint message. The system head is dropped. In a checkpoint message, dsh's
 * framing and our own `<carryon_checkpoint>` block are dropped (carriers and the execution context come from the
 * state); what is left, such as a dsh summary written by the fallback, stays as a user message.
 * @param messages - `SummarizationInput.messages`.
 * @returns messages to number and project, in order.
 */
export function interactionMessages(messages: readonly ViewMessage[]): ViewMessage[] {
  const out: ViewMessage[] = []
  for (const m of messages) {
    if (m.role === 'system') continue
    const text = m.role === 'user' ? messageText(m) : ''
    const open = text.indexOf(SUMMARY_OPEN)
    const close = text.lastIndexOf(SUMMARY_CLOSE)
    if (open >= 0 && close > open) {
      const inner = text.slice(open + SUMMARY_OPEN.length, close).replace(CHECKPOINT_BLOCK, '').trim()
      if (inner.length > 0) out.push({ role: 'user', content: inner })
      continue
    }
    out.push(m)
  }
  return out
}

/**
 * The first user message's text, used as the task on the first fold (design doc §4.2).
 * @returns the text, or `null` when there is no user message.
 */
export function firstUserText(messages: readonly ViewMessage[]): string | null {
  const m = messages.find((x) => x.role === 'user')
  return m === undefined ? null : messageText(m)
}

/**
 * What a failed fold leaves behind in process memory: candidate updates are kept (App. A.1) and the Tracker does
 * not rescan messages it has seen. Lost on resume, as in the design doc §4.1.
 */
export interface ScanMemory {
  /** `next_step` of the committed state this memory belongs to. */
  nextStep: number
  candidates: Candidate[]
  /** Leading interaction messages the Tracker has already scanned. */
  scannedThrough: number
}

/** Result of one fold attempt. */
export type FoldOutcome =
  | { ok: true; state: CarryOnState; checkpoint: string; carrierIds: string[] }
  | { ok: false; reason: string; memory: ScanMemory }

/** Inputs of one fold. */
export interface FoldArgs {
  state: CarryOnState
  /** Interaction messages of the region (see {@link interactionMessages}). */
  tail: readonly ViewMessage[]
  memory: ScanMemory | undefined
  tracker: Tracker
  compiler: Compiler
  signal?: AbortSignal
}

/**
 * Run one fold. Never changes `args.state`.
 * @returns the committed state and checkpoint text, or the rejection reason and the scan memory to keep.
 * @throws only when `signal` aborts; other errors become a rejection.
 */
export async function runFold(args: FoldArgs): Promise<FoldOutcome> {
  const { state, tail, tracker, compiler, signal } = args
  const offset = state.next_step
  const memory = args.memory?.nextStep === offset ? args.memory : undefined
  const registry = new CandidateRegistry()
  for (const c of memory?.candidates ?? state.candidates) registry.upsert(c)
  let scannedThrough = Math.min(memory?.scannedThrough ?? 0, tail.length)
  const reject = (reason: string): FoldOutcome => ({
    ok: false,
    reason,
    memory: { nextStep: offset, candidates: registry.all(), scannedThrough },
  })

  try {
    const task = state.task ?? firstUserText(tail) ?? UNKNOWN_TASK
    const restored = CarrierStore.fromCurrent(state.carriers)

    const trackerText = projectTail(tail.slice(scannedThrough), offset + scannedThrough)
    const compilerText = projectTail(tail, offset)
    const scan = await tracker.scan(task, trackerText, registry.all(), restored.current(), state.ec, signal)
    scannedThrough = tail.length
    for (const c of scan.candidate_updates) registry.upsert(c) // kept even if this fold fails (App. A.1)
    if (scan.compile_requests.length === 0) return reject('no compile request')

    const candidates = scan.compile_requests.flatMap((r) => registry.get(r.candidate_id) ?? [])
    const steps = [...new Set(scan.compile_requests.flatMap((r) => r.evidence_steps))].sort((a, b) => a - b)
    const prior = candidates.flatMap((c) => (c.target_carrier_id ? restored.get(c.target_carrier_id) ?? [] : []))
    const pkg = EvidencePackage.parse({
      candidates,
      prior_records: prior,
      evidence: Object.fromEntries([...stepTexts(tail, offset, steps)].map(([s, t]) => [String(s), t])),
    })
    const ecIn = ExecutionContext.parse(structuredClone(state.ec))
    const resolved = new Set(scan.resolved_obligation_ids)
    for (const o of ecIn.obligations) if (resolved.has(o.obligation_id)) o.resolved = true

    const output = await compiler.compile(pkg, ecIn, compilerText, signal)
    const problems = validate(output, pkg, restored)
    if (problems.length > 0) return reject(problems.join('; '))
    const records = restored.materialize(output.carrier_edits, state.folds + 1)
    restored.apply(records)
    for (const c of candidates) registry.remove(c.candidate_id)

    const next: CarryOnState = {
      v: state.v,
      folds: state.folds + 1,
      task,
      next_step: offset + tail.length,
      carriers: restored.current(),
      candidates: registry.all(),
      ec: output.execution_context,
    }
    return { ok: true, state: next, checkpoint: renderCheckpoint(next.carriers, next.ec)!, carrierIds: records.map((r) => r.carrier_id) }
  } catch (e) {
    signal?.throwIfAborted()
    return reject(e instanceof Error ? `${e.name}: ${e.message}` : String(e))
  }
}

/**
 * Text volume of a region's interaction messages, the paper's chars/4 estimate (Appendix A.3).
 * @returns estimated tokens.
 */
export function tailTokens(tail: readonly ViewMessage[]): number {
  return estimateTokens(tail)
}
