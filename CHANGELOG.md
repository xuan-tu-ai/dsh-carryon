# Changelog

All notable changes to dsh-carryon. Versions follow [SemVer](https://semver.org/); while the version is 0.x, any
release may change behaviour or configuration. Each release supports exactly one dsh release, given by
`engines.dsh` in `package.json`.

## 0.1.1 (2026-11-06)

Documentation only; the code is the same as 0.1.0. It supports dsh `0.2.2-alpha.3`.

- **npm page.** The READMEs use full GitHub URLs for images and links, so they work on npmjs.com.
- **Quick start.** How to check that the plugin is installed, update it, and remove it.
- **Troubleshooting.** New `docs/troubleshooting.md`: install errors, no folds, failed folds and their messages.
- **Issue forms** for bug reports and feature requests.
- **Release.** Published from GitHub Actions through npm trusted publishing (OIDC).

## 0.1.0 (2026-11-06)

First release. It supports dsh `0.2.2-alpha.3`.

- **CarryOn compaction backend.** `CarryOnCompactionEngine` replaces dsh's `compaction-basic` in the `headless`,
  `tui`, `sdk` and `acp` profiles. Each compaction runs one CarryOn fold: the Tracker updates candidates, the
  Compiler proposes carrier edits and an execution context, and the Validator checks them before commit. These are
  TypeScript ports of carrycode's runtime roles. The port is checked against carrycode's parity fixtures.
- **CarryOn mode in the Web UI.** In `web` and desktop profiles, a "CarryOn mode" agent preset is added next to
  Standard mode and made the default for new sessions.
- **State.** Fold state is stored in each `compaction/summary` event's `rawOutput` (state format v1) and restored on
  resume by a session projection.
- **Failure handling.**
  - A rejected fold changes nothing.
  - Rescans then back off as in the paper: 6,000 new tokens, doubling after each failure, at most 6 doublings.
  - At 95% of the context window or above, a failed fold falls back to dsh's own summary.
- **Display metadata.** The plugin has a title, a description and an icon in dsh's Plugins page and in plugin
  indexes.

Known limitations:
- **No measurements yet.** Not benchmarked, so there are no token or quality numbers. See the README for what has
  been run.
- **No Grounder.** Folds do not run carrycode's Grounder checks.
- **Extra cost per fold.** A fold costs one Tracker call and, when the Tracker asks for compilation, one Compiler
  call. Each call is retried once on invalid JSON. dsh's basic backend makes a single summary call instead.
- **Startup warning.** Profiles without agent presets print one harmless warning at startup:
  `patch: entry "agent-preset-registry" not found`.
