#!/usr/bin/env node
// Keyless stand-in for a Messages-compatible endpoint (the protocol dsh's `llm-deepseek` adapter speaks), so a
// real `dsh` process can run sessions offline. Every POST .../v1/messages streams one assistant reply;
// `input_tokens` is a rough estimate of the request size so dsh's token meter sees pressure grow.
//
// Replies by request kind:
// - dsh-carryon Tracker (system prompt "# Tracker System Prompt"): one candidate for the newest live-tail step and a
//   compile request citing it, so every scan leads to a fold.
// - dsh-carryon Compiler ("# Compiler System Prompt"): one new carrier per selected candidate, citing the evidence.
// - dsh's own compaction summary (last user message is its compaction instruction): a short Markdown checkpoint.
// - agent turns: plain text of --reply-chars characters. With --agent-steps N, the first N steps of each turn also
//   call dsh's `bash` tool with read-only commands (listing, reading files, running the tests), so tool calls and
//   their results go through compaction; step N+1 ends the turn.
//
// Usage: node scripts/fake-messages-server.mjs [--port 8787] [--reply-chars 1200] [--agent-steps 0] [--log file]
// Then run dsh with DEEPSEEK_BASE_URL=http://127.0.0.1:<port> DEEPSEEK_API_KEY=fake.

import { createServer } from 'node:http'
import { appendFileSync } from 'node:fs'
import { parseArgs } from 'node:util'

const { values } = parseArgs({
  options: {
    port: { type: 'string', default: '8787' },
    'reply-chars': { type: 'string', default: '1200' },
    'agent-steps': { type: 'string', default: '0' },
    log: { type: 'string' },
  },
})
const port = Number(values.port)
const replyChars = Number(values['reply-chars'])
const agentSteps = Number(values['agent-steps'])
let calls = 0
let agentStep = 0

/** Read-only commands the fake agent runs, in rotation; they work in every bench/tasks repository. */
const COMMANDS = [
  'ls -la',
  'cat SPEC.md',
  'python3 -m unittest discover -s tests 2>&1 | tail -40',
  'cat *.py */*.py 2>/dev/null | head -300',
  'grep -rn "def " --include=*.py . | head -80',
  'head -400 data/access.log 2>/dev/null || cat README.md',
]

/** The bash tool call for this agent request, or null to end the turn. */
function agentToolCall(request) {
  if (agentSteps <= 0 || !Array.isArray(request.tools) || !request.tools.some(t => t?.name === 'bash')) return null
  const last = request.messages?.at(-1)
  const continuing = last?.role === 'user' && Array.isArray(last.content) && last.content.some(b => b?.type === 'tool_result')
  agentStep = continuing ? agentStep + 1 : 0
  if (agentStep >= agentSteps) return null
  const command = COMMANDS[agentStep % COMMANDS.length]
  return { id: `toolu_fake_${calls}`, name: 'bash', input: { command, description: `Fake agent step ${agentStep + 1}` } }
}

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

function systemText(request) {
  const s = request.system
  if (typeof s === 'string') return s
  return Array.isArray(s) ? s.map(b => b?.text ?? '').join('\n') : ''
}

function section(text, name) {
  const start = text.indexOf(`# ${name}\n`)
  if (start < 0) return ''
  const body = text.slice(start + name.length + 3)
  const end = body.search(/\n\n# [A-Z]/)
  return end < 0 ? body : body.slice(0, end)
}

function trackerReply(user) {
  const steps = [...section(user, 'Live tail').matchAll(/^\[step (\d+)\]/gm)].map(m => Number(m[1]))
  if (steps.length === 0) return {}
  const step = Math.max(...steps)
  const candidate = {
    candidate_id: `C${step}`, provisional_type: 'information_product', subject: `fake finding at step ${step}`,
    description: 'scripted by the fake server', supporting_steps: [step], first_seen_step: step, last_revised_step: step,
  }
  return { candidate_updates: [candidate], compile_requests: [{ candidate_id: candidate.candidate_id, evidence_steps: [step] }] }
}

function compilerReply(user) {
  const candidates = JSON.parse(section(user, 'Selected candidates') || '[]')
  const steps = [...section(user, 'Evidence').matchAll(/^## step (\d+)$/gm)].map(m => Number(m[1]))
  return {
    carrier_edits: candidates.map(c => ({
      candidate_id: c.candidate_id, carrier_type: c.provisional_type, subject: c.subject,
      summary: `fake progress through step ${Math.max(...steps)}`,
      claims: [{ claim_id: 'k1', proposition: 'the fake server saw this step', source_steps: steps }],
    })),
    execution_context: { current_focus: ['continue the fake task'], immediate_continuation: ['next turn'] },
  }
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
    const system = systemText(request)
    const user = lastUserText(request)
    const kind = system.startsWith('# Tracker System Prompt') ? 'tracker'
      : system.startsWith('# Compiler System Prompt') ? 'compiler'
        : user.includes('You are now acting as a compaction engine') ? 'dsh-summary' : 'agent'
    const text = kind === 'tracker' ? JSON.stringify(trackerReply(user))
      : kind === 'compiler' ? JSON.stringify(compilerReply(user))
        : kind === 'dsh-summary' ? '## Primary Request and Intent\n- fake dsh summary\n'
          : replyText(n, user)
    const tool = kind === 'agent' ? agentToolCall(request) : null
    const outputTokens = Math.ceil(text.length / 4)
    if (values.log) {
      appendFileSync(values.log, JSON.stringify({ n, model: request.model, kind, tool: tool?.input.command, messages: request.messages?.length, inputTokens }) + '\n')
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
    if (tool) {
      sse(res, 'content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: tool.id, name: tool.name, input: {} } })
      sse(res, 'content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: JSON.stringify(tool.input) } })
      sse(res, 'content_block_stop', { type: 'content_block_stop', index: 1 })
    }
    sse(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: tool ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: outputTokens } })
    sse(res, 'message_stop', { type: 'message_stop' })
    res.end()
  })
})

server.listen(port, '127.0.0.1', () => {
  console.log(`fake Messages server on http://127.0.0.1:${port}`)
})
