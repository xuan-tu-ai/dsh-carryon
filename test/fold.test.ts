// One CarryOn fold with scripted Tracker/Compiler replies: commit, rejection without side effects, scan memory,
// backoff and config splitting. No network.
import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { cooldown, splitConfig } from '../src/engine.ts'
import { interactionMessages, runFold, UNKNOWN_TASK, type FoldArgs } from '../src/fold.ts'
import { RoleLLM, type RoleCall } from '../src/llm.ts'
import { Compiler, Tracker } from '../src/roles.ts'
import { INITIAL_STATE, type CarryOnState } from '../src/state.ts'
import type { ViewMessage } from '../src/view.ts'

/** A role whose replies are scripted; records each user message it was sent. */
function role(replies: Array<string | object | Error>) {
  const users: string[] = []
  const call: RoleCall = async (_system, turns) => {
    users.push(turns[0]!.text)
    const next = replies.shift()
    if (next === undefined) throw new Error('no reply left')
    if (next instanceof Error) throw next
    return { text: typeof next === 'string' ? next : JSON.stringify(next), usage: { inputTokens: 10, outputTokens: 2 } }
  }
  return { llm: new RoleLLM(call), users }
}

const user = (text: string): ViewMessage => ({ role: 'user', content: [{ type: 'text', text }] })
const assistant = (text: string): ViewMessage => ({ role: 'assistant', content: [{ type: 'text', text }] })
const tool = (text: string): ViewMessage => ({ role: 'tool', content: [{ type: 'text', text }] })

const tail = [user('Fix the parser bug'), assistant('reading parser.py'), tool('def parse(): ...'), assistant('patched'), tool('3 passed')]

const candidate = {
  candidate_id: 'C1',
  provisional_type: 'external_object',
  subject: 'src/parser.py',
  description: 'patched the loop',
  supporting_steps: [3, 4],
  first_seen_step: 3,
  last_revised_step: 4,
}
const scanReply = { candidate_updates: [candidate, { ...candidate, candidate_id: 'C2', subject: 'later' }], compile_requests: [{ candidate_id: 'C1', evidence_steps: [4, 2] }] }
const compileReply = {
  carrier_edits: [{ candidate_id: 'C1', carrier_type: 'external_object', subject: 'src/parser.py', summary: 'loop bound fixed; tests pass', claims: [{ claim_id: 'k1', proposition: 'tests pass', source_steps: [4] }] }],
  execution_context: { current_focus: ['open a PR'], obligations: [{ obligation_id: 'o1', text: 'write the changelog' }] },
}

function deepFreeze<T>(x: T): T {
  if (typeof x === 'object' && x !== null) {
    for (const v of Object.values(x)) deepFreeze(v)
    Object.freeze(x)
  }
  return x
}

function args(state: CarryOnState, replies: { tracker: Array<string | object | Error>; compiler: Array<string | object | Error> }, extra: Partial<FoldArgs> = {}) {
  const t = role(replies.tracker)
  const c = role(replies.compiler)
  return { t, c, args: { state: deepFreeze(structuredClone(state)), tail, memory: undefined, tracker: new Tracker(t.llm, 4, 'TRACKER'), compiler: new Compiler(c.llm, 'COMPILER'), ...extra } }
}

test('interactionMessages drops the system head and our checkpoint, keeps a dsh summary', () => {
  const framed = (inner: string): ViewMessage => ({
    role: 'user',
    content: [{ type: 'text', text: 'This is an automatically generated checkpoint...\n\n<compacted-summary>' }, { type: 'text', text: inner }, { type: 'text', text: '</compacted-summary>' }],
  })
  const ours = framed('<carryon_checkpoint>\n## Continuation carriers\n</carryon_checkpoint>')
  const fallback = framed('<carryon_checkpoint>x</carryon_checkpoint>\n## Primary Request\nfix it')
  const out = interactionMessages([{ role: 'system', content: 'sys' }, ours, fallback, ...tail])
  assert.equal(out.length, 1 + tail.length)
  assert.deepEqual(out[0], { role: 'user', content: '## Primary Request\nfix it' })
  assert.deepEqual(out.slice(1), tail)
})

test('a successful first fold commits carriers, context, task and step numbers', async () => {
  const { t, c, args: a } = args(INITIAL_STATE, { tracker: [scanReply], compiler: [compileReply] })
  const outcome = await runFold(a)
  assert.ok(outcome.ok)
  assert.equal(outcome.state.folds, 1)
  assert.equal(outcome.state.task, 'Fix the parser bug')
  assert.equal(outcome.state.next_step, tail.length)
  assert.deepEqual(outcome.state.carriers.map((r) => [r.carrier_id, r.version, r.committed_at_fold]), [['external_object:src/parser.py', 1, 1]])
  assert.deepEqual(outcome.state.candidates.map((x) => x.candidate_id), ['C2'], 'compiled candidates leave the registry')
  assert.deepEqual(outcome.state.ec.current_focus, ['open a PR'])
  assert.deepEqual(outcome.carrierIds, ['external_object:src/parser.py'])
  assert.match(outcome.checkpoint, /- \[external_object\] src\/parser\.py \(v1\): loop bound fixed; tests pass/)
  assert.match(outcome.checkpoint, /- open obligation \[o1\]: write the changelog/)
  assert.match(t.users[0]!, /^# Task\nFix the parser bug\n/)
  assert.match(t.users[0]!, /\[step 0\] user: Fix the parser bug/)
  assert.match(c.users[0]!, /# Evidence\n## step 2\ndef parse\(\): \.\.\.\n\n## step 4\n3 passed/)
})

test('a later fold numbers steps after the previous ones and versions the carrier', async () => {
  const first = await runFold(args(INITIAL_STATE, { tracker: [scanReply], compiler: [compileReply] }).args)
  assert.ok(first.ok)
  const update = { ...candidate, candidate_id: 'C3', target_carrier_id: 'external_object:src/parser.py', first_seen_step: 6 }
  const { t, c, args: a } = args(first.state, {
    tracker: [{ candidate_updates: [update], compile_requests: [{ candidate_id: 'C3', evidence_steps: [6] }] }],
    compiler: [{ carrier_edits: [{ candidate_id: 'C3', carrier_id: 'external_object:src/parser.py', base_version: 1, carrier_type: 'external_object', subject: 'src/parser.py', summary: 'also handles tabs' }], execution_context: {} }],
  })
  const second = await runFold(a)
  assert.ok(second.ok, second.ok ? '' : second.reason)
  assert.equal(second.state.task, 'Fix the parser bug', 'the task is kept from the first fold')
  assert.equal(second.state.next_step, 2 * tail.length)
  assert.deepEqual(second.state.carriers.map((r) => [r.version, r.predecessor_version, r.committed_at_fold]), [[2, 1, 2]])
  assert.match(t.users[0]!, /\[step 5\] user: Fix the parser bug/)
  assert.match(c.users[0]!, /# Prior carrier records\n\[\n  \{\n    "carrier_id": "external_object:src\/parser.py",\n    "version": 1,/)
})

test('no compile request rejects the fold and keeps the new candidates in memory', async () => {
  const { args: a } = args(INITIAL_STATE, { tracker: [{ candidate_updates: [candidate] }], compiler: [] })
  const outcome = await runFold(a)
  assert.ok(!outcome.ok)
  assert.equal(outcome.reason, 'no compile request')
  assert.equal(outcome.memory.nextStep, 0)
  assert.equal(outcome.memory.scannedThrough, tail.length)
  assert.deepEqual(outcome.memory.candidates.map((x) => x.candidate_id), ['C1'])
  assert.deepEqual(a.state, INITIAL_STATE)
})

test('a validator rejection reports carrycode problem strings and changes nothing', async () => {
  const bad = { ...compileReply, carrier_edits: [{ ...compileReply.carrier_edits[0]!, claims: [{ claim_id: 'k1', proposition: 'p', source_steps: [1] }] }] }
  const { args: a } = args(INITIAL_STATE, { tracker: [scanReply], compiler: [bad] })
  const outcome = await runFold(a)
  assert.ok(!outcome.ok)
  assert.equal(outcome.reason, 'external_object:src/parser.py/k1: cites unauthorized steps [1]')
  assert.deepEqual(a.state, INITIAL_STATE, 'the committed state is frozen and unchanged')
})

test('after a rejection the Tracker only scans new messages, with the remembered candidates', async () => {
  const firstTry = await runFold(args(INITIAL_STATE, { tracker: [{ candidate_updates: [candidate] }], compiler: [] }).args)
  assert.ok(!firstTry.ok)
  const longer = [...tail, assistant('opened PR'), tool('PR #1')]
  const { t, args: a } = args(INITIAL_STATE, { tracker: [{ compile_requests: [{ candidate_id: 'C1', evidence_steps: [4] }] }], compiler: [compileReply] }, { tail: longer, memory: firstTry.memory })
  const outcome = await runFold(a)
  assert.ok(outcome.ok, outcome.ok ? '' : outcome.reason)
  assert.match(t.users[0]!, /# Live tail\n\[step 5\] assistant: opened PR\n\n\[step 6\] tool: PR #1$/)
  assert.match(t.users[0]!, /"candidate_id": "C1"/)
  assert.equal(outcome.state.next_step, longer.length)
})

test('scan memory from another fold boundary is ignored', async () => {
  const { t, args: a } = args(INITIAL_STATE, { tracker: [{}], compiler: [] }, { memory: { nextStep: 99, candidates: [], scannedThrough: 3 } })
  await runFold(a)
  assert.match(t.users[0]!, /\[step 0\] user: Fix the parser bug/)
})

test('a model transport error rejects the fold; an abort propagates', async () => {
  const failed = await runFold(args(INITIAL_STATE, { tracker: [new Error('503 upstream')], compiler: [] }).args)
  assert.ok(!failed.ok)
  assert.equal(failed.reason, 'Error: 503 upstream')
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(runFold({ ...args(INITIAL_STATE, { tracker: [scanReply], compiler: [] }).args, signal: controller.signal }))
})

test('an invalid Compiler reply abstains; the fold is rejected after one retry', async () => {
  const { c, args: a } = args(INITIAL_STATE, { tracker: [scanReply], compiler: ['nope', '{"carrier_edits": []}'] })
  const outcome = await runFold(a)
  assert.ok(!outcome.ok)
  assert.equal(outcome.reason, 'compiler abstained: invalid_output; a fold must change at least one carrier')
  assert.equal(c.llm.usage.calls, 2)
})

test('the task falls back to a placeholder when the region has no user message', async () => {
  const { t, args: a } = args(INITIAL_STATE, { tracker: [{}], compiler: [] }, { tail: [assistant('x')] })
  await runFold(a)
  assert.ok(t.users[0]!.startsWith(`# Task\n${UNKNOWN_TASK}\n`))
})

test('cooldown doubles the rescan threshold per failure, up to the cap', () => {
  const config = { rescanTokens: 100, maxBackoffDoublings: 2 }
  assert.equal(cooldown({ failures: 0, tokensAtLastScan: 0 }, 0, config), null)
  assert.match(cooldown({ failures: 1, tokensAtLastScan: 50 }, 249, config)!, /199 of 200 new tokens/)
  assert.equal(cooldown({ failures: 1, tokensAtLastScan: 50 }, 250, config), null)
  assert.match(cooldown({ failures: 5, tokensAtLastScan: 0 }, 399, config)!, /399 of 400/)
  assert.equal(cooldown({ failures: 5, tokensAtLastScan: 0 }, 400, config), null)
})

test('splitConfig separates CarryOn keys and defaults compactionRetries to 0', () => {
  const { carryon, basic } = splitConfig({ thresholdRatio: 0.5, rescanTokens: 100, runtimeProvider: 'p', runtimeModel: 'm' })
  assert.deepEqual(basic, { thresholdRatio: 0.5, compactionRetries: 0 })
  assert.equal(carryon.rescanTokens, 100)
  assert.equal(carryon.fallbackRatio, 0.95)
  assert.equal(carryon.runtimeModel, 'm')
  assert.throws(() => splitConfig({ runtimeProvider: 'p' }), /set together/)
  assert.throws(() => splitConfig({ fallbackRatio: 0 }), /fallbackRatio/)
})
