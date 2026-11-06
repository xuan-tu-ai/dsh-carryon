# Releasing dsh-carryon

Milestone P4 of carrycode's `docs/design/dsh-plugin.md` §8: README, npm publish, `dsh-plugin` topic.

A release goes to npm as `dsh-carryon`. dsh users install it with `dsh plugin --profile <name> add dsh-carryon`. dsh has
no central plugin catalog. People find plugins through npm, through GitHub topics, or through plugin indexes that
someone hosts; dsh's Web UI reads those in its experimental Discover tab. The package's title, description and icon
(`locale/en.json`, `icon.svg`) are what dsh's Plugins page and plugin indexes show.

## One-time setup

1. **npm token.** On npmjs.com, create a granular access token with read and write access to packages.
   - The package does not exist before the first publish, so the token must cover all packages at first.
   - After 0.1.0, narrow it to `dsh-carryon`.
   - The token must be able to publish without an interactive 2FA prompt, because it runs in GitHub Actions.
2. **GitHub secret.** In the repository, open Settings → Secrets and variables → Actions → New repository secret.
   Name it `NPM_TOKEN` and paste the token.
3. **Topics.** On the repository page, open About (the gear icon) and add the topics `dsh-plugin` and
   `deepseek-harness`.
4. **Later, optional:** switch to npm trusted publishing (OIDC), which needs no long-lived token.
   - Configure it on the package's npm settings page once the package exists.
   - Then drop `NODE_AUTH_TOKEN` from `.github/workflows/release.yml`.

## Release gate: real-model smoke test

A release is not published until one real-model run shows working folds. Run it on task `logstats`, one run per arm,
with the fold threshold at 2% of the 1M window (about 20k tokens). On `ledger` the model finishes before the
Tracker has anything to compile. For
DeepSeek V4.1 Flash through Token Harbor, set these first:

```bash
export DEEPSEEK_BASE_URL=https://tokenharbor.ai
```

```bash
export DEEPSEEK_API_KEY=<key>
```

```bash
node scripts/bench/run.mjs --tasks logstats --overlay scripts/bench/deepseek-v41-flash.patch.yml --threshold-ratio 0.02
```

```bash
node scripts/bench/smoke-gate.mjs <out-dir>
```

```bash
node scripts/bench/report.mjs <out-dir>
```

`smoke-gate.mjs` passes when the `carryon` run meets all of these:
1. dsh exited 0 and did not time out.
2. The run is not contaminated.
3. At least one CarryOn fold was committed.
4. The agent took at least one step after the first committed fold.

The `basic` run is there only for comparison.

When the gate passes, before tagging:
1. Put the task rows of `report.md` into `docs/p3-notes.md`, labelled "1 run per arm, anecdotal".
2. Before the first release only: in both READMEs, remove the note that says the package is not on npm.

If it fails, fix the cause first. A run where every fold fell back to dsh's summary also fails, because it has no
committed fold.

## Cutting a release

1. **Merge.** Everything is merged into `main`, and CI is green.
2. **Version and changelog.**
   - `package.json` has the new version.
   - `CHANGELOG.md` has a section `## <version> (YYYY-MM-DD)`. "(unreleased)" is refused.
   - `engines.dsh` and the `@deepseek-ai/*` pins name the dsh release you tested.
3. **Vendored files.** If carrycode's parity PRs have been merged since the pin, re-vendor from the merged commit:

   ```bash
   pnpm sync:carrycode ../carrycode --ref <merged commit>
   ```

4. **Tag and push:**

   ```bash
   git tag v0.1.0
   ```

   ```bash
   git push origin v0.1.0
   ```

5. **Workflow.** `.github/workflows/release.yml` runs on the tag:
   1. It checks that the tag matches the version and that the changelog section exists.
   2. It runs typecheck, tests and the web-preset check.
   3. It packs the tarball and runs the offline end-to-end check on that tarball.
   4. It publishes that same tarball with provenance.
   5. It creates a GitHub Release with the changelog section and the tarball.
6. **Add the npm badge.** After the first publish, add it to the badge row of both READMEs:
   `<a href="https://www.npmjs.com/package/dsh-carryon"><img src="https://img.shields.io/npm/v/dsh-carryon?style=flat-square&amp;logo=npm" alt="npm"></a>`.
7. **Verify** the published package:

   ```bash
   npm view dsh-carryon version
   ```

   Then check that it installs in a fresh home:

   ```bash
   DSH_HOME="$(mktemp -d)" npx @deepseek-ai/dsh@0.2.2-alpha.3 plugin --profile tui add dsh-carryon
   ```

A published version cannot be overwritten. If a release is broken:
1. Deprecate it: `npm deprecate dsh-carryon@<version> "<reason>"`.
2. Release a fixed patch version.

## Moving to a new dsh release

Each release supports one dsh release, because the plugin subclasses dsh internals and copies dsh's Standard
preset. To move:

1. **Update the pins** in `package.json` to the new release:
   - every `@deepseek-ai/*` peer and dev dependency;
   - `@deepseek-ai/cordis` (match `@deepseek-ai/dsh`'s own dependency);
   - `engines.dsh`.

   The scripts and CI read the dsh version from `engines.dsh`.
2. **Regenerate and check:**
   - `pnpm install`;
   - `pnpm gen:web-preset`, then review the diff of `web-preset.patch.yml`;
   - `pnpm typecheck && pnpm test`;
   - `scripts/offline-check.sh`.
3. **Read the dsh changelog** for changes to compaction, session projections and `ctx.llm`.
4. **Release** a new minor version, and say in `CHANGELOG.md` which dsh release it supports.
5. **Update the README** install commands.
