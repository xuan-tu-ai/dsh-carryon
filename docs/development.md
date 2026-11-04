# Development

How to build and test dsh-carryon, run a checkout against a real model, and keep the port in step with carrycode. The
benchmark is described in [bench/README.md](../bench/README.md), releases in [release.md](release.md).

## Setup and checks
Needs Node.js 22+, pnpm and about 1 GB for dsh.

```bash
pnpm install
```

```bash
pnpm typecheck && pnpm test
```

```bash
scripts/offline-check.sh
```

The offline check runs without an API key:
- It starts `scripts/fake-messages-server.mjs`, a keyless stand-in for the Messages API that dsh's DeepSeek adapter
  speaks. The server answers the Tracker and Compiler with valid JSON.
- It installs this bundle into a fresh `DSH_HOME` and grows one headless session until dsh folds it.
- It makes folds fail on purpose (`DSH_CARRYON_FAIL=1`), first without and then with the fallback.
- It checks the session log with `scripts/check-fold-log.mjs`.

Two environment variables change what it uses:
- `DSH_BIN` reuses an installed dsh.
- `PLUGIN_SPEC=/abs/path/dsh-carryon-x.y.z.tgz` checks a packed tarball instead of the checkout.

## Run a checkout with a real model

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
npx @deepseek-ai/dsh@0.2.2-alpha.3 plugin --profile tui add "file:$PWD"
```

```bash
cd /path/to/throwaway-repo
```

```bash
npx @deepseek-ai/dsh@0.2.2-alpha.3 --profile tui --patch /path/to/dsh-carryon/scripts/real.patch.yml
```

`scripts/real.patch.yml` selects `deepseek-v4.1-flash` (1M-token window) and folds at 5% of it, about 50k tokens.
For an Anthropic-compatible gateway such as Token Harbor, also set `DEEPSEEK_BASE_URL=https://tokenharbor.ai`.
With DeepSeek's own API, drop the `llm-deepseek` and `agent-default-model` rows from the overlay. After
rebuilding, refresh the installed copy with `dsh plugin --profile tui update dsh-carryon`.

To read a session log:

```bash
node scripts/read-session-log.mjs "$DSH_HOME"/sessions/*/<session-id>/session.v4.jsonl.zstd --types compaction/summary,compaction/end
```

## Port parity

The port is checked against carrycode's parity fixtures for records, registry, validator, view, the role messages
and the reply handling. The fixtures and the role prompts are vendored from the carrycode commit recorded in
`carrycode.lock.json` by `pnpm sync:carrycode`. Where dsh differs from carrycode's message format:

- dsh messages are lists of content blocks. `messageText` keeps `text` blocks, renders a `tool-call` block as
  `name(arguments)` and leaves `reasoning` out. carrycode renders OpenAI `tool_calls` instead, so tool calls are not
  part of the parity fixtures.
- Lengths are counted in code points and whitespace follows Python's `str.isspace()`, so token estimates,
  truncation and carrier ids agree with carrycode on non-ASCII text.
- The live-tail boundary helpers (`safe_tail_start`, `build_view`) are not ported: dsh keeps the verbatim tail.

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
| `locale/`, `icon.svg` | title, description and icon shown by dsh's Plugins page and plugin indexes |
| `scripts/` | fake Messages server, offline check, session-log reader, overlays, carrycode sync |
| `bench/`, `scripts/bench/` | P3 benchmark: tasks with hidden tests, grader, headless and Web UI runners, metrics, report, release gate |
| `test/` | unit tests (`node --test`, no network), fold tests with scripted roles, parity test |
| `test/fixtures/parity/` | carrycode's parity fixtures |
| `docs/` | configuration, how it works, development, release process, P0 findings, P2 and P3 notes |
| `.github/workflows/` | CI (tests, offline check on the packed tarball) and the tag-triggered npm release |
