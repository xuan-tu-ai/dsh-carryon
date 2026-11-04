#!/usr/bin/env node
// Markdown report of a P3 benchmark run: per task and arm, hidden-test score, tokens (agent and compaction),
// estimated cost, steps, peak context and compaction counts; then CarryOn relative to basic.
//
// Usage: node scripts/bench/report.mjs <run-dir> [--price-input 0.15] [--price-cache-read 0.03] [--price-output 0.60]
// Prices are USD per million tokens (defaults: DeepSeek V4.1 Flash list prices, as in carrycode's
// configs/models/deepseek.yaml); cache writes are priced as uncached input. Writes <run-dir>/report.md and prints it.
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'

const { values: opt, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    'price-input': { type: 'string', default: '0.15' },
    'price-cache-read': { type: 'string', default: '0.03' },
    'price-output': { type: 'string', default: '0.60' },
  },
})
const dir = positionals[0]
if (!dir) {
  console.error('usage: report.mjs <run-dir>')
  process.exit(2)
}
const price = { input: Number(opt['price-input']), cacheRead: Number(opt['price-cache-read']), output: Number(opt['price-output']) }
const records = readFileSync(join(dir, 'results.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))

const cost = (t) => ((t.input + t.cacheWrite) * price.input + t.cacheRead * price.cacheRead + t.output * price.output) / 1e6
const prompt = (t) => t.input + t.cacheRead + t.cacheWrite
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN)
const k = (n) => (Number.isFinite(n) ? `${(n / 1000).toFixed(1)}k` : '–')
const pct = (n) => (Number.isFinite(n) ? `${Math.round(n * 100)}%` : '–')
const usd = (n) => (Number.isFinite(n) ? `$${n.toFixed(4)}` : '–')

function summarize(rs) {
  const ok = rs.filter((r) => r.metrics)
  return {
    n: rs.length,
    score: mean(rs.map((r) => (r.grade.tests ? r.grade.passed / r.grade.tests : 0))),
    solved: rs.filter((r) => r.grade.tests > 0 && r.grade.passed === r.grade.tests).length,
    timeouts: rs.filter((r) => r.timedOut).length,
    agentPrompt: mean(ok.map((r) => prompt(r.metrics.agent))),
    agentOutput: mean(ok.map((r) => r.metrics.agent.output)),
    compactionTokens: mean(ok.map((r) => prompt(r.metrics.compaction) + r.metrics.compaction.output)),
    totalTokens: mean(ok.map((r) => prompt(r.metrics.total) + r.metrics.total.output)),
    cost: mean(ok.map((r) => cost(r.metrics.total))),
    steps: mean(ok.map((r) => r.metrics.steps)),
    peak: mean(ok.map((r) => r.metrics.peakContext)),
    folds: mean(ok.map((r) => r.metrics.compactions.carryonFolds)),
    summaries: mean(ok.map((r) => r.metrics.compactions.otherSummaries)),
    failed: mean(ok.map((r) => r.metrics.compactions.failed)),
    wall: mean(rs.map((r) => r.wallSeconds)),
  }
}

const tasks = [...new Set(records.map((r) => r.task))]
const arms = [...new Set(records.map((r) => r.arm))]
const lines = []
const run = JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8'))
lines.push(`# Benchmark report`, '', `Run: \`${dir}\`, started ${run.started}. Options: \`${JSON.stringify(run.options)}\`.`)
lines.push(`Prices (USD per million tokens): input ${price.input}, cache read ${price.cacheRead}, output ${price.output}.`, '')
lines.push('Means per run. Score = share of hidden tests passed; solved = runs passing all hidden tests. Compaction tokens',
  'include CarryOn role calls of rejected folds. Folds = CarryOn folds; summaries = dsh summaries (basic arm, or CarryOn fallbacks).', '')
lines.push('| Task | Arm | Runs | Score | Solved | Agent prompt | Agent output | Compaction | Total tokens | Cost | Steps | Peak context | Folds | Summaries | Failed | Wall |')
lines.push('| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |')
const byArm = {}
for (const task of tasks) {
  for (const arm of arms) {
    const rs = records.filter((r) => r.task === task && r.arm === arm)
    if (!rs.length) continue
    const s = summarize(rs)
    lines.push(`| ${task} | ${arm} | ${s.n} | ${pct(s.score)} | ${s.solved} | ${k(s.agentPrompt)} | ${k(s.agentOutput)} | ${k(s.compactionTokens)} | ${k(s.totalTokens)} | ${usd(s.cost)} | ${s.steps.toFixed(1)} | ${k(s.peak)} | ${s.folds.toFixed(1)} | ${s.summaries.toFixed(1)} | ${s.failed.toFixed(1)} | ${Math.round(s.wall)}s |`)
  }
}
lines.push('', '## All tasks', '', '| Arm | Runs | Score | Solved | Total tokens | Cost | Peak context | Timeouts |', '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |')
for (const arm of arms) {
  const s = summarize(records.filter((r) => r.arm === arm))
  byArm[arm] = s
  lines.push(`| ${arm} | ${s.n} | ${pct(s.score)} | ${s.solved} | ${k(s.totalTokens)} | ${usd(s.cost)} | ${k(s.peak)} | ${s.timeouts} |`)
}
if (byArm.carryon && byArm.basic) {
  const ratio = (a, b) => (b ? `${(a / b).toFixed(2)}×` : '–')
  lines.push('', `CarryOn relative to basic: total tokens ${ratio(byArm.carryon.totalTokens, byArm.basic.totalTokens)}, `
    + `cost ${ratio(byArm.carryon.cost, byArm.basic.cost)}, peak context ${ratio(byArm.carryon.peak, byArm.basic.peak)}, `
    + `score ${pct(byArm.carryon.score)} vs ${pct(byArm.basic.score)}.`)
}
const tainted = records.filter((r) => r.contaminated)
if (tainted.length) {
  lines.push('', `**Warning:** ${tainted.length} run(s) mention bench/tasks in their session (hidden tests or reference solutions `
    + `may have been read): ${tainted.map((r) => `${r.task}-${r.arm}-r${r.repeat}`).join(', ')}. Exclude them.`)
}
const idle = records.filter((r) => r.metrics && r.metrics.compactions.started === 0)
if (idle.length) {
  lines.push('', `Note: ${idle.length} run(s) never compacted (${idle.map((r) => `${r.task}-${r.arm}-r${r.repeat}`).join(', ')}). `
    + 'Either the context stayed below the threshold, or the thresholds leave no pressure budget for the window.')
}
if (records.length < 2 * tasks.length * 3) {
  lines.push('', `Note: ${records.length} runs in total. With fewer than 3 runs per task and arm, differences are anecdotal.`)
}
const text = `${lines.join('\n')}\n`
writeFileSync(join(dir, 'report.md'), text)
process.stdout.write(text)
