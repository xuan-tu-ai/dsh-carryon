import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { applyCarryOnProjection, carryOnProjectionDefinition } from '../src/projection.ts'
import { decodeState, encodeState, INITIAL_STATE, STATE_KEY, type CarryOnState } from '../src/state.ts'

let seq = 0
function event(type: string, data: Record<string, unknown>): SessionEvent {
  seq += 1
  return { type, seq, time: 0, data } as unknown as SessionEvent
}

/** A v1 state after `folds` folds (only the counter and next step differ). */
const st = (folds: number): CarryOnState => ({ ...INITIAL_STATE, folds, next_step: folds * 10, task: folds > 0 ? 'task' : null })
const summary = (compactionId: string, folds: number) =>
  event('compaction/summary', { compactionId, rawOutput: [encodeState(st(folds))] })
const end = (compactionId: string, error?: string) =>
  event('compaction/end', error === undefined ? { compactionId, turn: 1 } : { compactionId, turn: 1, error })

function fold(events: SessionEvent[]) {
  const init = carryOnProjectionDefinition.init()
  return events.reduce(applyCarryOnProjection, init)
}

test('state round-trips through a rawOutput text block', () => {
  const block = encodeState(st(3))
  assert.equal(block.type, 'text')
  assert.deepEqual(JSON.parse(block.text), { [STATE_KEY]: st(3) })
  assert.deepEqual(decodeState([block]), st(3))
})

test('decodeState ignores other backends and unknown versions', () => {
  assert.equal(decodeState(undefined), undefined)
  assert.equal(decodeState([{ type: 'text', text: '## Primary Request and Intent' }]), undefined)
  assert.equal(decodeState([{ type: 'text', text: JSON.stringify({ [STATE_KEY]: { v: 99, folds: 1 } }) }]), undefined)
  assert.equal(decodeState([{ type: 'text', text: JSON.stringify({ [STATE_KEY]: { v: 0, folds: -1 } }) }]), undefined)
  assert.equal(decodeState([{ type: 'text', text: JSON.stringify({ [STATE_KEY]: { ...st(1), carriers: 'x' } }) }]), undefined)
})

test('a P0 (version 0) state is upgraded to an empty version 1 state', () => {
  const v0 = { type: 'text', text: JSON.stringify({ [STATE_KEY]: { v: 0, folds: 4 } }) }
  assert.deepEqual(decodeState([v0]), { ...INITIAL_STATE, folds: 4 })
})

test('a successful fold commits its state only at compaction/end', () => {
  const afterSummary = fold([summary('c1', 1)])
  assert.deepEqual(afterSummary.committed, INITIAL_STATE)
  assert.deepEqual(afterSummary.pending, { compactionId: 'c1', state: st(1) })

  const afterEnd = fold([summary('c1', 1), end('c1')])
  assert.deepEqual(afterEnd, { committed: st(1), pending: null })
})

test('a failed fold changes nothing', () => {
  const state = fold([summary('c1', 1), end('c1'), summary('c2', 2), end('c2', 'commit failed')])
  assert.deepEqual(state, { committed: st(1), pending: null })
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
