import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { applyCarryOnProjection, carryOnProjectionDefinition } from '../src/projection.ts'
import { decodeState, encodeState, INITIAL_STATE, STATE_KEY } from '../src/state.ts'
import { renderP0Checkpoint } from '../src/engine.ts'

let seq = 0
function event(type: string, data: Record<string, unknown>): SessionEvent {
  seq += 1
  return { type, seq, time: 0, data } as unknown as SessionEvent
}

const summary = (compactionId: string, folds: number) =>
  event('compaction/summary', { compactionId, rawOutput: [encodeState({ v: 0, folds })] })
const end = (compactionId: string, error?: string) =>
  event('compaction/end', error === undefined ? { compactionId, turn: 1 } : { compactionId, turn: 1, error })

function fold(events: SessionEvent[]) {
  const init = carryOnProjectionDefinition.init()
  return events.reduce(applyCarryOnProjection, init)
}

test('state round-trips through a rawOutput text block', () => {
  const block = encodeState({ v: 0, folds: 3 })
  assert.equal(block.type, 'text')
  assert.deepEqual(JSON.parse(block.text), { [STATE_KEY]: { v: 0, folds: 3 } })
  assert.deepEqual(decodeState([block]), { v: 0, folds: 3 })
})

test('decodeState ignores other backends and unknown versions', () => {
  assert.equal(decodeState(undefined), undefined)
  assert.equal(decodeState([{ type: 'text', text: '## Primary Request and Intent' }]), undefined)
  assert.equal(decodeState([{ type: 'text', text: JSON.stringify({ [STATE_KEY]: { v: 99, folds: 1 } }) }]), undefined)
  assert.equal(decodeState([{ type: 'text', text: JSON.stringify({ [STATE_KEY]: { v: 0, folds: -1 } }) }]), undefined)
})

test('a successful fold commits its state only at compaction/end', () => {
  const afterSummary = fold([summary('c1', 1)])
  assert.deepEqual(afterSummary.committed, INITIAL_STATE)
  assert.deepEqual(afterSummary.pending, { compactionId: 'c1', state: { v: 0, folds: 1 } })

  const afterEnd = fold([summary('c1', 1), end('c1')])
  assert.deepEqual(afterEnd, { committed: { v: 0, folds: 1 }, pending: null })
})

test('a failed fold changes nothing', () => {
  const state = fold([summary('c1', 1), end('c1'), summary('c2', 2), end('c2', 'commit failed')])
  assert.deepEqual(state, { committed: { v: 0, folds: 1 }, pending: null })
})

test('an end for another compaction does not commit the pending state', () => {
  const state = fold([summary('c1', 1), end('c0')])
  assert.deepEqual(state.committed, INITIAL_STATE)
  assert.equal(state.pending?.compactionId, 'c1')
})

test('a summary written by another backend clears a stale pending fold', () => {
  const foreign = event('compaction/summary', { compactionId: 'b1', rawOutput: [{ type: 'text', text: 'basic' }] })
  const state = fold([summary('c1', 1), foreign, end('c1')])
  assert.deepEqual(state, { committed: INITIAL_STATE, pending: null })
})

test('unrelated events keep the same state reference', () => {
  const init = carryOnProjectionDefinition.init()
  assert.equal(applyCarryOnProjection(init, event('user/message', {})), init)
})

test('projection state is plain JSON accepted by its schema', () => {
  const state = fold([summary('c1', 1), end('c1'), summary('c2', 2)])
  const parsed = carryOnProjectionDefinition.stateSchema.parse(JSON.parse(JSON.stringify(state)))
  assert.deepEqual(parsed, state)
})

test('the P0 checkpoint names the fold number', () => {
  const text = renderP0Checkpoint({ v: 0, folds: 2 }, 17)
  assert.match(text, /^<carryon_checkpoint>/)
  assert.match(text, /fold 2 replaced 17 earlier messages/)
  assert.match(text, /<\/carryon_checkpoint>$/)
})
