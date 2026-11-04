#!/usr/bin/env node
// P3 dogfood in the dsh Web UI: one long session per mode ("CarryOn mode" vs dsh's "Standard mode") on the same
// benchmark task, driven with Playwright. Each mode gets a fresh copy of the task repository and its own `dsh web`
// server (same DSH_HOME, same overlays). After the turns, the work directory is graded with the hidden tests and
// the session log measured, and one record per mode goes to <out>/results.jsonl, in the format of run.mjs, so
// `node scripts/bench/report.mjs <out>` compares them. Screenshots of each session go to <out>/.
//
// In web profiles compaction lives inside the agent presets and cannot be tuned from an overlay (docs/p0-findings.md),
// so both modes use dsh's preset defaults (threshold 80% of the window, 65,536 headroom tokens). To get folds in a
// session of reasonable length, lower the model's contextWindow in the model overlay (e.g. 200000 for a real model).
//
// Usage: node scripts/bench/web-session.mjs --task ID [--turns N] [--overlay FILE]... [--out DIR] [--fake]
//   --turns N          follow-up turns after the task prompt (default 3), each "Continue. ..." (see FOLLOW_UP)
//   --turn-minutes N   time limit per turn (default 20)
//   --fake             offline: fake Messages server with a tool-calling agent, model window 100k
// Tools are approved automatically (a `workspace-auto` permission preset: workspace sandbox, approval `never`), in a
// throwaway copy of the task repository.
import { execFileSync, spawn } from 'node:child_process'
import { appendFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { parseArgs } from 'node:util'
import { readSessionEvents } from '../session-log.mjs'
import { sessionMetrics } from './metrics.mjs'

const { chromium } = createRequire(import.meta.url)('playwright')
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const DSH_VERSION = '0.2.2-alpha.2'
const FOLLOW_UP = 'Continue. Run the visible tests, re-read SPEC.md for requirements you have not covered yet, and finish the task.'
const MODES = { carryon: 'CarryOn mode', basic: 'Standard mode' }

const { values: opt } = parseArgs({
  options: {
    task: { type: 'string' },
    turns: { type: 'string', default: '3' },
    'turn-minutes': { type: 'string', default: '20' },
    overlay: { type: 'string', multiple: true, default: [] },
    out: { type: 'string', default: join(tmpdir(), `dsh-carryon-web-${new Date().toISOString().replace(/[:.]/g, '-')}`) },
    fake: { type: 'boolean', default: false },
    port: { type: 'string', default: '8796' },
    'web-port': { type: 'string', default: '8797' },
  },
})
if (!opt.task) throw new Error('--task is required')
const taskDir = join(ROOT, 'bench', 'tasks', opt.task)
const task = JSON.parse(readFileSync(join(taskDir, 'task.json'), 'utf8'))
const out = resolve(opt.out)
if (out.startsWith(ROOT)) throw new Error(`--out must be outside ${ROOT}: the agent could read bench/tasks from there`)
mkdirSync(out, { recursive: true })
const dsh = (process.env.DSH_BIN ?? `npx --yes @deepseek-ai/dsh@${DSH_VERSION}`).split(' ')
const env = { ...process.env }
const children = []
process.on('exit', () => children.forEach((c) => { try { process.kill(-c.pid, 'SIGTERM') } catch {} }))

const overlays = opt.overlay.map((p) => resolve(p))
const approval = join(out, 'approval.patch.yml')
// A preset with the workspace sandbox and no approval prompts, made the default (dsh's own presets pair the
// workspace sandbox with "ask"). Patch configs replace the whole row config, so dsh's presets are restated.
writeFileSync(approval, [
  '- id: approval', '  config:', '    policy: never',
  '- id: permission', '  config:', '    defaultPreset: workspace-auto', '    presets:',
  '      read-only: { sandbox: read-only, approval: ask }',
  '      workspace-write: { sandbox: workspace-write, approval: ask }',
  '      workspace-auto: { sandbox: workspace-write, approval: never }',
  '      danger-full-access: { sandbox: danger-full-access, approval: never }', '',
].join('\n'))
overlays.push(approval)
if (opt.fake) {
  env.DEEPSEEK_BASE_URL = `http://127.0.0.1:${opt.port}`
  env.DEEPSEEK_API_KEY = 'fake-key-for-the-offline-server'
  const model = join(out, 'fake-model.patch.yml')
  writeFileSync(model, '- id: llm-deepseek\n  config:\n    models:\n      - id: deepseek-flash\n        contextWindow: 100000\n        maxTokens: 2000\n')
  overlays.push(model)
  children.push(spawn(process.execPath, [join(ROOT, 'scripts', 'fake-messages-server.mjs'), '--port', opt.port,
    '--reply-chars', '6000', '--agent-steps', '12', '--log', join(out, 'fake-requests.jsonl')], { stdio: 'ignore', detached: true }))
}

execFileSync('pnpm', ['-s', 'build'], { cwd: ROOT, stdio: 'inherit' })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function sessionDirs(home) {
  const root = join(home, 'sessions')
  if (!existsSync(root)) return []
  return readdirSync(root).flatMap((b) => readdirSync(join(root, b)).map((id) => join(root, b, id)))
}

function logOf(dir) {
  const f = existsSync(dir) ? readdirSync(dir).find((x) => /^session\.v\d+\.jsonl\.zstd$/.test(x)) : undefined
  return f ? join(dir, f) : null
}

const countTurnEnds = (log) => (log ? readSessionEvents(log).filter((e) => e.type === 'turn/end').length : 0)

async function waitForTurn(log, before, minutes) {
  const deadline = Date.now() + minutes * 60_000
  while (Date.now() < deadline) {
    if (countTurnEnds(log) > before) return true
    await sleep(2000)
  }
  return false
}

async function send(page, text) {
  const box = page.locator('[contenteditable="true"]:visible').first()
  await box.click()
  await page.keyboard.insertText(text)
  await sleep(300)
  await page.keyboard.press('Enter')
}

async function runMode(arm) {
  // Each mode gets its own DSH_HOME. The web UI opens sessions in its default workspace,
  // <documentsDirectory>/deepseek-harness/default-workspace, so the task repository is put exactly there.
  const home = join(out, `home-${arm}`)
  const docs = join(out, `docs-${arm}`)
  const workdir = join(docs, 'deepseek-harness', 'default-workspace')
  const modeEnv = { ...env, DSH_HOME: home }
  mkdirSync(home, { recursive: true })
  execFileSync(dsh[0], [...dsh.slice(1), 'plugin', '--profile', 'web', 'add', `file:${ROOT}`], { env: modeEnv, stdio: 'ignore' })
  const workspace = join(out, `workspace-${arm}.patch.yml`)
  writeFileSync(workspace, `- id: workspace-controller\n  config:\n    documentsDirectory: ${JSON.stringify(docs)}\n`)
  cpSync(join(taskDir, 'repo'), workdir, { recursive: true })
  if (task.setup) execFileSync('bash', ['-c', task.setup.replaceAll('{task}', taskDir)], { cwd: workdir })
  const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 'bench', GIT_AUTHOR_EMAIL: 'bench@localhost', GIT_COMMITTER_NAME: 'bench', GIT_COMMITTER_EMAIL: 'bench@localhost' }
  for (const a of [['init', '-q'], ['add', '-A'], ['commit', '-qm', 'task start']]) execFileSync('git', a, { cwd: workdir, env: gitEnv })

  const server = spawn(dsh[0], [...dsh.slice(1), '--profile', 'web', ...[...overlays, workspace].flatMap((o) => ['--patch', o]),
    '--no-open', '--port', opt['web-port']], { cwd: workdir, env: modeEnv, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
  children.push(server)
  let url = null
  server.stdout.on('data', (c) => { url ??= /https?:\/\/\S+/.exec(String(c))?.[0] ?? null })
  for (let i = 0; i < 120 && !url; i += 1) await sleep(500)
  if (!url) throw new Error('dsh web did not print its URL')

  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } })
  await page.goto(url, { waitUntil: 'networkidle' })
  await page.getByRole('button', { name: 'Continue' }).click({ timeout: 3000 }).catch(() => {})
  await page.keyboard.press('Escape').catch(() => {})
  await page.getByRole('button', { name: /^New session$/i }).first().click()
  await sleep(1500)
  await page.locator('button:visible', { hasText: / mode$/ }).first().click()
  await sleep(500)
  await page.getByRole('menuitem', { name: new RegExp(`^${MODES[arm]}`) }).click()
  await sleep(500)

  const started = Date.now()
  await send(page, task.prompt)
  // The session that received the task prompt (the web UI may create draft sessions on its own).
  const needle = task.prompt.slice(0, 60)
  const hasPrompt = (d) => {
    const log = logOf(d)
    return log !== null && readSessionEvents(log).some((e) => e.type === 'user/message' && JSON.stringify(e.data).includes(needle))
  }
  let dir = null
  for (let i = 0; i < 60 && !dir; i += 1) {
    dir = sessionDirs(home).find(hasPrompt) ?? null
    if (!dir) await sleep(1000)
  }
  if (!dir) {
    await page.screenshot({ path: join(out, `${opt.task}-${arm}-web-error.png`) })
    throw new Error(`no session log appeared (screenshot: ${opt.task}-${arm}-web-error.png)`)
  }
  const log = logOf(dir)
  let timedOut = !(await waitForTurn(log, 0, Number(opt['turn-minutes'])))
  for (let t = 1; t <= Number(opt.turns) && !timedOut; t += 1) {
    await send(page, FOLLOW_UP)
    timedOut = !(await waitForTurn(log, t, Number(opt['turn-minutes'])))
  }
  await sleep(1500)
  await page.screenshot({ path: join(out, `${opt.task}-${arm}-web.png`), fullPage: false })
  await browser.close()
  try { process.kill(-server.pid, 'SIGTERM') } catch {}
  await sleep(1000)

  const header = readSessionEvents(log).find((e) => e.type === 'session')
  const grade = JSON.parse(execFileSync('python3', [join(ROOT, 'bench', 'grade.py'), workdir, join(taskDir, 'hidden')], { encoding: 'utf8' }))
  const events = readSessionEvents(log)
  const metrics = sessionMetrics(events)
  const contaminated = events.some((e) => JSON.stringify(e).includes(join(ROOT, 'bench', 'tasks')))
  const record = { task: opt.task, arm, repeat: 1, surface: 'web', mode: MODES[arm], exitCode: 0, timedOut,
    wallSeconds: Math.round((Date.now() - started) / 1000), sessionId: dir.split('/').at(-1), grade, metrics, contaminated, sessionLog: log, workdir,
    agentPreset: header?.agentPreset ?? null }
  appendFileSync(join(out, 'results.jsonl'), `${JSON.stringify(record)}\n`)
  console.log(`${MODES[arm]}: preset ${record.agentPreset}, ${metrics.steps} steps, ${metrics.compactions.carryonFolds} CarryOn folds, `
    + `${metrics.compactions.otherSummaries} dsh summaries, hidden ${grade.passed}/${grade.tests}${timedOut ? ', timed out' : ''}`)
  return statSync(log).size
}

writeFileSync(join(out, 'run.json'), JSON.stringify({ started: new Date().toISOString(), options: opt, surface: 'web' }, null, 2))
for (const arm of ['carryon', 'basic']) await runMode(arm)
console.log(`report: node scripts/bench/report.mjs ${out}`)
process.exit(0)
