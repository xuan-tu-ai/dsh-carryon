#!/usr/bin/env node
// Check a session log produced by scripts/p0-offline-check.sh. Exits non-zero on the first broken expectation.
//
// Expectations (P0 acceptance, carrycode docs/design/dsh-plugin.md §8):
// 1. Every compaction that ended without error was written by dsh-carryon, carries CarryOn state in rawOutput,
//    and is followed by exactly one replacement user/message whose checkpoint source names the same compactionId.
// 2. The fold counter in that state goes 1, 2, 3, ... over successful folds (state survives resume).
// 3. At least one fold failed on purpose; a failed fold has no compaction/summary and no replacement.
// 4. At least one successful fold comes after a failed one (a failure does not break later folds).
import { readSessionEvents } from './session-log.mjs'

const file = process.argv[2]
if (!file) {
  console.error('usage: check-p0-log.mjs <session.vN.jsonl.zstd>')
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

let expectedFold = 1
let failures = 0
let successAfterFailure = false
for (const [id, group] of byId) {
  const end = group.find(e => e.type === 'compaction/end')
  const summary = group.find(e => e.type === 'compaction/summary')
  const replace = group.filter(e => e.type === 'user/message')
  const short = id.slice(0, 8)
  if (!end) {
    problems.push(`${short}: no compaction/end`)
    continue
  }
  if (end.data.error !== undefined) {
    failures += 1
    if (!end.data.error.includes('DSH_CARRYON_P0_FAIL')) problems.push(`${short}: unexpected failure: ${end.data.error}`)
    if (summary || replace.length) problems.push(`${short}: failed fold left a summary or a replacement`)
    console.log(`fold ${short}: failed as intended, surface unchanged`)
    continue
  }
  if (!summary) problems.push(`${short}: successful compaction without compaction/summary`)
  else {
    if (summary.data.provider !== 'dsh-carryon') problems.push(`${short}: summary written by ${summary.data.provider}`)
    const text = summary.data.rawOutput?.[0]?.text
    const state = text ? JSON.parse(text).carryon_state : undefined
    if (state?.folds !== expectedFold) problems.push(`${short}: state.folds=${state?.folds}, expected ${expectedFold}`)
    if (failures > 0) successAfterFailure = true
    console.log(`fold ${short}: committed, state ${text}`)
    expectedFold += 1
  }
  if (replace.length !== 1) problems.push(`${short}: ${replace.length} replacement messages, expected 1`)
  else if (replace[0].data.source?.kind !== 'compact-checkpoint') problems.push(`${short}: replacement is not a checkpoint`)
}
if (expectedFold === 1) problems.push('no successful fold')
if (failures === 0) problems.push('no failed fold (was DSH_CARRYON_P0_FAIL=1 set for some turns?)')
if (!successAfterFailure) problems.push('no successful fold after a failed one')

if (problems.length) {
  console.error('P0 check FAILED:\n- ' + problems.join('\n- '))
  process.exit(1)
}
console.log(`P0 check passed: ${expectedFold - 1} committed folds, ${failures} failed fold(s) left no trace on the surface.`)
