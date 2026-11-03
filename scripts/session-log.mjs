// Read dsh session logs (`session.vN.jsonl.zstd`). Each append batch is its own zstd frame and Node's zstd
// decoder stops after the first frame, so frames are split at the zstd magic number and decoded one by one
// (a slice that fails to decode is joined with the next candidate).
import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/**
 * Decode every zstd frame of a session log.
 * @param {Buffer} buf - file bytes.
 * @returns {string} the concatenated JSONL text.
 */
export function decodeFrames(buf) {
  const starts = []
  for (let i = buf.indexOf(MAGIC); i >= 0; i = buf.indexOf(MAGIC, i + 1)) starts.push(i)
  starts.push(buf.length)
  let text = ''
  let from = starts[0] ?? 0
  for (let k = 1; k < starts.length; k++) {
    try {
      text += zstdDecompressSync(buf.subarray(from, starts[k])).toString('utf8')
      from = starts[k]
    } catch {
      // The magic number occurred inside compressed data; extend the slice to the next candidate.
    }
  }
  if (from < buf.length) throw new Error(`could not decode bytes ${from}..${buf.length}`)
  return text
}

/**
 * Read all events of a session log file.
 * @param {string} file - path to `session.vN.jsonl.zstd`.
 * @returns {Array<{type: string, seq: number, data: any, surfaceOp?: any}>} events in log order.
 */
export function readSessionEvents(file) {
  return decodeFrames(readFileSync(file))
    .split('\n')
    .filter(line => line.trim())
    .map(line => JSON.parse(line))
}
