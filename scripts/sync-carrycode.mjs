#!/usr/bin/env node
// Vendor files from carrycode at one commit (design doc §6): the parity fixtures its
// scripts/export_parity_fixtures.py writes, and the runtime roles' system prompts. The commit and each file's
// sha256 go into carrycode.lock.json; the tests check the hashes, so a hand edit of a vendored file fails them.
//
// Usage: node scripts/sync-carrycode.mjs <carrycode-dir> [--ref <commit>]   copy (default ref: HEAD)
//        node scripts/sync-carrycode.mjs <carrycode-dir> --check            exit 1 if the pinned commit's files
//                                                                          differ from the vendored ones
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const LOCK = join(ROOT, 'carrycode.lock.json')
/** Local path → path in carrycode. */
const FILES = {
  'test/fixtures/parity/registry.json': 'tests/fixtures/parity/registry.json',
  'test/fixtures/parity/validator.json': 'tests/fixtures/parity/validator.json',
  'test/fixtures/parity/view.json': 'tests/fixtures/parity/view.json',
  'test/fixtures/parity/roles.json': 'tests/fixtures/parity/roles.json',
  'prompts/tracker.md': 'src/carrycode/prompts/tracker.md',
  'prompts/compiler.md': 'src/carrycode/prompts/compiler.md',
}

const args = process.argv.slice(2)
const refIndex = args.indexOf('--ref')
const carrycode = args.find((a, i) => !a.startsWith('--') && (refIndex < 0 || i !== refIndex + 1))
if (!carrycode) {
  console.error('usage: node scripts/sync-carrycode.mjs <carrycode-dir> [--ref <commit> | --check]')
  process.exit(2)
}
const git = (...a) => execFileSync('git', ['-C', carrycode, ...a], { encoding: 'utf8', maxBuffer: 64 << 20 })
const sha256 = (text) => createHash('sha256').update(text).digest('hex')

if (args.includes('--check')) {
  const lock = JSON.parse(readFileSync(LOCK, 'utf8'))
  const stale = Object.entries(FILES)
    .filter(([local, upstream]) => git('show', `${lock.commit}:${upstream}`) !== readFileSync(join(ROOT, local), 'utf8'))
    .map(([local]) => local)
  if (stale.length > 0) {
    console.error(`differs from carrycode ${lock.commit}: ${stale.join(', ')}`)
    process.exit(1)
  }
  console.log(`vendored files match carrycode ${lock.commit}`)
} else {
  const commit = git('rev-parse', refIndex >= 0 ? `${args[refIndex + 1]}^{commit}` : 'HEAD').trim()
  const files = {}
  for (const [local, upstream] of Object.entries(FILES)) {
    const text = git('show', `${commit}:${upstream}`)
    mkdirSync(dirname(join(ROOT, local)), { recursive: true })
    writeFileSync(join(ROOT, local), text)
    files[local] = { upstream, sha256: sha256(text) }
  }
  const lock = { repository: 'https://github.com/xuan-tu-ai/carrycode', commit, files }
  writeFileSync(LOCK, `${JSON.stringify(lock, null, 2)}\n`)
  console.log(`vendored ${Object.keys(files).length} files from carrycode ${commit}`)
}
