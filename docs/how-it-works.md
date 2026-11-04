# How it works

## CarryOn in one paragraph

[*Pack Light, CarryOn*](https://arxiv.org/abs/2610.18784) organizes a long agent session around what the agent has
established instead of the history that produced it. The context the model sees is made of three parts:
- **continuation carriers**: small records of task state, such as a finding, a decision or a file's role;
- an **execution context**: the task, open obligations and the next step;
- a **live tail** of recent interactions.

When old interactions are retired (a **fold**), the affected carriers are revised against evidence from those
interactions, unaffected ones are carried forward, and the execution context is updated with them.

## Inside dsh

dsh decides when to compact and which old messages to replace. dsh-carryon changes what replaces them.

- **The engine.** `CarryOnCompactionEngine` (`src/engine.ts`) extends dsh's `BasicCompactionEngine` and overrides only
  its `summarize()` hook. dsh keeps the rest:
  - the trigger;
  - the verbatim tail (`retainTokens`);
  - the lock around compaction;
  - edges that never split a tool call from its result;
  - the check that the replacement is smaller than what it replaces.
- **One fold per `summarize()` call** (`src/fold.ts`):
  1. The **Tracker** reads the new interactions, updates candidate records and asks for compilation of the ones
     ready to become carriers.
  2. The **Compiler** receives the candidates, the prior versions of affected carriers and the cited evidence. It
     returns carrier edits and a new execution context.
  3. The **Validator** (`src/validator.ts`) checks the edits: only selected candidates, current base versions, no
     edit that changes nothing, claims citing only the steps they were given, and at least one changed carrier. The edits are then committed.
  4. The checkpoint text (all current carriers plus the execution context) replaces the old messages.
- **State.** Fold state is stored in the `compaction/summary` event's `rawOutput` as readable JSON (`src/state.ts`,
  format v1):
  - the task;
  - the carriers;
  - the open candidates;
  - the execution context;
  - the step numbering.

  A session projection (`src/projection.ts`) restores it on resume. A fold counts only once dsh's `compaction/end`
  reports success.
- **Rejection.** A rejected fold throws, so dsh records a failed compaction and the session stays as it was. As in
  the paper (Appendix A.3), the next attempt waits for `rescanTokens` new tokens, and the wait doubles after each
  further failure, at most `maxBackoffDoublings` times.
- **Fallback.** From `fallbackRatio` of the window up, a failed fold falls back to dsh's own summary instead, with the
  current CarryOn checkpoint kept in front of it. The paper has no such rule; it keeps a session from running into
  the context limit.
- **Profiles.**
  - `cordis.patch.yml` disables dsh's `compaction-basic` row and inserts `carryon-compaction` in the terminal,
    headless, SDK and ACP profiles.
  - In the Web UI and desktop app, `web-preset.patch.yml` adds CarryOn mode, a copy of dsh's Standard mode with
    CarryOn as its compaction backend.
  - `web-default.patch.yml` makes CarryOn mode the default for new sessions.

The Tracker and Compiler prompts are carrycode's own (`prompts/`), written from the paper's description; they do not
copy the paper's appendix.

## Differences from the paper and from carrycode

| | Paper | carrycode | dsh-carryon |
| --- | --- | --- | --- |
| When to fold | scans after a set number of new tokens (6,000 on OSWorld, App. A.3) | every 24,000 new tokens | when context passes dsh's threshold (`thresholdRatio` of the window) |
| Recent turns after a fold | live tail | live tail | dsh's verbatim tail (`retainTokens`) |
| Grounder (environment checks before commit) | yes | yes, being built (M2) | not yet |
| Failure near the context limit | not specified | not specified | falls back to dsh's summary |
| Message format | — | OpenAI chat messages | dsh content blocks (tool calls rendered as `name(arguments)`) |

## Port parity

The core of the runtime is ported from carrycode: records, registry, validator, view, and the role messages and
reply handling. It must reproduce every case in carrycode's parity fixtures (`test/fixtures/parity/`), which carrycode
generates and this repository vendors at a pinned commit (`carrycode.lock.json`). Python semantics are kept where they
matter: lengths count code points, and whitespace follows Python's `str.isspace()`. Token estimates, truncation and
carrier ids therefore agree with carrycode on non-ASCII text. See [Development](development.md#port-parity).
