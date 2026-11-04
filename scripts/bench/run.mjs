#!/usr/bin/env node
// P3 benchmark runner: the same tasks, two compaction backends, everything else equal (design doc §8, P3).
//
// Arms:
//   carryon  dsh headless with dsh-carryon installed (its own DSH_HOME), CarryOn folds
//   basic    dsh headless without the plugin (its own DSH_HOME), dsh's compaction-basic
// Both arms get the same model overlay(s) and the same trigger thresholds (thresholdRatio, retainTokens).
// For each repeat, task and arm: copy the task's repository into a fresh work directory, run the task's prompt as
// one headless turn (tools auto-approved inside the workspace sandbox), grade it with the hidden tests
// (bench/grade.py), read token and compaction metrics from the session log (metrics.mjs), and append one record
// to <out>/results.jsonl. Then: node scripts/bench/report.mjs <out>.
//
// Usage: node scripts/bench/run.mjs [options]
//   --tasks a,b|all          tasks under bench/tasks (default all)
//   --arms carryon,basic     arms to run (default both)
//   --repeats N              runs per task and arm (default 1)
//   --out DIR                output directory (default: a new directory under the system temp dir). Keep it
//                            outside this repository: bench/tasks holds the hidden tests and reference solutions
//   --overlay FILE           extra dsh patch for both arms, e.g. the model (repeatable)
//   --threshold-ratio R      compaction threshold, share of the context window (default 0.05)
//   --retain-tokens N        verbatim tail kept by compaction (default 4000)
//   --headroom-tokens N      dsh's pressure headroom (default: dsh's 65536). For windows under ~75k it must be
//                            lowered: otherwise dsh finds no pressure budget and silently never compacts
//   --timeout-minutes N      override the tasks' time limits
//   --fake                   offline check: start scripts/fake-messages-server.mjs with a tool-calling fake agent
//   --fake-agent-steps N     steps per fake agent turn (default 40)
// Env: DSH_BIN (default: npx --yes @deepseek-ai/dsh@0.2.2-alpha.2), plus the model's own variables
// (DEEPSEEK_API_KEY, DEEPSEEK_BASE_URL) for real runs.
import { execFileSync, spawn } from 'node:child_process'
import { appendFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { parseArgs } from 'node:util'
import { readSessionEvents } from '../session-log.mjs'
import { sessionMetrics } from './metrics.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const TASKS_DIR = join(ROOT, 'bench', 'tasks')
const DSH_VERSION = '0.2.2-alpha.2'

const { values: opt } = parseArgs({
  options: {
    tasks: { type: 'string', default: 'all' },
    arms: { type: 'string', default: 'carryon,basic' },
    repeats: { type: 'string', default: '1' },
    out: { type: 'string', default: join(tmpdir(), `dsh-carryon-bench-${new Date().toISOString().replace(/[:.]/g, '-')}`) },
    overlay: { type: 'string', multiple: true, default: [] },
    'threshold-ratio': { type: 'string', default: '0.05' },
    'retain-tokens': { type: 'string', default: '4000' },
    'headroom-tokens': { type: 'string' },
    'timeout-minutes': { type: 'string' },
    fake: { type: 'boolean', default: false },
    'fake-agent-steps': { type: 'string', default: '40' },
    port: { type: 'string', default: '8795' },
  },
})

const ROWS = { carryon: 'carryon-compaction', basic: 'compaction-basic' }
const out = resolve(opt.out)
const arms = opt.arms.split(',')
for (const arm of arms) if (!ROWS[arm]) throw new Error(`unknown arm ${arm}`)
const taskIds = opt.tasks === 'all' ? readdirSync(TASKS_DIR).sort() : opt.tasks.split(',')
const tasks = taskIds.map((id) => ({ id, dir: join(TASKS_DIR, id), ...JSON.parse(readFileSync(join(TASKS_DIR, id, 'task.json'), 'utf8')) }))
const dsh = (process.env.DSH_BIN ?? `npx --yes @deepseek-ai/dsh@${DSH_VERSION}`).split(' ')
const overlays = opt.overlay.map((p) => resolve(p))
if (out.startsWith(ROOT)) throw new Error(`--out must be outside ${ROOT}: the agent could read bench/tasks from there`)
mkdirSync(out, { recursive: true })

const env = { ...process.env }
let fake
if (opt.fake) {
  env.DEEPSEEK_BASE_URL = `http://127.0.0.1:${opt.port}`
  env.DEEPSEEK_API_KEY = 'fake-key-for-the-offline-server'
  fake = spawn(process.execPath, [join(ROOT, 'scripts', 'fake-messages-server.mjs'), '--port', opt.port, '--reply-chars', '2000',
    '--agent-steps', opt['fake-agent-steps'], '--log', join(out, 'fake-requests.jsonl')], { stdio: 'ignore' })
  process.on('exit', () => fake.kill())
  await new Promise((r) => setTimeout(r, 800))
}

function run(cmd, args, options = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 << 20, ...options })
}

// One DSH_HOME and one overlay per arm.
execFileSync('pnpm', ['-s', 'build'], { cwd: ROOT, stdio: 'inherit' })
const armSetup = {}
for (const arm of arms) {
  const home = join(out, `home-${arm}`)
  mkdirSync(home, { recursive: true })
  const armEnv = { ...env, DSH_HOME: home }
  if (arm === 'carryon') run(dsh[0], [...dsh.slice(1), 'plugin', '--profile', 'headless', 'add', `file:${ROOT}`], { env: armEnv })
  const patch = join(out, `${arm}.patch.yml`)
  const headroom = opt['headroom-tokens'] === undefined ? '' : `    headroomTokens: ${opt['headroom-tokens']}\n`
  writeFileSync(patch, `- id: ${ROWS[arm]}\n  config:\n    thresholdRatio: ${opt['threshold-ratio']}\n    retainTokens: ${opt['retain-tokens']}\n${headroom}`)
  const config = run(dsh[0], [...dsh.slice(1), '--profile', 'headless', ...overlays.flatMap((o) => ['--patch', o]), '--patch', patch, '--dump-config'], { env: armEnv })
  writeFileSync(join(out, `${arm}.config.yml`), config)
  const hasCarryOn = /name: dsh-carryon/.test(config)
  if ((arm === 'carryon') !== hasCarryOn) throw new Error(`${arm}: dsh-carryon row ${hasCarryOn ? 'present' : 'missing'}`)
  armSetup[arm] = { env: armEnv, patch, home }
}
writeFileSync(join(out, 'run.json'), JSON.stringify({ started: new Date().toISOString(), options: opt, tasks: taskIds, arms }, null, 2))

function prepare(task, workdir) {
  cpSync(join(task.dir, 'repo'), workdir, { recursive: true })
  if (task.setup) execFileSync('bash', ['-c', task.setup.replaceAll('{task}', task.dir)], { cwd: workdir, stdio: 'inherit' })
  const git = (...a) => run('git', a, { cwd: workdir, env: { ...process.env, GIT_AUTHOR_NAME: 'bench', GIT_AUTHOR_EMAIL: 'bench@localhost', GIT_COMMITTER_NAME: 'bench', GIT_COMMITTER_EMAIL: 'bench@localhost' } })
  git('init', '-q')
  git('add', '-A')
  git('commit', '-qm', 'task start')
}

function runAgent(task, arm, workdir, transcript) {
  const minutes = Number(opt['timeout-minutes'] ?? task.timeoutMinutes ?? 30)
  const args = [...dsh.slice(1), '--profile', 'headless', ...overlays.flatMap((o) => ['--patch', o]),
    '--patch', armSetup[arm].patch, '--approval-policy', 'never', '--json', task.prompt]
  return new Promise((done) => {
    const started = Date.now()
    const child = spawn(dsh[0], args, { cwd: workdir, env: armSetup[arm].env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (c) => (stdout += c))
    child.stderr.on('data', (c) => (stderr += c))
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      try { process.kill(-child.pid, 'SIGTERM') } catch {}
    }, minutes * 60_000)
    child.on('close', (code) => {
      clearTimeout(timer)
      writeFileSync(transcript, stdout)
      writeFileSync(transcript.replace(/\.jsonl$/, '.stderr.txt'), stderr)
      let sessionId = null
      for (const lineText of stdout.split('\n')) {
        try { sessionId = JSON.parse(lineText).sessionId ?? sessionId } catch {}
        if (sessionId) break
      }
      done({ exitCode: code, timedOut, wallSeconds: Math.round((Date.now() - started) / 1000), sessionId })
    })
  })
}

function sessionLog(home, sessionId) {
  if (!sessionId) return null
  const sessions = join(home, 'sessions')
  for (const bucket of existsSync(sessions) ? readdirSync(sessions) : []) {
    const dir = join(sessions, bucket, sessionId)
    if (!existsSync(dir)) continue
    const file = readdirSync(dir).find((f) => /^session\.v\d+\.jsonl\.zstd$/.test(f))
    if (file) return join(dir, file)
  }
  return null
}

const results = join(out, 'results.jsonl')
for (let r = 1; r <= Number(opt.repeats); r += 1) {
  for (const task of tasks) {
    for (const arm of arms) {
      const name = `${task.id}-${arm}-r${r}`
      const workdir = join(out, 'work', name)
      prepare(task, workdir)
      process.stdout.write(`${name}: running... `)
      const runInfo = await runAgent(task, arm, workdir, join(out, `${name}.jsonl`))
      const grade = JSON.parse(run('python3', [join(ROOT, 'bench', 'grade.py'), workdir, join(task.dir, 'hidden')]))
      const log = sessionLog(armSetup[arm].home, runInfo.sessionId)
      const events = log ? readSessionEvents(log) : []
      const metrics = log ? sessionMetrics(events) : null
      const contaminated = events.some((e) => JSON.stringify(e).includes(TASKS_DIR))
      const record = { task: task.id, arm, repeat: r, ...runInfo, grade, metrics, contaminated, sessionLog: log, workdir }
      appendFileSync(results, `${JSON.stringify(record)}\n`)
      if (contaminated) console.log(`\n  WARNING: the session mentions ${TASKS_DIR} (hidden tests or solutions may have been read)`)
      console.log(`exit ${runInfo.exitCode}${runInfo.timedOut ? ' (timeout)' : ''}, hidden ${grade.passed}/${grade.tests}, `
        + `${metrics ? `${metrics.steps} steps, ${metrics.compactions.carryonFolds + metrics.compactions.otherSummaries} compactions` : 'no session log'}, ${runInfo.wallSeconds}s`)
    }
  }
}
console.log(`results: ${results}\nreport:  node scripts/bench/report.mjs ${out}`)
fake?.kill()
