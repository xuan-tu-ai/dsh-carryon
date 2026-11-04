#!/usr/bin/env node
// Release gate (docs/release.md): did a real-model run show working CarryOn folds?
//
// Reads <run-dir>/results.jsonl from scripts/bench/run.mjs and checks every `carryon` record:
//   1. dsh exited 0 and did not time out (no crash);
//   2. the session does not mention bench/tasks (not contaminated);
//   3. at least one CarryOn fold was committed (compaction/end without error after a CarryOn summary);
//   4. the agent took at least one step after the first committed fold (the session went on after it).
// `basic` records are only printed, for comparison. The gate says nothing about token savings: one run per arm
// is an anecdote, and the README must say so.
//
// Usage: node scripts/bench/smoke-gate.mjs <run-dir>     exit 0 when every carryon record passes, 1 otherwise
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const dir = process.argv[2]
if (!dir) {
  console.error('usage: smoke-gate.mjs <run-dir>')
  process.exit(2)
}
const records = readFileSync(join(dir, 'results.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))

/** Problems that keep one carryon record from passing the gate; empty when it passes. */
function gateProblems(r) {
  const problems = []
  if (r.timedOut) problems.push('timed out')
  else if (r.exitCode !== 0) problems.push(`dsh exited with ${r.exitCode}`)
  if (r.contaminated) problems.push('contaminated: the session mentions bench/tasks')
  const m = r.metrics
  if (!m) return [...problems, 'no session log']
  if (!(m.compactions.committedCarryOn >= 1)) problems.push('no committed CarryOn fold')
  else if (!(m.stepsAfterFirstFold >= 1)) problems.push('no agent step after the first committed fold')
  return problems
}

const describe = (r) => {
  const m = r.metrics
  const c = m?.compactions
  return `${r.task}-${r.arm}-r${r.repeat}: hidden ${r.grade.passed}/${r.grade.tests}, `
    + (m ? `${m.steps} steps, ${c.committedCarryOn ?? 0} committed CarryOn folds, ${c.failed} failed, ${c.otherSummaries} dsh summaries, `
      + `${m.stepsAfterFirstFold ?? '–'} steps after the first fold` : 'no metrics')
}

const carryon = records.filter((r) => r.arm === 'carryon')
let failed = 0
for (const r of records) {
  const problems = r.arm === 'carryon' ? gateProblems(r) : []
  if (problems.length) failed += 1
  console.log(`${r.arm === 'carryon' ? (problems.length ? 'FAIL' : 'PASS') : 'info'}  ${describe(r)}${problems.length ? ` (${problems.join('; ')})` : ''}`)
}
if (!carryon.length) {
  console.log('FAIL  no carryon records')
  process.exit(1)
}
console.log(failed ? `gate failed: ${failed} of ${carryon.length} carryon run(s)` : `gate passed: ${carryon.length} carryon run(s)`)
process.exit(failed ? 1 : 0)
