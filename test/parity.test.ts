// Parity with carrycode: every case exported by carrycode's scripts/export_parity_fixtures.py must give the same
// output here (design doc §6). The fixtures are vendored by scripts/sync-carrycode.mjs.
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
import { RoleLLM, stripCodeFence, type RoleCall } from '../src/llm.ts'
import { buildCompilerUserMessage, buildTrackerUserMessage, Compiler, Tracker } from '../src/roles.ts'
import { Candidate } from '../src/records.ts'

const ROOT = join(import.meta.dirname, '..')
const DIR = join(ROOT, 'test', 'fixtures', 'parity')
const MODULES = ['registry', 'validator', 'view', 'roles']
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

/** A role LLM that answers with the case's scripted replies, in order. */
function scripted(replies: unknown): RoleLLM {
  const queue = [...(replies as string[])]
  const call: RoleCall = async () => {
    const text = queue.shift()
    if (text === undefined) throw new Error('scripted: no replies left')
    return { text }
  }
  return new RoleLLM(call)
}

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
  strip_code_fence: (i) => stripCodeFence(i.text as string),
  tracker_user_message: (i) =>
    buildTrackerUserMessage(
      i.task as string,
      i.live_tail_text as string,
      z.array(Candidate).parse(i.candidates),
      z.array(CarrierRecord).parse(i.carriers),
      ExecutionContext.parse(i.ec),
      i.max_requests as number,
    ),
  compiler_user_message: (i) =>
    buildCompilerUserMessage(EvidencePackage.parse(i.package), ExecutionContext.parse(i.ec), i.live_tail_text as string),
  tracker_scan: async (i) => {
    const llm = scripted(i.replies)
    const output = await new Tracker(llm, i.max_requests as number).scan(
      i.task as string,
      i.live_tail_text as string,
      z.array(Candidate).parse(i.candidates),
      z.array(CarrierRecord).parse(i.carriers),
      ExecutionContext.parse(i.ec),
    )
    return { output, calls: llm.usage.calls }
  },
  compiler_compile: async (i) => {
    const llm = scripted(i.replies)
    const output = await new Compiler(llm).compile(
      EvidencePackage.parse(i.package),
      ExecutionContext.parse(i.ec),
      i.live_tail_text as string,
    )
    return { output, calls: llm.usage.calls }
  },
}

for (const module of MODULES) {
  describe(`parity: ${module}`, () => {
    for (const c of load(module)) {
      test(`${c.op}: ${c.name}`, async () => {
        const run = ops[c.op]
        assert.ok(run, `no runner for op ${c.op}`)
        assert.deepStrictEqual(await run(c.input), c.expected)
      })
    }
  })
}

test('vendored carrycode files match the hashes in carrycode.lock.json', () => {
  const lock = JSON.parse(readFileSync(join(ROOT, 'carrycode.lock.json'), 'utf8')) as {
    commit: string
    files: Record<string, { upstream: string; sha256: string }>
  }
  assert.match(lock.commit, /^[0-9a-f]{40}$/)
  assert.ok(Object.keys(lock.files).length >= MODULES.length + 2)
  for (const [file, { sha256 }] of Object.entries(lock.files)) {
    const actual = createHash('sha256').update(readFileSync(join(ROOT, file), 'utf8')).digest('hex')
    assert.equal(actual, sha256, `${file} was edited by hand; re-run scripts/sync-carrycode.mjs`)
  }
})

test('every exported op has a runner', () => {
  const exported = new Set(MODULES.flatMap((m) => load(m).map((c) => c.op)))
  assert.deepEqual([...exported].filter((op) => !(op in ops)), [])
})
