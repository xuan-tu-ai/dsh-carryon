/**
 * The runtime roles: Tracker (§3.3, "Tracking Candidates") and Compiler (§3.3, "Joint Compilation", Eq. 2).
 *
 * Port of carrycode `src/carrycode/tracker.py` and `compiler.py`. The user messages are byte-identical to
 * carrycode's (parity fixtures `test/fixtures/parity/roles.json`); the system prompts are carrycode's
 * `src/carrycode/prompts/*.md`, vendored into `prompts/` (design doc §6).
 *
 * @module dsh-carryon/roles
 */

import { readFileSync } from 'node:fs'
import { z } from 'zod'
import type { RoleLLM } from './llm.ts'
import { pyJsonDumps } from './pyjson.ts'
import {
  Candidate,
  CompilerOutput,
  ExecutionContext,
  Int,
  openObligations,
  type CarrierRecord,
  type EvidencePackage,
} from './records.ts'

/** One Grounder check the Tracker asks for, bound to a candidate (Appendix A.2). Not run yet (carrycode M2). */
export const CheckSpec = z.object({
  /** One of: file_exists, git_diff_nonempty, python_compiles, test_outcome, command_exit. */
  check_name: z.string(),
  target: z.string(),
  expected: z.string().nullable().default(null),
})
export type CheckSpec = z.output<typeof CheckSpec>

export const CompileRequest = z.object({
  candidate_id: z.string(),
  /** Log steps whose content the Compiler may use as evidence. */
  evidence_steps: z.array(Int).default([]),
  checks: z.array(CheckSpec).default([]),
})
export type CompileRequest = z.output<typeof CompileRequest>

export const TrackerOutput = z.object({
  candidate_updates: z.array(Candidate).default([]),
  /** At most `maxRequestsPerScan` (the paper uses 4). */
  compile_requests: z.array(CompileRequest).default([]),
  resolved_obligation_ids: z.array(z.string()).default([]),
})
export type TrackerOutput = z.output<typeof TrackerOutput>

const PROMPTS_DIR = new URL('../prompts/', import.meta.url)
const promptCache = new Map<string, string>()

/**
 * System prompt of a runtime role, vendored from carrycode.
 * @param name - `tracker` or `compiler`.
 * @returns the prompt text.
 */
export function loadPrompt(name: 'tracker' | 'compiler'): string {
  let text = promptCache.get(name)
  if (text === undefined) {
    text = readFileSync(new URL(`${name}.md`, PROMPTS_DIR), 'utf8')
    promptCache.set(name, text)
  }
  return text
}

/** The carrier fields the Tracker sees, in carrycode's (model field) order. */
function trackerCarrierView(c: CarrierRecord) {
  return { carrier_id: c.carrier_id, version: c.version, carrier_type: c.carrier_type, subject: c.subject, summary: c.summary }
}

/** Build the Tracker's user message (sections: task, carriers, candidates, open obligations, limits, live tail). */
export function buildTrackerUserMessage(
  task: string,
  liveTailText: string,
  candidates: readonly Candidate[],
  carriers: readonly CarrierRecord[],
  ec: ExecutionContext,
  maxRequests: number,
): string {
  const carriersText = carriers.length > 0 ? pyJsonDumps(carriers.map(trackerCarrierView)) : 'none'
  const candidatesText = candidates.length > 0 ? pyJsonDumps(candidates.map((c) => Candidate.parse(c))) : 'none'
  const open = openObligations(ec)
  const obligationsText = open.length > 0 ? open.map((o) => `- [${o.obligation_id}] ${o.text}`).join('\n') : 'none'
  return [
    `# Task\n${task}`,
    `# Current carriers\n${carriersText}`,
    `# Candidates\n${candidatesText}`,
    `# Open obligations\n${obligationsText}`,
    `# Limits\nReturn at most ${maxRequests} compile_requests.`,
    `# Live tail\n${liveTailText}`,
  ].join('\n\n')
}

/** Build the Compiler's user message (sections: candidates, prior records, evidence, execution context, live tail). */
export function buildCompilerUserMessage(pkg: EvidencePackage, ec: ExecutionContext, liveTailText: string): string {
  const candidatesText = pyJsonDumps(pkg.candidates)
  const priorText = pkg.prior_records.length > 0 ? pyJsonDumps(pkg.prior_records) : 'none'
  const steps = Object.keys(pkg.evidence).map(Number).sort((a, b) => a - b)
  const evidenceText = steps.length > 0 ? steps.map((n) => `## step ${n}\n${pkg.evidence[String(n)]}`).join('\n\n') : 'none'
  return [
    `# Selected candidates\n${candidatesText}`,
    `# Prior carrier records\n${priorText}`,
    `# Evidence\n${evidenceText}`,
    `# Current execution context\n${pyJsonDumps(ec)}`,
    `# Live tail\n${liveTailText}`,
  ].join('\n\n')
}

/** Proposes candidate updates and compile requests from the live tail (§3.3, "Tracking Candidates"). */
export class Tracker {
  readonly llm: RoleLLM
  readonly maxRequestsPerScan: number
  private readonly prompt: string

  constructor(llm: RoleLLM, maxRequestsPerScan = 4, prompt = loadPrompt('tracker')) {
    this.llm = llm
    this.maxRequestsPerScan = maxRequestsPerScan
    this.prompt = prompt
  }

  /**
   * Scan the live tail. Requests for unknown candidates are dropped, the rest capped at `maxRequestsPerScan`, and
   * only open obligations can be resolved.
   * @returns the filtered output; empty when the model gave no valid reply.
   */
  async scan(
    task: string,
    liveTailText: string,
    candidates: readonly Candidate[],
    carriers: readonly CarrierRecord[],
    ec: ExecutionContext,
    signal?: AbortSignal,
  ): Promise<TrackerOutput> {
    const user = buildTrackerUserMessage(task, liveTailText, candidates, carriers, ec, this.maxRequestsPerScan)
    const result = await this.llm.completeJson(this.prompt, user, TrackerOutput, signal)
    if (result === null) return TrackerOutput.parse({})
    const known = new Set([...candidates, ...result.candidate_updates].map((c) => c.candidate_id))
    const openIds = new Set(openObligations(ec).map((o) => o.obligation_id))
    return {
      candidate_updates: result.candidate_updates,
      compile_requests: result.compile_requests.filter((r) => known.has(r.candidate_id)).slice(0, this.maxRequestsPerScan),
      resolved_obligation_ids: result.resolved_obligation_ids.filter((id) => openIds.has(id)),
    }
  }
}

/** Jointly proposes carrier edits and a revised execution context (§3.3, Eq. 2). */
export class Compiler {
  readonly llm: RoleLLM
  private readonly prompt: string

  constructor(llm: RoleLLM, prompt = loadPrompt('compiler')) {
    this.llm = llm
    this.prompt = prompt
  }

  /**
   * Compile the selected candidates.
   * @returns the model's output; an abstain (`invalid_output`) that keeps `ec` when no valid reply came back.
   */
  async compile(pkg: EvidencePackage, ec: ExecutionContext, liveTailText: string, signal?: AbortSignal): Promise<CompilerOutput> {
    const user = buildCompilerUserMessage(pkg, ec, liveTailText)
    const result = await this.llm.completeJson(this.prompt, user, CompilerOutput, signal)
    return result ?? CompilerOutput.parse({ execution_context: structuredClone(ec), abstain_reason: 'invalid_output' })
  }
}
