# P3: dogfood and comparison

Date: 2026-11-03. Design: carrycode `docs/design/dsh-plugin.md` §8, P3: "Long sessions in the Web UI; compare
token use against `compaction-basic` on the same tasks."

## Status

**Infrastructure done and checked offline. Real runs are pending**, because the Token Harbor allowance is used
up. Until then there are no measurements, and the README makes no claim about token savings.

| Part | State |
| --- | --- |
| Tasks (`bench/tasks/`) | 4 tasks with hidden tests and reference solutions. `scripts/bench/check-tasks.mjs`: each start fails most hidden tests (0/14, 3/10, 0/10, 1/10), each solution passes all |
| Headless A/B runner (`scripts/bench/run.mjs`) | Offline with the tool-calling fake agent: 8 runs, 41 steps each, compactions in both arms (CarryOn: 9 folds over 4 tasks), no run contaminated |
| Web UI runner (`scripts/bench/web-session.mjs`) | Offline: CarryOn mode session (preset `carryon`) with 39 CarryOn folds over 52 steps; Standard mode session with 41 dsh summaries |
| Report (`scripts/bench/report.mjs`) | Markdown tables per task and arm, totals, CarryOn/basic ratios, warnings |
| Real-model runs | not run |

## Decisions

- **Tasks.**
  - The tasks are small Python repositories written for this benchmark rather than SWE-bench, because SWE-bench
    needs per-repository environments and Docker. They run in any container with `python3`.
  - The hidden tests are graded after the run, so neither arm can overfit to them during the session.
  - Each task ships a reference solution, which proves its hidden tests are passable.
- **Automation first.** Headless runs are reproducible and cheap to repeat. The Web UI runner exists for the
  design doc's "long sessions in the Web UI" and for screenshots, but each mode gets one session per call.
- **Equal arms.**
  - Each arm has its own `DSH_HOME`, and only the `carryon` home has the plugin.
  - The same thresholds go to `carryon-compaction` and to `compaction-basic`. The basic arm keeps dsh's other
    defaults (for example `compactionRetries: 1`).
  - CarryOn keeps its own defaults (`compactionRetries: 0`, backoff, fallback), because those are part of what is
    compared.
- **Accounting for rejected folds.**
  - A rejected CarryOn fold has no `compaction/summary` event, so its Tracker/Compiler usage was invisible in the
    session log.
  - The engine now appends `[runtime usage {...}]` to the error text, which is stored in `compaction/end.error`.
  - On a fallback, the rejected fold's usage is added to the fallback summary's usage. That result is then an
    unmarked `SummaryResult`, because it no longer describes a single model call.
- **Web UI specifics.**
  - Compaction lives in agent presets, and their thresholds cannot be patched (P0 findings). Folds are therefore
    made to happen by lowering the model's `contextWindow`, which applies to both modes alike.
  - The web UI opens sessions in `<documentsDirectory>/deepseek-harness/default-workspace`. On Linux without
    `xdg-user-dir` there is no default, so the runner sets `documentsDirectory` and places the task copy there.
  - Tools are auto-approved through an added `workspace-auto` permission preset (workspace sandbox, approval
    `never`). dsh's own presets pair the workspace sandbox with `ask`.
- **Pitfalls found.**
  - dsh's default 65,536 headroom tokens leave no pressure budget for windows under about 75k, and compaction then
    silently never runs. The runner has `--headroom-tokens`, and the report flags runs that never compacted.
  - Benchmark output must not live inside this repository (hidden tests and solutions). The runners refuse it and
    flag sessions that mention `bench/tasks`.

## Release gate run (2026-11-06)

DeepSeek V4.1 Flash through Token Harbor, `maxTokens: 32768`, `--threshold-ratio 0.02 --retain-tokens 4000`.
1 run per arm, anecdotal.

| Task | Arm | Score | Total tokens | Cost | Steps | Peak context | Folds | Summaries | Failed |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| logstats | carryon | 10/10 | 391.4k | $0.0441 | 21 | 19.8k | 3 | 0 | 0 |
| logstats | basic | 10/10 | 460.9k | $0.0465 | 21 | 30.1k | 0 | 5 | 5 |

`smoke-gate.mjs` passed: 3 committed CarryOn folds, 12 agent steps after the first one.

Earlier attempts on `ledger` did not pass the gate:
- With `maxTokens: 8192`, both arms stopped after 3–4 steps: the model spent the whole output budget on thinking
  and dsh ended the turn with `max-tokens`. The overlay now sets 32768.
- At the default 5% threshold (about 50k tokens), the task was solved before any compaction (peak context 28k).
- At 1.2% (about 12k tokens), the only fold attempt came right after the agent had read the spec and tests. The
  Tracker made no compile request, the fold was rejected, and the task ended during the backoff that followed.

## How to run the real comparison

See `bench/README.md`. In short, with model access configured:

```bash
node scripts/bench/run.mjs --overlay scripts/bench/deepseek-v41-flash.patch.yml --repeats 3
```

```bash
node scripts/bench/report.mjs <out-dir>
```

Then put the report and its conclusions here, and the headline numbers in the README.
