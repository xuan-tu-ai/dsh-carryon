// scripts/bench/metrics.mjs on a synthetic session log: agent and compaction usage, including the role-call usage of
// a rejected CarryOn fold, which only appears in compaction/end.error.
import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { promptTokens, sessionMetrics } from '../scripts/bench/metrics.mjs'

const usage = (inputTokens, outputTokens, cacheReadTokens = 0) => ({ inputTokens, outputTokens, cacheReadTokens })
const events = [
  { type: 'assistant/message', data: { usage: usage(1000, 50) } },
  { type: 'assistant/message', data: { usage: usage(200, 40, 3000) } },
  { type: 'compaction/start', data: {} },
  { type: 'compaction/summary', data: { usage: usage(900, 30), shadowedTokenCount: 2500, rawOutput: [{ type: 'text', text: '{"carryon_state":{"v":1}}' }] } },
  { type: 'compaction/end', data: {} },
  { type: 'compaction/start', data: {} },
  { type: 'compaction/end', data: { error: 'dsh-carryon: fold rejected: no compile request [runtime usage {"inputTokens":700,"outputTokens":20}]' } },
  { type: 'compaction/start', data: {} },
  { type: 'compaction/summary', data: { usage: usage(400, 10), shadowedTokenCount: 100, rawOutput: [{ type: 'text', text: '## Summary' }] } },
  { type: 'compaction/end', data: {} },
  { type: 'turn/end', data: { reason: { kind: 'completed' } } },
]

test('sessionMetrics separates agent and compaction tokens and counts compactions', () => {
  const m = sessionMetrics(events)
  assert.equal(m.steps, 2)
  assert.equal(m.peakContext, 3200)
  assert.deepEqual(m.agent, { calls: 2, input: 1200, cacheRead: 3000, cacheWrite: 0, output: 90 })
  assert.deepEqual(m.compaction, { calls: 3, input: 2000, cacheRead: 0, cacheWrite: 0, output: 60 })
  assert.deepEqual(m.total, { input: 3200, cacheRead: 3000, cacheWrite: 0, output: 150 })
  assert.deepEqual(m.compactions, { started: 3, failed: 1, carryonFolds: 1, otherSummaries: 1, shadowedTokens: 2600 })
  assert.deepEqual(m.turnEnds, { completed: 1 })
  assert.equal(promptTokens(m.agent), 4200)
})

test('the usage the engine appends to a rejected fold is what metrics.mjs reads back', async () => {
  const { formatRuntimeUsage } = await import('../src/engine.ts')
  const usage = { inputTokens: 12, outputTokens: 3, cacheReadTokens: 40 }
  const error = `dsh-carryon: fold rejected: no compile request ${formatRuntimeUsage(usage)}`
  const m = sessionMetrics([{ type: 'compaction/end', data: { error } }])
  assert.deepEqual(m.compaction, { calls: 1, input: 12, cacheRead: 40, cacheWrite: 0, output: 3 })
})
