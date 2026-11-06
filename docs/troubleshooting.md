# Troubleshooting

Each entry starts with what you see. If yours is not here, [open an issue](https://github.com/xuan-tu-ai/dsh-carryon/issues/new/choose).

## Installing

### `ERR_PNPM_ADDING_TO_ROOT` when adding the plugin

```text
ERR_PNPM_ADDING_TO_ROOT  Running this command will add the dependency to the workspace root ...
```

pnpm treats the profile's directory as the root of a pnpm workspace. `dsh plugin` passes its arguments to pnpm, so
you can confirm the root as pnpm suggests:

```bash
npx @deepseek-ai/dsh@0.2.2-alpha.3 plugin --profile web add -w dsh-carryon
```

If that fails too, look for a `pnpm-workspace.yaml` in a parent directory of `$DSH_HOME` (by default `~/.dsh`), for
example in your home directory, which another project may have left there. The full pnpm output is in the
`pnpm.log` file whose path dsh prints after `plugin command failed; diagnostics:`.

### The package is incompatible with your dsh version

Each dsh-carryon release supports exactly one dsh release, stated in `engines.dsh`: 0.1.x supports dsh
`0.2.2-alpha.3`. With another dsh version, dsh refuses the plugin and prints an `allow-version ... --accept-risk`
command. Accepting the risk is not recommended: the plugin subclasses dsh internals and copies its Standard mode, so
a mismatch can break compaction. Run the dsh version that the README names instead, for example with
`npx @deepseek-ai/dsh@0.2.2-alpha.3`.

### `'pnpm' is not recognized` / `pnpm: command not found`

`dsh plugin` runs pnpm, which is not installed with Node.js. Install it, then run the command again:

```bash
npm install -g pnpm
```

With nvm or nvm-windows, global packages belong to one Node.js version: install pnpm while the version you run dsh
with is active.

### `Unsupported engine` (`EBADENGINE`), or the command exits without doing anything

dsh 0.2.2-alpha.3 needs Node.js 24.9 or later. Check with `node --version`. If it still shows an older version after
you install a newer Node.js, open a new terminal; if that does not help, another Node.js comes first on your `PATH`
(`where node` on Windows, `which -a node` elsewhere). With nvm-windows, run `nvm install 24` and `nvm use 24`.

### Is it installed?

```bash
npx @deepseek-ai/dsh@0.2.2-alpha.3 plugin --profile tui list
```

`dsh-carryon` should be listed under `dependencies`. Use the profile you run (`tui`, `web`, `headless`, ...): each
profile has its own plugins.

## Running

### Where is the Web UI?

`plugin add` only installs the plugin. Start the Web UI with
`npx @deepseek-ai/dsh@0.2.2-alpha.3 web`; it prints the address to open, and stops when you close the terminal.

### A warning about `agent-preset-registry` at startup

```text
[dsh-carryon] patch: entry "agent-preset-registry" not found
```

Harmless. The plugin adds CarryOn mode to the Web UI's agent presets, and profiles without the Web UI have no presets
to patch. The terminal, headless, SDK and ACP profiles still use CarryOn for compaction.

### No fold ever happens

A fold runs only when dsh compacts. dsh compacts when the context passes
`min(window × thresholdRatio, window − maxTokens − headroomTokens)`.

- **Short sessions** never reach it. With a large window (1M tokens), even long tasks may not. Lower `thresholdRatio`
  (see [Configuration](configuration.md)) or run `/compact` to fold by hand.
- **Small windows** (under about 75k tokens) leave no room with dsh's default 65,536 headroom tokens, and dsh then
  never compacts, without saying so. Lower `headroomTokens`.
- **Web UI:** CarryOn mode uses dsh's preset defaults and folds at 80% of the window. The keys cannot be changed
  there yet ([details](configuration.md#web-ui)).

### A fold failed

A failed fold changes nothing: the session goes on with its history as it was. The reason is in the session log, in
the `compaction/end` event's `error`, and in dsh's compaction notice:

| Message | Meaning |
| --- | --- |
| `fold rejected: no compile request` | The Tracker found nothing ready to become a carrier yet, typically early in a task. The next attempt waits for new tokens. |
| `fold rejected: ...` (another reason) | The Compiler's edits did not pass validation. Same handling. |
| `cooling down after N failed fold(s): X of Y new tokens` | Backoff after failures, as in the paper: no model call until Y new tokens have arrived. Y starts at `rescanTokens` × 2 and doubles after each further failure. |
| `...; context is near the window, falling back to dsh's summary` (log warning) | At `fallbackRatio` of the window (95% by default), a failed fold is replaced by dsh's own summary so the session can go on. |

Occasional failures are expected. If every fold fails, the runtime model may not return valid JSON reliably: set a
stronger `runtimeModel` (see [Configuration](configuration.md)) and include the `compaction/end` errors in an issue.

### `no model for the runtime roles; set runtimeProvider and runtimeModel`

The Tracker and Compiler use the session's model unless `runtimeProvider` and `runtimeModel` are set. This error
means neither was available. Set both, together, in the `carryon-compaction` row.

### Where to see what a fold did

- **Web UI:** the checkpoint appears where dsh shows a compaction summary; the full state (carriers, execution
  context, step numbering) is under Trajectory → Raw Output.
- **Terminal and headless:** the same state is stored as readable JSON in the `compaction/summary` event of the
  session log under `$DSH_HOME/sessions/`.

## Reporting a problem

Use the [bug report form](https://github.com/xuan-tu-ai/dsh-carryon/issues/new?template=bug_report.yml). It asks for
your dsh, dsh-carryon and Node.js versions, the profile and model, and the `compaction/end` errors. Leave out API keys
and anything private from your code: fold state contains text from your session.
