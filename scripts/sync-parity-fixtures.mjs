#!/usr/bin/env node
// Vendor carrycode's parity fixtures into test/fixtures/parity/ (design doc §6, "Parity fixtures").
//
// carrycode's scripts/export_parity_fixtures.py writes the cases; this script copies them from a carrycode
// checkout at one commit and records that commit and each file's sha256 in test/fixtures/parity/source.json.
// test/parity.test.ts checks the hashes, so a hand edit of a vendored file fails the tests.
//
// Usage: node scripts/sync-parity-fixtures.mjs <carrycode-dir> [--ref <commit>]   copy (default ref: HEAD)
//        node scripts/sync-parity-fixtures.mjs <carrycode-dir> --check            exit 1 if the pinned commit's
//                                                                                 files differ from ours
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DIR = join(ROOT, 'test', 'fixtures', 'parity')
const SOURCE = join(DIR, 'source.json')
const FILES = ['registry.json', 'validator.json', 'view.json']
const UPSTREAM_PATH = 'tests/fixtures/parity'

const args = process.argv.slice(2)
const carrycode = args.find((a) => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--ref')
if (!carrycode) {
  console.error('usage: node scripts/sync-parity-fixtures.mjs <carrycode-dir> [--ref <commit> | --check]')
  process.exit(2)
}
const git = (...a) => execFileSync('git', ['-C', carrycode, ...a], { encoding: 'utf8', maxBuffer: 64 << 20 })
const sha256 = (text) => createHash('sha256').update(text).digest('hex')

if (args.includes('--check')) {
  const source = JSON.parse(readFileSync(SOURCE, 'utf8'))
  const stale = FILES.filter((f) => git('show', `${source.commit}:${UPSTREAM_PATH}/${f}`) !== readFileSync(join(DIR, f), 'utf8'))
  if (stale.length > 0) {
    console.error(`differs from carrycode ${source.commit}: ${stale.join(', ')}`)
    process.exit(1)
  }
  console.log(`parity fixtures match carrycode ${source.commit}`)
} else {
  const refIndex = args.indexOf('--ref')
  const commit = git('rev-parse', refIndex >= 0 ? `${args[refIndex + 1]}^{commit}` : 'HEAD').trim()
  mkdirSync(DIR, { recursive: true })
  const hashes = {}
  for (const f of FILES) {
    const text = git('show', `${commit}:${UPSTREAM_PATH}/${f}`)
    writeFileSync(join(DIR, f), text)
    hashes[f] = sha256(text)
  }
  const source = {
    repository: 'https://github.com/xuan-tu-ai/carrycode',
    commit,
    path: UPSTREAM_PATH,
    generator: 'scripts/export_parity_fixtures.py',
    sha256: hashes,
  }
  writeFileSync(SOURCE, `${JSON.stringify(source, null, 2)}\n`)
  console.log(`vendored ${FILES.length} parity fixture files from carrycode ${commit}`)
}
