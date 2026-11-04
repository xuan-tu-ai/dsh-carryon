<h1 align="center">dsh-carryon</h1>

<p align="center">
  <strong>CarryOn context folding for DeepSeek Harness: long agent sessions keep what they established, not the whole transcript.</strong>
</p>

<p align="center">
  <a href="https://arxiv.org/abs/2610.18784"><img src="https://img.shields.io/badge/arXiv-2610.18784-B31B1B?style=flat-square&amp;logo=arxiv&amp;logoColor=white" alt="arXiv 2610.18784"></a>
  <a href="https://github.com/xuan-tu-ai/dsh-carryon/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/xuan-tu-ai/dsh-carryon/ci.yml?branch=main&amp;style=flat-square&amp;logo=githubactions&amp;logoColor=white&amp;label=CI" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-Apache--2.0-blue?style=flat-square" alt="License Apache-2.0"></a>
  <a href="https://github.com/deepseek-ai/deepseek-harness"><img src="https://img.shields.io/badge/dsh-0.2.2--alpha.3-4D6BFE?style=flat-square" alt="dsh 0.2.2-alpha.3"></a>
  <img src="https://img.shields.io/badge/Node.js-%E2%89%A522-339933?style=flat-square&amp;logo=nodedotjs&amp;logoColor=white" alt="Node.js 22 or later">
</p>

<p align="center">
  <strong>English</strong> · <a href="README.zh-CN.md">简体中文</a>
</p>

When a [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) session grows long, dsh compacts it
by summarizing old turns into free text. dsh-carryon replaces that step with **CarryOn** from
[*Pack Light, CarryOn*](https://arxiv.org/abs/2610.18784). Old turns are folded into small, versioned records of
what the agent has established ("carriers") and an execution context: the task, open obligations and the next step.
Each fold is validated before it is committed, and a rejected fold changes nothing.

[Configuration](docs/configuration.md) · [How it works](docs/how-it-works.md) · [Development](docs/development.md) · [Benchmark](bench/README.md) · [Releasing](docs/release.md) · [Changelog](CHANGELOG.md)

> [!WARNING]
> **Experimental and not benchmarked.**
> - Everything has been checked with real dsh and a scripted fake model. The first npm release waits for a
>   real-model run ([release gate](docs/release.md#release-gate-real-model-smoke-test)).
> - There are no token or quality measurements yet.
> - Folds add model calls, so a session can cost more than with dsh's own compaction.

## Highlights

- **Drop-in backend.** dsh-carryon replaces dsh's compaction in the terminal, headless, SDK and ACP profiles. dsh
  keeps its trigger, its verbatim tail and its safety checks, and `/compact` works as before.
- **CarryOn mode in the Web UI.** The plugin adds a mode next to Standard mode, so you can compare both in the same
  app.
- **Validated folds.** A fold that fails validation leaves the session untouched. Rescans then back off as in the
  paper. Close to the context limit, a failed fold falls back to dsh's own summary, so the session can go on.
- **Resumable.** Fold state is stored as readable JSON in the session log and restored on resume.
- **Ported, not reinvented.** The runtime is a TypeScript port of [carrycode](https://github.com/xuan-tu-ai/carrycode),
  checked case by case against its parity fixtures.

## How it works

```mermaid
flowchart LR
    A["Session reaches<br/>dsh's compaction threshold"] --> B["Tracker<br/>updates candidates"]
    B -->|compile request| C["Compiler<br/>carrier edits +<br/>execution context"]
    B -->|nothing to compile| R
    C --> D{"Validator"}
    D -->|valid| E["Commit: checkpoint<br/>replaces old turns"]
    D -->|invalid| R["Rejected: session unchanged,<br/>next scan backs off"]
    R -.->|context near the limit| F["Fallback:<br/>dsh's summary"]
```

The checkpoint holds every carrier and the execution context. dsh keeps the most recent turns verbatim after it.
A fold costs one Tracker call, plus one Compiler call when the Tracker asks for compilation; dsh's own compaction
makes one summary call. The engine, the state format and how this port differs from the paper are described in
[How it works](docs/how-it-works.md).

## Quick start

You need [dsh](https://github.com/deepseek-ai/deepseek-harness) **0.2.2-alpha.3** (each dsh-carryon release supports
exactly one dsh release), Node.js 22 or later, and pnpm.

> [!NOTE]
> 0.1.0 is not on npm yet. Until then, install from a checkout as described in
> [Development](docs/development.md#run-a-checkout-with-a-real-model).

Install the plugin into the profile you use. For the terminal UI:

```bash
npx @deepseek-ai/dsh@0.2.2-alpha.3 plugin --profile tui add dsh-carryon
```

For the Web UI:

```bash
npx @deepseek-ai/dsh@0.2.2-alpha.3 plugin --profile web add dsh-carryon
```

Restart dsh. In the terminal UI, every compaction is now a CarryOn fold. In the Web UI, new sessions start in
**CarryOn mode**, which you can switch from the mode menu next to the chat box:

<p align="center">
  <img src="docs/images/web-carryon-mode-menu.png" alt="CarryOn mode in the dsh Web UI mode menu" width="720">
</p>

The plugin is listed under **Plugins → Installed plugins**. A fold's checkpoint appears where dsh shows a compaction
summary, and its full state is under Trajectory → Raw Output. To remove the plugin:

```bash
npx @deepseek-ai/dsh@0.2.2-alpha.3 plugin --profile tui remove dsh-carryon
```

## Configuration

The plugin's config row is `carryon-compaction`. It accepts dsh's own compaction keys (`thresholdRatio`,
`retainTokens`, …) and a few CarryOn keys. For example, put this in `$DSH_HOME/profiles/tui/cordis.patch.yml` to fold at
half of the context window and run the CarryOn roles on the cheaper `deepseek-flash`:

```yaml
- id: carryon-compaction
  config:
    thresholdRatio: 0.5
    runtimeProvider: deepseek-official
    runtimeModel: deepseek-flash
```

dsh replaces a row's whole `config` with the patched one, so list all your keys together. See
[Configuration](docs/configuration.md) for every key, the defaults, and the Web UI's limits.

## Status

| Milestone | State |
| --- | --- |
| P0 spike | ✅ engine swap, state in the session log, CarryOn mode in the Web UI ([findings](docs/p0-findings.md)) |
| P1 core port | ✅ records, registry, validator and view in TypeScript; carrycode parity fixtures pass |
| P2 roles + engine | ✅ Tracker and Compiler over dsh's LLM service, backoff, fallback ([notes](docs/p2-notes.md)) |
| P3 benchmark | 🟡 4 tasks with hidden tests, A/B and Web UI runners ([bench](bench/README.md)); no real-model runs yet |
| P4 release | 🟡 package, CI and release workflow ready; npm publish waits for the real-model gate |

Not done yet: carrycode's Grounder, which would check carriers against the repository before commit.

Known issue: profiles without the Web UI's agent presets print one harmless warning at startup,
`[dsh-carryon] patch: entry "agent-preset-registry" not found`.

## Citation

dsh-carryon implements the method of this paper. If you use it in research, please cite the paper:

```bibtex
@misc{lu2026carryon,
  title         = {Pack Light, CarryOn: Building Object-Oriented Context for Long-Horizon Agents},
  author        = {Lu, Yuchen and McAuley, Julian and Zhang, Lei},
  year          = {2026},
  eprint        = {2610.18784},
  archivePrefix = {arXiv},
  primaryClass  = {cs.AI},
  url           = {https://arxiv.org/abs/2610.18784}
}
```

carrycode and dsh-carryon are independent reimplementations built from the paper. They are not affiliated with the
paper's authors or with DeepSeek.

## License

[Apache-2.0](LICENSE).
