# dsh-carryon

CarryOn context folding ([*Pack Light, CarryOn*](https://arxiv.org/abs/2610.18784), arXiv:2610.18784) as a
compaction plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh).

> [!WARNING]
> **P0 spike, not usable yet.** The plugin replaces dsh's compaction backend, but its summarizer returns a
> fixed text: every fold throws away the content of the folded history. Use it only on throwaway sessions.
> Nothing here has been benchmarked.

This is the TypeScript port of the CarryOn runtime from [carrycode](https://github.com/xuan-tu-ai/carrycode),
packaged as a dsh bundle. carrycode stays the reference implementation and the source of the runtime prompts.
The design is carrycode's [`docs/design/dsh-plugin.md`](https://github.com/xuan-tu-ai/carrycode/blob/main/docs/design/dsh-plugin.md);
what the spike found is in [`docs/p0-findings.md`](docs/p0-findings.md).

carrycode and dsh-carryon are independent reimplementations built from the paper alone. They are not
affiliated with the paper's authors or with DeepSeek.

## How it works

- `CarryOnCompactionEngine` (`src/engine.ts`) extends dsh's `BasicCompactionEngine` and overrides its
  `summarize()` hook. dsh keeps the trigger, the verbatim tail, the lock bracket, tool-pair-safe edges and the
  shrink check.
- Fold state is stored in the `compaction/summary` event's `rawOutput` and rebuilt by a session projection
  (`src/projection.ts`); a fold's state counts only after its `compaction/end` reports success.
- `cordis.patch.yml` disables dsh's `compaction-basic` row and inserts `carryon-compaction`.

P0 state is only a fold counter. The Tracker and Compiler, and wiring the core into `summarize()`, come in P2.

## Port status

| Milestone (design §8) | State |
| --- | --- |
| P0 spike | done: engine swap, state in `rawOutput`, web CarryOn mode ([findings](docs/p0-findings.md)) |
| P1 core port | done: `records`, `registry`, `validator`, `view` in TS; all carrycode parity fixtures pass. Not used by the engine yet |
| P2 roles + engine | not started |

The core port is checked against carrycode's parity fixtures (`test/fixtures/parity/`, vendored from the carrycode
commit recorded in `source.json` by `pnpm sync:parity`). Where dsh differs from carrycode's message format:

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
npx @deepseek-ai/dsh@0.2.2-alpha.2 web
```

![CarryOn mode in the dsh Web UI](docs/images/web-carryon-mode-menu.png)

Details in [findings](docs/p0-findings.md#web-profile-compaction-belongs-to-agent-presets).

## Try it offline (no API key)

Needs Node.js 22+, pnpm and about 1 GB for dsh.

```bash
pnpm install
pnpm test
scripts/p0-offline-check.sh
```

The check starts `scripts/fake-messages-server.mjs` (a keyless stand-in for the Messages API that dsh's
DeepSeek adapter speaks), installs this bundle into a fresh `DSH_HOME`, grows one headless session until
dsh folds it, makes three folds fail on purpose (`DSH_CARRYON_P0_FAIL=1`), and checks the session log with
`scripts/check-p0-log.mjs`. Set `DSH_BIN` to reuse an installed dsh, e.g. `DSH_BIN=dsh`.

## Try it with DeepSeek

Use a separate `DSH_HOME` and a throwaway repository: P0 discards folded history.

```bash
pnpm install && pnpm build
```

```bash
export DSH_HOME="$HOME/.dsh-carryon-p0"
export DEEPSEEK_API_KEY=sk-...
```

```bash
npx @deepseek-ai/dsh@0.2.2-alpha.2 plugin --profile tui add "file:$PWD"
```

```bash
cd /path/to/throwaway-repo
npx @deepseek-ai/dsh@0.2.2-alpha.2 --profile tui --patch /path/to/dsh-carryon/scripts/p0-real.patch.yml
```

`scripts/p0-real.patch.yml` folds at 5% of the model's context window (about 52k tokens) so a fold happens
after a short session. The checkpoint text appears in the conversation as "dsh-carryon P0 spike: fold N".
After rebuilding, refresh the installed copy with `dsh plugin --profile tui update dsh-carryon`.

To read a session log: `node scripts/read-session-log.mjs "$DSH_HOME"/sessions/*/<session-id>/session.v4.jsonl.zstd --types compaction/summary,compaction/end`.

## Layout

| Path | What |
| --- | --- |
| `src/engine.ts` | `CarryOnCompactionEngine`, the `summarize()` override |
| `src/projection.ts` | session projection that restores fold state on resume |
| `src/state.ts` | fold state format stored in `rawOutput` |
| `src/records.ts` | zod models: carriers, claims, candidates, execution context, Compiler input/output |
| `src/registry.ts` | carrier ids, versioned carrier store, candidate registry |
| `src/validator.ts` | checks a Compiler output before commit; same problem strings as carrycode |
| `src/view.ts` | checkpoint text, step-numbered tail projection, token estimate |
| `src/pystr.ts` | Python string semantics the port needs (whitespace, code points, `normpath`) |
| `cordis.patch.yml` | bundle layer: disable `compaction-basic`, insert `carryon-compaction` (not in web profiles) |
| `web-preset.patch.yml` | generated "CarryOn mode" preset for web profiles (`pnpm gen:web-preset`) |
| `web-default.patch.yml` | makes CarryOn mode the default preset |
| `scripts/` | fake Messages server, offline check, session-log reader, test overlays |
| `test/` | unit tests (`node --test`, no network) and the parity test |
| `test/fixtures/parity/` | carrycode's parity fixtures, vendored by `scripts/sync-parity-fixtures.mjs` |
| `docs/p0-findings.md` | what the spike found, answers to the design doc's open questions |

## License

Apache-2.0. See [LICENSE](LICENSE).
