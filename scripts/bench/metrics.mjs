// Token and compaction metrics of one dsh session log, for the P3 benchmark (design doc §8: "compare token use
// against compaction-basic on the same tasks").
//
// Usage: node scripts/bench/metrics.mjs <session.vN.jsonl.zstd>   prints the metrics as JSON
import { readSessionEvents } from '../session-log.mjs'

const RUNTIME_USAGE = /\[runtime usage (\{[^\]]*\})\]/

const zero = () => ({ calls: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0 })

function add(bucket, usage) {
  if (!usage) return
  bucket.calls += 1
  bucket.input += usage.inputTokens ?? 0
  bucket.cacheRead += usage.cacheReadTokens ?? 0
  bucket.cacheWrite += usage.cacheWriteTokens ?? 0
  bucket.output += usage.outputTokens ?? 0
}

/** Prompt tokens of a bucket: uncached + cache reads + cache writes. */
export const promptTokens = (b) => b.input + b.cacheRead + b.cacheWrite

function hasCarryOnState(rawOutput) {
  return (rawOutput ?? []).some((b) => typeof b?.text === 'string' && b.text.includes('"carryon_state"'))
}

/**
 * Metrics of one session.
 * @param {Array<{type: string, data: any}>} events - session log events in order.
 * @returns {object} agent and compaction usage, steps, peak context, fold counts.
 */
export function sessionMetrics(events) {
  const agent = zero()
  const compaction = zero()
  let peakContext = 0
  let starts = 0
  let failed = 0
  let carryonFolds = 0
  let otherSummaries = 0
  let shadowedTokens = 0
  let committedCarryOn = 0
  let pendingCarryOn = false
  let firstFoldAtStep = null
  const turnEnds = {}
  for (const e of events) {
    const d = e.data ?? {}
    if (e.type === 'assistant/message' && d.usage) {
      add(agent, d.usage)
      peakContext = Math.max(peakContext, (d.usage.inputTokens ?? 0) + (d.usage.cacheReadTokens ?? 0) + (d.usage.cacheWriteTokens ?? 0))
    } else if (e.type === 'compaction/start') {
      starts += 1
    } else if (e.type === 'compaction/summary') {
      add(compaction, d.usage)
      shadowedTokens += d.shadowedTokenCount ?? 0
      pendingCarryOn = hasCarryOnState(d.rawOutput)
      if (pendingCarryOn) carryonFolds += 1
      else otherSummaries += 1
    } else if (e.type === 'compaction/end') {
      if (d.error !== undefined) {
        failed += 1
        const m = RUNTIME_USAGE.exec(String(d.error))
        if (m) add(compaction, JSON.parse(m[1]))
      } else if (pendingCarryOn) {
        // A CarryOn fold counts once dsh's compaction/end reports success (src/projection.ts does the same).
        committedCarryOn += 1
        firstFoldAtStep ??= agent.calls
      }
      pendingCarryOn = false
    } else if (e.type === 'turn/end') {
      const reason = d.reason?.kind ?? 'unknown'
      turnEnds[reason] = (turnEnds[reason] ?? 0) + 1
    }
  }
  const total = {
    input: agent.input + compaction.input,
    cacheRead: agent.cacheRead + compaction.cacheRead,
    cacheWrite: agent.cacheWrite + compaction.cacheWrite,
    output: agent.output + compaction.output,
  }
  return {
    steps: agent.calls,
    peakContext,
    agent,
    compaction,
    total,
    compactions: { started: starts, failed, carryonFolds, committedCarryOn, otherSummaries, shadowedTokens },
    // Agent steps after the first committed CarryOn fold (null without one): did the session go on after a fold?
    stepsAfterFirstFold: firstFoldAtStep === null ? null : agent.calls - firstFoldAtStep,
    turnEnds,
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const file = process.argv[2]
  if (!file) {
    console.error('usage: metrics.mjs <session.vN.jsonl.zstd>')
    process.exit(2)
  }
  console.log(JSON.stringify(sessionMetrics(readSessionEvents(file)), null, 2))
}
