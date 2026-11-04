#!/usr/bin/env node
// Check a session log produced by scripts/offline-check.sh. Exits non-zero when an expectation is broken.
//
// Every compaction must be one of:
// - a CarryOn fold: success, rawOutput holds CarryOn state, the fold counter goes 1, 2, 3, ... (state survives
//   process restarts), next_step only grows, carriers are never lost, and the single replacement message is a
//   checkpoint holding `<carryon_checkpoint>`;
// - a failed fold: compaction/end with an error, no compaction/summary and no replacement (nothing changed);
// - a fallback near the context window: success without CarryOn state, whose replacement keeps the current CarryOn
//   checkpoint (if any fold committed) in front of dsh's own summary.
// At least two folds, one failure and one fallback are required, and a fold must commit after a failure.
import { readSessionEvents } from './session-log.mjs'

const file = process.argv[2]
if (!file) {
  console.error('usage: check-fold-log.mjs <session.vN.jsonl.zstd>')
  process.exit(2)
}
const events = readSessionEvents(file)
const problems = []
const byId = new Map()
for (const e of events) {
  const id = e.data?.compactionId ?? e.data?.source?.compactionId
  if (!id || !e.type.startsWith('compaction/') && !(e.type === 'user/message' && e.surfaceOp?.op === 'replace')) continue
  if (!byId.has(id)) byId.set(id, [])
  byId.get(id).push(e)
}

const text = (message) => (message?.data?.content ?? []).map((b) => b.text ?? '').join('')
let last = { folds: 0, next_step: 0, carriers: [] }
let failures = 0
let fallbacks = 0
let successAfterFailure = false
for (const [id, group] of byId) {
  const end = group.find((e) => e.type === 'compaction/end')
  const summary = group.find((e) => e.type === 'compaction/summary')
  const replace = group.filter((e) => e.type === 'user/message')
  const short = id.slice(0, 8)
  if (!end) {
    problems.push(`${short}: no compaction/end`)
    continue
  }
  if (end.data.error !== undefined) {
    failures += 1
    if (!/dsh-carryon: (fold rejected|cooling down)/.test(end.data.error)) problems.push(`${short}: unexpected failure: ${end.data.error}`)
    if (summary || replace.length) problems.push(`${short}: failed fold left a summary or a replacement`)
    console.log(`${short}: failed, surface unchanged (${end.data.error.slice(0, 90)})`)
    continue
  }
  if (!summary) {
    problems.push(`${short}: successful compaction without compaction/summary`)
    continue
  }
  if (replace.length !== 1 || replace[0].data.source?.kind !== 'compact-checkpoint') {
    problems.push(`${short}: expected one checkpoint replacement, got ${replace.length}`)
    continue
  }
  const raw = summary.data.rawOutput?.map((b) => b.text ?? '').join('') ?? ''
  let state
  try { state = JSON.parse(raw).carryon_state } catch { state = undefined }
  const checkpoint = text(replace[0])
  if (state === undefined) {
    fallbacks += 1
    if (last.folds > 0 && !checkpoint.includes('<carryon_checkpoint>')) problems.push(`${short}: fallback dropped the CarryOn checkpoint`)
    if (!checkpoint.includes('fake dsh summary')) problems.push(`${short}: fallback without dsh's summary`)
    console.log(`${short}: fallback to dsh's summary (provider ${summary.data.provider}), CarryOn state unchanged`)
    continue
  }
  if (state.folds !== last.folds + 1) problems.push(`${short}: state.folds=${state.folds}, expected ${last.folds + 1}`)
  if (state.next_step <= last.next_step) problems.push(`${short}: next_step ${state.next_step} did not grow from ${last.next_step}`)
  const ids = new Set(state.carriers.map((c) => c.carrier_id))
  const lost = last.carriers.filter((c) => !ids.has(c.carrier_id))
  if (lost.length) problems.push(`${short}: lost carriers ${lost.map((c) => c.carrier_id).join(', ')}`)
  if (!checkpoint.includes('<carryon_checkpoint>') || !checkpoint.includes('## Continuation carriers')) problems.push(`${short}: replacement is not a CarryOn checkpoint`)
  if (failures > 0) successAfterFailure = true
  console.log(`${short}: fold ${state.folds} committed by ${summary.data.provider}/${summary.data.model}: ${state.carriers.length} carrier(s), next_step ${state.next_step}`)
  last = state
}
if (last.folds < 2) problems.push(`only ${last.folds} committed fold(s), expected at least 2`)
if (failures === 0) problems.push('no failed fold (was DSH_CARRYON_FAIL=1 set for some turns?)')
if (!successAfterFailure) problems.push('no committed fold after a failed one')
if (fallbacks === 0) problems.push('no fallback (the fallback phase should produce one)')

if (problems.length) {
  console.error('fold check FAILED:\n- ' + problems.join('\n- '))
  process.exit(1)
}
console.log(`fold check passed: ${last.folds} committed folds, ${failures} failed (no trace), ${fallbacks} fallback(s).`)
