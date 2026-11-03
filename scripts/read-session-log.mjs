#!/usr/bin/env node
// Print a dsh session log as JSON lines.
// Usage: node scripts/read-session-log.mjs <session.vN.jsonl.zstd> [--types compaction/start,compaction/end]
import { parseArgs } from 'node:util'
import { readSessionEvents } from './session-log.mjs'

const { values, positionals } = parseArgs({ allowPositionals: true, options: { types: { type: 'string' } } })
if (!positionals[0]) {
  console.error('usage: read-session-log.mjs <session.vN.jsonl.zstd> [--types a,b]')
  process.exit(2)
}
const types = values.types ? new Set(values.types.split(',')) : undefined
for (const event of readSessionEvents(positionals[0])) {
  if (!types || types.has(event.type)) console.log(JSON.stringify(event))
}
