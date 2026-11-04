# Configuration

dsh-carryon adds one config row, `carryon-compaction`. It extends dsh's basic compaction backend, so it accepts that
backend's keys, such as `thresholdRatio`, `retainTokens` and `headroomTokens`, with the same meaning. It also accepts
these CarryOn keys:

| Key | Default | Meaning |
| --- | --- | --- |
| `runtimeProvider`, `runtimeModel` | session model | Model for the Tracker and Compiler (set both or neither) |
| `runtimeMaxTokens` | 8192 | Output cap of each role call |
| `maxRequestsPerScan` | 4 | Compile requests per Tracker scan (paper: 4) |
| `rescanTokens` | 6000 | New tokens before a rescan after a failed fold (paper, OSWorld: 6,000) |
| `maxBackoffDoublings` | 6 | Cap on doubling that wait after consecutive failures (paper, BrowseComp-Plus: 6) |
| `fallbackRatio` | 0.95 | Share of the context window from which a failed fold falls back to dsh's summary |
| `compactionRetries` | 0 | dsh's retry on a smaller range; 0 because a retry costs a whole fold |

## Where to put it

dsh composes its configuration from layers, and later layers win. Use one of these:

| File | Applies to |
| --- | --- |
| `$DSH_HOME/profiles/<profile>/cordis.patch.yml` | one profile, for good |
| `$DSH_HOME/cordis.patch.yml` | every profile on this machine |
| a file passed with `dsh --patch <file>` | one run |

A patch replaces a row's whole `config` instead of merging keys. List all the keys you want to change in one place,
or an earlier setting is lost.

Example: fold at half of the context window, keep the newest ~8k tokens verbatim, and run the CarryOn roles on dsh's
`deepseek-flash` while the agent uses `deepseek-v4-pro`:

```yaml
- id: carryon-compaction
  config:
    thresholdRatio: 0.5
    retainTokens: 8000
    runtimeProvider: deepseek-official
    runtimeModel: deepseek-flash
```

## Choosing values

- **When folds happen.** dsh folds when the context passes this threshold:
  `min(window × thresholdRatio, window − maxTokens − headroomTokens)`. With dsh's default 65,536 headroom tokens, a
  model window under about 75k tokens leaves no room, and dsh then never compacts, without saying so. Lower
  `headroomTokens` for small windows.
- **Cost.** Each fold makes one Tracker call, plus one Compiler call when the Tracker asks for compilation. Each call
  is retried once on invalid JSON. A cheaper `runtimeModel` lowers that cost, but the roles must still produce valid
  JSON reliably.
- **Failures.** After a rejected fold, the next attempt waits for `rescanTokens` new tokens, and the wait doubles
  with each further failure. At `fallbackRatio` of the window, a failed fold is replaced by dsh's own summary. Set
  `fallbackRatio: 1` to turn the fallback off.

## Web UI

In the Web UI (and the desktop app), compaction lives inside each agent preset, and dsh does not let an overlay patch
rows inside a preset. **CarryOn mode** therefore runs with dsh's preset defaults: it folds at 80% of the window, and
the keys above cannot be changed there yet. Details: [P0 findings](p0-findings.md#web-profile-compaction-belongs-to-agent-presets).

The plugin also makes CarryOn mode the default for new sessions. A default you choose in the Web UI wins.
