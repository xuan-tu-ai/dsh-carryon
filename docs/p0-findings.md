# P0 spike: findings

Date: 2026-11-03. dsh version: `@deepseek-ai/dsh@0.2.2-alpha.2` (npm), source checked at
`deepseek-ai/deepseek-harness` `master` `ce7073d5`. Design: carrycode
[`docs/design/dsh-plugin.md`](https://github.com/xuan-tu-ai/carrycode/blob/main/docs/design/dsh-plugin.md) §8 (P0).

> Scripts were renamed in P2: `p0-offline-check.sh` → `offline-check.sh`, `check-p0-log.mjs` → `check-fold-log.mjs`,
> `DSH_CARRYON_P0_FAIL` → `DSH_CARRYON_FAIL`. The numbers below are from the P0 run.

## Result

P0 is done. Profiles without agent presets (headless, tui, sdk, acp) use dsh-carryon as their root compaction
backend. Profiles built on dsh-web-app (web, desktop) get a "CarryOn mode" agent preset, the default for new
sessions; see "Web profile" below.

| P0 goal | Result |
| --- | --- |
| A `summarize()` override with a fixed text compacts a real dsh session | Yes. `scripts/p0-offline-check.sh` runs 13 `dsh --profile headless` processes on one session: 8 folds committed, fold counter 1→8 across process restarts. |
| The patch row swap works | Yes, with `disabled: true` on `compaction-basic` plus a new row (`carryon-compaction`). Re-pointing the existing row is impossible. |
| Compaction shows in the Web UI | Yes: chat node "Context compacted · Compacted N history items" with our text ([screenshot](images/p0-web-compaction.png)). |
| Is `rawOutput` shown to users? | Only in the Trajectory tab → COMPACTED row → "Raw Output" ([screenshot](images/p0-web-trajectory-raw-output.png)). |
| A failed fold changes nothing | Yes. With `DSH_CARRYON_P0_FAIL=1` the log has `compaction/start` + `compaction/end{error}`, no summary, no replacement; the next fold continues the counter. |

All runs were offline: `scripts/fake-messages-server.mjs` answers dsh's DeepSeek adapter (Messages protocol)
through `DEEPSEEK_BASE_URL`. No run with a real model has been made yet.

## Answers to the design doc's open questions (§9)

1. **Replacing the `compaction-basic` row.** Patch rows support only `insert`, and overrides of existing keys
   by `id` (`disabled`, `config`, `inject`, …); there is no remove or replace verb
   (`vendor/include/src/index.ts`, `applyEntryPatches`). A patch whose `name` differs from the row's is
   skipped ("name mismatch"), so a row cannot be re-pointed. Our `cordis.patch.yml` disables
   `compaction-basic` and inserts `carryon-compaction`. Config written for `compaction-basic` does not carry
   over; it must target `carryon-compaction`. A patch's `config` replaces the row's whole config.
2. **Is `rawOutput` user-visible?** Not in chat. The Trajectory inspector shows it under "Raw Output", so the
   state must stay readable and must never hold secrets.
3. **Reading the previous fold's state.** `Session.snapshotEvents()`, `eventAt()` and `ownEvents()` are
   deprecated for new code (dsh Agent Note 2026-09-09: no new synchronous reads of session history). The
   supported way is a session projection: `ctx.sessionProjections.register(definition)` with a pure `apply`
   over committed events; `handle.stateOf(session)` reads it. `src/projection.ts` commits the state from a
   `compaction/summary` only when the matching `compaction/end` has no `error`.
4. **Does `/compact` go through `summarize()`?** Yes: `compactIfNeeded`, `compactNow` (the `/compact` command)
   and `compactRegion` all call `this.summarize()` (`compaction-basic/src/region.ts`). Headless does not
   route slash commands (it sent `/compact` to the model as text); the manual path was only exercised in the
   web profile, where it hit the preset's engine (see below).
5. **Is `BasicCompactionEngine` exported?** Yes, named and default, from the published package root.
   `SummarizationInput` and `SummaryResult` are not exported, so `src/engine.ts` declares structural copies.

## Other findings

- **The checkpoint is framed by dsh.** The text we return is wrapped by the caller: a fixed preamble
  ("This is an automatically generated checkpoint…"), then `<compacted-summary>` … `</compacted-summary>`.
  Our own `<carryon_checkpoint>` wrapper sits inside it. P1 should drop one of the two framings or accept both.
- **Shrink check uses the framed text.** dsh rejects a summary whose framed size is not smaller than the
  shadowed range ("summary is not smaller than the shadowed content"). The preamble alone is about 80
  tokens; our framed P0 text was 172.
- **Each fold re-folds the previous checkpoint.** The selected range starts at the previous checkpoint
  message, so all CarryOn state that must survive has to be in the projection state, not only in the text.
- **Retries thrash.** With `compactionRetries: 1` (dsh default), a fold that leaves pressure high is retried
  on a smaller range that holds only the previous checkpoint, which cannot shrink, so every step logged a
  failed compaction. The engine now defaults `compactionRetries` to 0 (design doc §4.3 already proposed it).
- **Config keys are strict.** `BasicCompactionEngine` rejects unknown config keys, so CarryOn settings (runtime
  model, etc.) need a static `Config` of our own that strips them before calling `super`.
- **Session logs** are `session.v4.jsonl.zstd`, one zstd frame per append batch; `scripts/session-log.mjs`
  reads them (Node's decoder alone stops after the first frame).
- **Plugin packaging.** dsh loads plugins with a native `import()`, so the bundle ships compiled ESM (`lib/`,
  built with `tsc`). `dsh plugin add file:<dir>` copies the package; after a rebuild run
  `dsh plugin --profile <p> update dsh-carryon`.

## Web profile: compaction belongs to agent presets

The web bundle disables the root `compaction-basic` and mounts compaction inside each agent preset
(`standard`, `ptc`, `minimal`, `cordis`) as an isolated group (`isolate: { compaction: true }`, file
`packages/bundle/web-app/presets/cordis.patch.yml`). Patch ids are indexed only through `group: true` rows,
not through a preset's `config.plugins`, so an external bundle cannot target those inner rows.

What we saw with dsh-carryon installed in the web profile, on one session:

- **Automatic (pressure) folds were done by dsh-carryon.** Our root row's `agent/pre-step` listener also
  hears agents created inside presets.
- **`/compact` was done by the preset's `compaction-basic`** (provider `deepseek-official`, one LLM call).

So in web one session had two compaction engines. Options considered:

| Option | How | Cost |
| --- | --- | --- |
| A. CarryOn preset | The bundle inserts its own agent preset ("CarryOn mode") whose compaction group mounts dsh-carryon; the root row is disabled in web | Copies the `standard` preset's plugin list (~160 lines) and must track it per dsh release. Users can switch between Standard and CarryOn mode, which also gives an A/B comparison. |
| B. User edits the preset | Document how to replace `compaction-basic` in a preset through the Web preset editor or a profile patch | No copied preset, but a manual step, and a profile patch must restate the preset's whole config. |
| C. Ask upstream | Propose a dsh seam to choose the compaction backend per preset (or to patch rows inside presets) | Cleanest; depends on dsh maintainers. |

**Decision (2026-11-03): A.** C can still be proposed upstream later.

### What option A does

- `web-preset.patch.yml` inserts preset `carryon` ("CarryOn mode"): a copy of dsh-web-app's `standard`
  preset with `compaction-basic` replaced by `dsh-carryon` in its compaction group. It is generated by
  `scripts/gen-web-preset.mjs` from the `@deepseek-ai/dsh-web-app` tarball of the pinned dsh release, with each
  edit required to match exactly once; `--check` fails when the committed file differs. Re-run it on every dsh
  upgrade.
- `web-default.patch.yml` sets `agent-preset-registry.default: carryon`. A default the user picks in the Web
  UI (`selectedDefault`) still wins. Profiles without presets have no registry row, so dsh prints one harmless
  `patch: entry "agent-preset-registry" not found` warning there.
- Both the root `carryon-compaction` row and the preset row use the same test,
  `ctx.get('profileContext')?.startedBundles?.includes('@deepseek-ai/dsh-web-app')`: the root row is disabled in
  web-app profiles, the preset row everywhere else. The test looks at the started bundles, not the profile
  name, so custom profiles made from the web template behave like `web`.

### Verified in the Web UI (offline, fake Messages server)

- The mode menu lists "CarryOn mode" first, selected by default
  ([screenshot](images/web-carryon-mode-menu.png)); a new session's header records `agentPreset: carryon`.
- `/compact` in a CarryOn-mode session was written by `dsh-carryon`; in a Standard-mode session by
  `compaction-basic` (`deepseek-official`). One engine per session.
- No root engine: with the same 40k-token window that made the root engine fold in the earlier web run,
  sessions grew past 44k tokens with no automatic fold in either mode. (The preset engines did not fold either:
  their default `headroomTokens` of 65536 exceeds a 40k window. With real DeepSeek models, 1M tokens, this
  does not arise.)

Limits: a bundle-level overlay cannot reach rows inside a preset, so CarryOn mode's compaction thresholds can
only be changed by editing the preset (Web preset editor or a profile patch restating the preset). Automatic
folds inside CarryOn mode have not been observed yet, only `/compact`.

## Profiles checked

| Profile | Agent presets | Root `compaction-basic` | dsh-carryon P0 |
| --- | --- | --- | --- |
| headless | none | enabled | works (offline check) |
| tui, sdk, acp | none | enabled | expected to work, same root row (not run) |
| web | 4 + CarryOn mode | disabled by web-app | CarryOn mode (default) uses dsh-carryon; other modes keep `compaction-basic` |

## What the P0 code does not do

No Tracker, Compiler or Validator; no model call in `summarize()`; the checkpoint text is fixed, so a fold
throws away the content of the folded history. Do not use the P0 build on sessions you care about.
