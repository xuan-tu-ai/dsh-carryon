// Behaviour of the TS port that the parity fixtures do not cover: dsh message blocks, Python string helpers,
// schema defaults and the registry's in-memory guarantees.
import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { posixNormpath, pyLen, pySplit, pyStrip } from '../src/pystr.ts'
import { Candidate, CarrierEdit, CarrierRecord, CompilerOutput, EvidencePackage } from '../src/records.ts'
import { CandidateRegistry, CarrierStore, CarrierStoreError } from '../src/registry.ts'
import { estimateTokens, messageText, projectTail } from '../src/view.ts'

test('messageText reads dsh content blocks', () => {
  const assistant = {
    role: 'assistant',
    content: [
      { type: 'reasoning', text: 'hidden chain of thought' },
      { type: 'text', text: 'Running the tests.' },
      { type: 'tool-call', id: 'call_1', name: 'bash', arguments: '{"command":"pytest -q"}' },
    ],
  }
  assert.equal(messageText(assistant), 'Running the tests.  bash({"command":"pytest -q"})')
  const toolResult = { role: 'tool', content: [{ type: 'text', text: '3 passed' }] }
  assert.equal(projectTail([assistant, toolResult], 5), [
    '[step 5] assistant: Running the tests.  bash({"command":"pytest -q"})',
    '[step 6] tool: 3 passed',
  ].join('\n\n'))
})

test('Python whitespace: strip and split follow str.isspace()', () => {
  assert.equal(pyStrip('\x1c\x85 a b　'), 'a b')
  assert.equal(pyStrip('﻿a'), '﻿a') // not whitespace in Python
  assert.deepEqual(pySplit('  a\x1fb\t\nc  '), ['a', 'b', 'c'])
  assert.deepEqual(pySplit(' \n '), [])
})

test('lengths are counted in code points', () => {
  assert.equal(pyLen('🙂🙂'), 2)
  assert.equal(estimateTokens([{ role: 'user', content: '🙂🙂🙂🙂' }]), 1)
})

test('posixNormpath matches posixpath.normpath', () => {
  const cases: [string, string][] = [
    ['', '.'], ['.', '.'], ['/', '/'], ['//', '//'], ['///', '/'], ['a/../..', '..'], ['/a/../..', '/'], ['a//b/./c/', 'a/b/c'],
  ]
  for (const [input, expected] of cases) assert.equal(posixNormpath(input), expected, input)
})

test('schemas apply pydantic defaults and drop unknown keys', () => {
  const edit = CarrierEdit.parse({ candidate_id: 'C1', carrier_type: 'external_object', subject: 'a', summary: 's', extra: 1 })
  assert.deepEqual(edit, {
    candidate_id: 'C1', carrier_id: null, base_version: null, carrier_type: 'external_object',
    subject: 'a', summary: 's', conditions: [], claims: [],
  })
  const out = CompilerOutput.parse({ execution_context: {} })
  assert.deepEqual(out.execution_context.obligations, [])
  assert.equal(out.abstain_reason, null)
  assert.throws(() => EvidencePackage.parse({ candidates: [], evidence: { three: 'x' } }))
  assert.throws(() => CarrierRecord.parse({ carrier_id: 'x', carrier_type: 'nope', subject: 's', summary: 's', committed_at_fold: 1 }))
})

test('materialize copies edit data and leaves the store unchanged', () => {
  const store = new CarrierStore()
  const edit = CarrierEdit.parse({ candidate_id: 'C1', carrier_type: 'information_product', subject: 'x', summary: 's', conditions: ['c'] })
  const [record] = store.materialize([edit], 1)
  assert.equal(store.current().length, 0)
  edit.conditions.push('later')
  assert.deepEqual(record!.conditions, ['c'])
})

test('apply is atomic and keeps every version', () => {
  const store = new CarrierStore()
  const v1 = CarrierRecord.parse({ carrier_id: 'a', carrier_type: 'situated_state', subject: 'a', summary: '1', committed_at_fold: 1 })
  const v2 = { ...v1, version: 2, predecessor_version: 1, summary: '2', committed_at_fold: 2 }
  const other = { ...v1, carrier_id: 'b', subject: 'b' }
  store.apply([v1])
  assert.throws(() => store.apply([other, v1]), CarrierStoreError)
  assert.deepEqual(store.current(), [v1])
  store.apply([v2, other])
  assert.deepEqual(store.history('a'), [v1, v2])
  assert.deepEqual(store.current().map((r) => r.carrier_id), ['a', 'b'])
  assert.deepEqual(store.history('missing'), [])
})

test('CandidateRegistry upserts in place and removes', () => {
  const reg = new CandidateRegistry()
  const c = (id: string, description: string) => Candidate.parse({
    candidate_id: id, provisional_type: 'external_object', subject: 'a.py', description, first_seen_step: 1, last_revised_step: 1,
  })
  reg.upsert(c('C1', 'first'))
  reg.upsert(c('C2', 'second'))
  reg.upsert(c('C1', 'revised'))
  assert.deepEqual(reg.all().map((x) => [x.candidate_id, x.description]), [['C1', 'revised'], ['C2', 'second']])
  reg.remove('C1')
  reg.remove('missing')
  assert.equal(reg.get('C1'), undefined)
  assert.equal(reg.all().length, 1)
})
