// Parity with carrycode: every case exported by carrycode's scripts/export_parity_fixtures.py must give the same
// output here (design doc §6). The fixtures are vendored by scripts/sync-parity-fixtures.mjs.
import { strict as assert } from 'node:assert'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { z } from 'zod'
import { CarrierEdit, CarrierRecord, CarrierType, CompilerOutput, EvidencePackage, ExecutionContext } from '../src/records.ts'
import { CarrierStore, CarrierStoreError, makeCarrierId } from '../src/registry.ts'
import { validate } from '../src/validator.ts'
import { estimateTokens, messageText, projectTail, renderCheckpoint, stepTexts, type ViewMessage } from '../src/view.ts'

const DIR = join(import.meta.dirname, 'fixtures', 'parity')
const FORMAT = 1

interface Case {
  op: string
  name: string
  input: Record<string, unknown>
  expected: unknown
}

function load(module: string): Case[] {
  const data = JSON.parse(readFileSync(join(DIR, `${module}.json`), 'utf8')) as { format: number; module: string; cases: Case[] }
  assert.equal(data.format, FORMAT, `${module}.json: unknown fixture format`)
  assert.equal(data.module, module)
  return data.cases
}

/** A store holding `records`, committed one by one in list order (as the exporter builds it). */
function storeFrom(records: unknown): CarrierStore {
  const store = new CarrierStore()
  for (const r of z.array(CarrierRecord).parse(records)) store.apply([r])
  return store
}

const messages = (x: unknown) => x as ViewMessage[]

const ops: Record<string, (input: Record<string, unknown>) => unknown> = {
  make_carrier_id: (i) => makeCarrierId(CarrierType.parse(i.carrier_type), i.subject as string),
  materialize: (i) =>
    storeFrom(i.store).materialize(z.array(CarrierEdit).parse(i.edits), i.fold_number as number),
  apply: (i) => {
    const store = storeFrom(i.store)
    const records = z.array(CarrierRecord).parse(i.records)
    const out: Record<string, unknown> = {}
    try {
      store.apply(records)
    } catch (e) {
      assert.ok(e instanceof CarrierStoreError)
      out.error = e.message
    }
    out.current = store.current()
    out.histories = Object.fromEntries([...new Set(records.map((r) => r.carrier_id))].sort().map((id) => [id, store.history(id)]))
    return out
  },
  validate: (i) =>
    validate(CompilerOutput.parse(i.output), EvidencePackage.parse(i.package), storeFrom(i.store)),
  message_text: (i) => messageText(i.message as ViewMessage),
  estimate_tokens: (i) => estimateTokens(messages(i.messages)),
  project_tail: (i) => projectTail(messages(i.messages), i.offset as number, i.max_chars as number),
  step_texts: (i) => [...stepTexts(messages(i.messages), i.offset as number, i.steps as number[])],
  render_checkpoint: (i) =>
    renderCheckpoint(z.array(CarrierRecord).parse(i.carriers), ExecutionContext.parse(i.ec)),
}

for (const module of ['registry', 'validator', 'view']) {
  describe(`parity: ${module}`, () => {
    for (const c of load(module)) {
      test(`${c.op}: ${c.name}`, () => {
        const run = ops[c.op]
        assert.ok(run, `no runner for op ${c.op}`)
        assert.deepStrictEqual(run(c.input), c.expected)
      })
    }
  })
}

test('vendored fixtures match the hashes recorded at sync time', () => {
  const source = JSON.parse(readFileSync(join(DIR, 'source.json'), 'utf8')) as { commit: string; sha256: Record<string, string> }
  assert.match(source.commit, /^[0-9a-f]{40}$/)
  for (const [file, hash] of Object.entries(source.sha256)) {
    const actual = createHash('sha256').update(readFileSync(join(DIR, file), 'utf8')).digest('hex')
    assert.equal(actual, hash, `${file} was edited by hand; re-run scripts/sync-parity-fixtures.mjs`)
  }
})

test('every exported op has a runner', () => {
  const exported = new Set(['registry', 'validator', 'view'].flatMap((m) => load(m).map((c) => c.op)))
  assert.deepEqual([...exported].filter((op) => !(op in ops)), [])
})
