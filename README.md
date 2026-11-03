# dsh-carryon

CarryOn context folding ([*Pack Light, CarryOn*](https://arxiv.org/abs/2610.18784), arXiv:2610.18784) as a
compaction plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh).

> [!WARNING]
> Early work in progress, not usable yet. Nothing here has been benchmarked.

This is the TypeScript port of the CarryOn runtime from [carrycode](https://github.com/xuan-tu-ai/carrycode),
packaged as a dsh bundle that replaces dsh's default compaction backend. carrycode stays the reference
implementation and the source of the runtime prompts. The design is in carrycode's
[`docs/design/dsh-plugin.md`](https://github.com/xuan-tu-ai/carrycode/blob/main/docs/design/dsh-plugin.md).

carrycode and dsh-carryon are independent reimplementations built from the paper alone. They are not
affiliated with the paper's authors or with DeepSeek.

## License

Apache-2.0. See [LICENSE](LICENSE).
