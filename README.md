# dsh-carryon

CarryOn context folding ([*Pack Light, CarryOn*](https://arxiv.org/abs/2610.18784), arXiv:2610.18784) as a
compaction plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh).

> [!WARNING]
> **Experimental, not benchmarked.** Folds now run the CarryOn Tracker and Compiler, but they have only been
> checked offline with scripted model replies, not yet with a real model. Use throwaway sessions.

This is the TypeScript port of the CarryOn runtime from [carrycode](https://github.com/xuan-tu-ai/carrycode),
packaged as a dsh bundle. carrycode stays the reference implementation and the source of the runtime prompts.
The design is carrycode's [`docs/design/dsh-plugin.md`](https://github.com/xuan-tu-ai/carrycode/blob/main/docs/design/dsh-plugin.md).
What the spike found is in [`docs/p0-findings.md`](docs/p0-findings.md); P2's and P3's decisions are in
[`docs/p2-notes.md`](docs/p2-notes.md) and [`docs/p3-notes.md`](docs/p3-notes.md). The benchmark is in [`bench/`](bench/README.md).

carrycode and dsh-carryon are independent reimplementations built from the paper alone. They are not
affiliated with the paper's authors or with DeepSeek.

## How it works

- `CarryOnCompactionEngine` (`src/engine.ts`) extends dsh's `BasicCompactionEngine` and overrides its
  `summarize()` hook. dsh keeps the trigger, the verbatim tail, the lock bracket, tool-pair-safe edges and the
  shrink check.
- Each `summarize()` call runs one CarryOn fold (`src/fold.ts`) on the region dsh hands it:
  1. The Tracker updates candidates and asks for compilation.
  2. The Compiler proposes carrier edits and a new execution context.
  3. The Validator checks them, then they are committed.
  The checkpoint text (all carriers plus the execution context) replaces the region.
- Fold state is stored in the `compaction/summary` event's `rawOutput`. It holds the task, the current carriers,
  the open candidates, the execution context and the step numbering. A session projection (`src/projection.ts`)
  rebuilds it, and a fold's state counts only after its `compaction/end` reports success.
- A rejected fold changes nothing: dsh records a failed compaction and the history stays. The next scans back
  off as in the paper (Appendix A.3). The wait doubles after each failure, up to 6 times.
- Safety net, which is not in the paper: when the context is at 95% of the window or above, a failed fold falls
  back to dsh's own summary. The current CarryOn checkpoint is kept in front of it, so the session can go on.
- `cordis.patch.yml` disables dsh's `compaction-basic` row and inserts `carryon-compaction`.

## Configuration

Set these on the `carryon-compaction` row, next to the basic backend's keys (`thresholdRatio`, `retainTokens`, …):

| Key | Default | Meaning |
| --- | --- | --- |
| `runtimeProvider`, `runtimeModel` | session model | Model for the Tracker and Compiler (set both or neither) |
| `runtimeMaxTokens` | 8192 | Output cap of each role call |
| `maxRequestsPerScan` | 4 | Compile requests per Tracker scan (paper: 4) |
| `rescanTokens` | 6000 | New tokens before a rescan after a failed fold (paper, OSWorld: 6,000) |
| `maxBackoffDoublings` | 6 | Cap on doubling that wait after consecutive failures (paper, BrowseComp-Plus: 6) |
| `fallbackRatio` | 0.95 | Context share of the window from which a failed fold falls back to dsh's summary |
| `compactionRetries` | 0 | dsh's retry on a smaller range; 0 because a retry costs a full fold (design §4.3) |

Differences from carrycode's measured configuration:
- dsh triggers folds by context pressure (`thresholdRatio` of the window), not by 24k new tokens.
- dsh keeps a verbatim tail (`retainTokens`).
- The Grounder does not run yet (carrycode M2).

## Port status

| Milestone (design §8) | State |
| --- | --- |
| P0 spike | done: engine swap, state in `rawOutput`, web CarryOn mode ([findings](docs/p0-findings.md)) |
| P1 core port | done: `records`, `registry`, `validator`, `view` in TS; carrycode parity fixtures pass |
| P2 roles + engine | done offline: Tracker/Compiler over `ctx.llm`, state v1, backoff, fallback ([notes](docs/p2-notes.md)); real-model run pending |
| P3 dogfood | infrastructure done: 4 tasks with hidden tests, headless A/B runner, Web UI runner, report ([bench](bench/README.md), [notes](docs/p3-notes.md)); real-model runs pending, no measurements yet |

The port is checked against carrycode's parity fixtures for records, registry, validator, view and the role
messages and reply handling. The fixtures and the role prompts are vendored from the carrycode commit recorded
in `carrycode.lock.json` by `pnpm sync:carrycode`. Where dsh differs from carrycode's message format:

- dsh messages are lists of content blocks. `messageText` keeps `text` blocks, renders a `tool-call` block as
  `name(arguments)` and leaves `reasoning` out. carrycode renders OpenAI `tool_calls` instead, so tool calls
  are not part of the parity fixtures.
- Lengths are counted in code points and whitespace follows Python's `str.isspace()`, so token estimates,
  truncation and carrier ids agree with carrycode on non-ASCII text.
- The live-tail boundary helpers (`safe_tail_start`, `build_view`) are not ported: dsh keeps the verbatim tail.

## Profiles

- `headless`, `tui`, `sdk`, `acp`: dsh-carryon replaces the root compaction backend.
- `web` (and desktop): the bundle adds **CarryOn mode** to the mode menu next to the chat box and makes it
  the default for new sessions. The other modes (Standard, PTC, ...) keep dsh's own compaction, so you can
  compare the two. CarryOn mode is generated from dsh's Standard mode by `scripts/gen-web-preset.mjs`.

```bash
npx @deepseek-ai/dsh@0.2.2-alpha.2 plugin --profile web add "file:$PWD"
```

```bash
npx @deepseek-ai/dsh@0.2.2-alpha.2 web
```

![CarryOn mode in the dsh Web UI](docs/images/web-carryon-mode-menu.png)

Details in [findings](docs/p0-findings.md#web-profile-compaction-belongs-to-agent-presets).

## Try it offline (no API key)

Needs Node.js 22+, pnpm and about 1 GB for dsh.

```bash
pnpm install
```

```bash
pnpm test
```

```bash
scripts/offline-check.sh
```

The check does the following:
- It starts `scripts/fake-messages-server.mjs`, a keyless stand-in for the Messages API that dsh's DeepSeek adapter speaks. The server answers agent turns with filler text and answers the Tracker and Compiler with valid JSON.
- It installs this bundle into a fresh `DSH_HOME` and grows one headless session until dsh folds it.
- It makes folds fail on purpose (`DSH_CARRYON_FAIL=1`), first without and then with the fallback.
- It checks the session log with `scripts/check-fold-log.mjs`.

Set `DSH_BIN` to reuse an installed dsh, e.g. `DSH_BIN=dsh`.

## Try it with a real model

Use a separate `DSH_HOME` and a throwaway repository.

```bash
pnpm install && pnpm build
```

```bash
export DSH_HOME="$HOME/.dsh-carryon"
```

```bash
export DEEPSEEK_API_KEY=sk-...
```

```bash
npx @deepseek-ai/dsh@0.2.2-alpha.2 plugin --profile tui add "file:$PWD"
```

```bash
cd /path/to/throwaway-repo
```

```bash
npx @deepseek-ai/dsh@0.2.2-alpha.2 --profile tui --patch /path/to/dsh-carryon/scripts/real.patch.yml
```

`scripts/real.patch.yml` selects `deepseek-v4.1-flash` (1M-token window) and folds at 5% of it, about 50k tokens.
For an Anthropic-compatible gateway such as Token Harbor, also set `DEEPSEEK_BASE_URL=https://tokenharbor.ai`.
With DeepSeek's own API, drop the `llm-deepseek` and `agent-default-model` rows from the overlay.

After rebuilding, refresh the installed copy with `dsh plugin --profile tui update dsh-carryon`.

To read a session log:

```bash
node scripts/read-session-log.mjs "$DSH_HOME"/sessions/*/<session-id>/session.v4.jsonl.zstd --types compaction/summary,compaction/end
```

## Layout

| Path | What |
| --- | --- |
| `src/engine.ts` | `CarryOnCompactionEngine`: `summarize()`, backoff, fallback, config |
| `src/fold.ts` | one fold: Tracker → Compiler → Validator → commit, on copies of the state |
| `src/roles.ts` | Tracker and Compiler: user messages, output filtering, prompt loading |
| `src/llm.ts` | JSON role calls over `ctx.llm.stream()` with one retry |
| `src/projection.ts` | session projection that restores fold state on resume |
| `src/state.ts` | fold state (v1) stored in `rawOutput` |
| `src/records.ts` | zod models: carriers, claims, candidates, execution context, Compiler input/output |
| `src/registry.ts` | carrier ids, versioned carrier store, candidate registry |
| `src/validator.ts` | checks a Compiler output before commit; same problem strings as carrycode |
| `src/view.ts` | checkpoint text, step-numbered tail projection, token estimate |
| `src/pystr.ts`, `src/pyjson.ts` | Python string and `json.dumps` semantics the port needs |
| `prompts/` | Tracker and Compiler system prompts, vendored from carrycode |
| `carrycode.lock.json` | carrycode commit and hashes of the vendored prompts and fixtures |
| `cordis.patch.yml` | bundle layer: disable `compaction-basic`, insert `carryon-compaction` (not in web profiles) |
| `web-preset.patch.yml` | generated "CarryOn mode" preset for web profiles (`pnpm gen:web-preset`) |
| `web-default.patch.yml` | makes CarryOn mode the default preset |
| `scripts/` | fake Messages server, offline check, session-log reader, overlays, carrycode sync |
| `bench/`, `scripts/bench/` | P3 benchmark: tasks with hidden tests, grader, headless and Web UI runners, metrics, report |
| `test/` | unit tests (`node --test`, no network), fold tests with scripted roles, parity test |
| `test/fixtures/parity/` | carrycode's parity fixtures |
| `docs/` | P0 findings, P2 and P3 notes |

## License

Apache-2.0. See [LICENSE](LICENSE).
