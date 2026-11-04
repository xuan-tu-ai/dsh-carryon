#!/usr/bin/env node
// Check the benchmark tasks themselves: each task's starting repository must fail most hidden tests, and its
// reference solution (bench/tasks/<id>/solution, copied over the repository) must pass every hidden and visible
// test. Run after editing a task. Needs only python3.
//
// Usage: node scripts/bench/check-tasks.mjs
import { execFileSync } from 'node:child_process'
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const TASKS = join(ROOT, 'bench', 'tasks')
let failed = false
for (const id of readdirSync(TASKS).sort()) {
  const dir = join(TASKS, id)
  const task = JSON.parse(readFileSync(join(dir, 'task.json'), 'utf8'))
  const grade = (variant) => {
    const work = mkdtempSync(join(tmpdir(), `bench-${id}-`))
    try {
      cpSync(join(dir, 'repo'), work, { recursive: true })
      if (variant === 'solution') cpSync(join(dir, 'solution'), work, { recursive: true })
      if (task.setup) execFileSync('bash', ['-c', task.setup.replaceAll('{task}', dir)], { cwd: work })
      const hidden = JSON.parse(execFileSync('python3', [join(ROOT, 'bench', 'grade.py'), work, join(dir, 'hidden')], { encoding: 'utf8' }))
      let visible = true
      try {
        execFileSync('python3', ['-m', 'unittest', 'discover', '-s', 'tests'], { cwd: work, stdio: 'pipe' })
      } catch {
        visible = false
      }
      return { hidden, visible }
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  }
  const start = grade('start')
  const solved = grade('solution')
  const ok = solved.hidden.passed === solved.hidden.tests && solved.hidden.tests > 0 && solved.visible
    && start.hidden.passed < start.hidden.tests / 2 && !start.visible
  failed ||= !ok
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${id}: start ${start.hidden.passed}/${start.hidden.tests} hidden (visible ${start.visible ? 'pass' : 'fail'}), `
    + `solution ${solved.hidden.passed}/${solved.hidden.tests} hidden (visible ${solved.visible ? 'pass' : 'fail'})`)
}
process.exit(failed ? 1 : 0)
