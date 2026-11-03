#!/usr/bin/env node
// Keyless stand-in for a Messages-compatible endpoint (the protocol dsh's `llm-deepseek` adapter speaks), so a
// real `dsh` process can run sessions offline. Every POST .../v1/messages streams one plain-text assistant reply;
// `input_tokens` is a rough estimate of the request size so dsh's token meter sees pressure grow.
//
// Usage: node scripts/fake-messages-server.mjs [--port 8787] [--reply-chars 1200] [--log requests.jsonl]
// Then run dsh with DEEPSEEK_BASE_URL=http://127.0.0.1:<port> DEEPSEEK_API_KEY=fake.

import { createServer } from 'node:http'
import { appendFileSync } from 'node:fs'
import { parseArgs } from 'node:util'

const { values } = parseArgs({
  options: {
    port: { type: 'string', default: '8787' },
    'reply-chars': { type: 'string', default: '1200' },
    log: { type: 'string' },
  },
})
const port = Number(values.port)
const replyChars = Number(values['reply-chars'])
let calls = 0

const FILLER =
  'This is a scripted reply from the dsh-carryon fake Messages server. It stands in for a model so the ' +
  'harness can grow a conversation, measure token pressure and compact history without an API key. '

function replyText(n, lastUser) {
  const head = `Fake reply #${n} to: ${lastUser.slice(0, 80).replace(/\s+/g, ' ')}\n\n`
  let body = ''
  while (body.length < replyChars) body += FILLER
  return head + body.slice(0, replyChars)
}

function lastUserText(request) {
  const messages = Array.isArray(request.messages) ? request.messages : []
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m?.role !== 'user') continue
    if (typeof m.content === 'string') return m.content
    if (Array.isArray(m.content)) {
      const text = m.content.filter(b => b?.type === 'text').map(b => b.text).join(' ')
      if (text) return text
    }
  }
  return ''
}

function sse(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
}

const server = createServer((req, res) => {
  let raw = ''
  req.on('data', chunk => (raw += chunk))
  req.on('end', () => {
    if (req.method !== 'POST' || !/\/v1\/messages$/.test(req.url ?? '')) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: `no route ${req.url}` } }))
      return
    }
    let request
    try {
      request = JSON.parse(raw)
    } catch {
      res.writeHead(400).end()
      return
    }
    calls += 1
    const n = calls
    const inputTokens = Math.ceil(raw.length / 4)
    const text = replyText(n, lastUserText(request))
    const outputTokens = Math.ceil(text.length / 4)
    if (values.log) {
      appendFileSync(values.log, JSON.stringify({ n, model: request.model, messages: request.messages?.length, inputTokens }) + '\n')
    }
    if (request.stream === false) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        id: `msg_fake_${n}`, type: 'message', role: 'assistant', model: request.model,
        content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null,
        usage: { input_tokens: inputTokens, output_tokens: outputTokens },
      }))
      return
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
    sse(res, 'message_start', {
      type: 'message_start',
      message: {
        id: `msg_fake_${n}`, type: 'message', role: 'assistant', model: request.model, content: [],
        stop_reason: null, stop_sequence: null, usage: { input_tokens: inputTokens, output_tokens: 0 },
      },
    })
    sse(res, 'content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
    for (let i = 0; i < text.length; i += 400) {
      sse(res, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: text.slice(i, i + 400) } })
    }
    sse(res, 'content_block_stop', { type: 'content_block_stop', index: 0 })
    sse(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: outputTokens } })
    sse(res, 'message_stop', { type: 'message_stop' })
    res.end()
  })
})

server.listen(port, '127.0.0.1', () => {
  console.log(`fake Messages server on http://127.0.0.1:${port}`)
})
