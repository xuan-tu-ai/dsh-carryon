# P2: roles and engine

Date: 2026-11-03. dsh `0.2.2-alpha.2`. Design: carrycode
[`docs/design/dsh-plugin.md`](https://github.com/xuan-tu-ai/carrycode/blob/main/docs/design/dsh-plugin.md) §4 and §8 (P2).

## Result

`summarize()` runs one CarryOn fold per compaction:
1. The Tracker scans the region and selects candidates.
2. The Compiler compiles them.
3. The Validator checks the result and the edits are committed.

The checkpoint text replaces the region, and state v1 goes into `rawOutput`.

| P2 goal | Result |
| --- | --- |
| Tracker/Compiler over `ctx.llm` | Yes. Both go through `ctx.llm.stream()` (`purpose: 'compaction'`), with the session's model unless `runtimeProvider`/`runtimeModel` are set. User messages are byte-identical to carrycode's (22 `roles` parity cases). |
| State round-trips through `rawOutput` | Yes. `scripts/offline-check.sh` commits 4 folds across 15 dsh processes; the carriers, task and step numbering carry over each restart. |
| A failed fold leaves the surface unchanged | Yes. A rejected fold has `compaction/start` + `compaction/end{error}`, no summary and no replacement (unit tests and offline check). |
| Real model | **Not run.** The Token Harbor account's Pass allowance was used up (and the `:free` allowance until 2026-11-06). |

Offline run (fake Messages server scripting Tracker/Compiler JSON):

```
fold 1 committed: 1 carrier(s), next_step 4
fold 2 committed: 2 carrier(s), next_step 9
failed, surface unchanged (dsh-carryon: fold rejected: failed on purpose (DSH_CARRYON_FAIL=1))
fallback to dsh's summary, CarryOn state unchanged
fallback to dsh's summary, CarryOn state unchanged
fold 3 committed: 3 carrier(s), next_step 15
fold 4 committed: 4 carrier(s), next_step 20
```

## Decisions

- **What the roles see.** dsh hands `summarize()` the system head and the shadowed region. The region starts with
  the previous checkpoint message from the second fold on.
  - The system head is dropped.
  - In a checkpoint message, dsh's framing and our own `<carryon_checkpoint>` block are dropped, because carriers
    and the execution context come from the state.
  - Anything else in a checkpoint message stays as a user message. That covers a dsh summary written by the
    fallback, so the Tracker can still compile what it says.
- **Step numbers.**
  - Messages are numbered from `state.next_step`, and a committed fold advances it by the number of messages it
    folded.
  - Claims' `source_steps` therefore stay distinct across folds.
  - A fallback does not advance it, so a later fold may reuse numbers of messages the fallback summarized. Those
    numbers are provenance only.
- **State v1** holds:
  - the task: the first user message of the first fold (design §4.2);
  - the current version of each carrier (earlier versions are not needed to validate or materialize);
  - the open candidates;
  - the execution context;
  - `next_step`.
  
  A P0 (v0) state is read as an empty v1 state with its fold count.
- **Failed folds and backoff** (paper App. A.3; decision of 2026-11-03).
  - A rejected fold throws, so nothing changes. That covers no compile request, Validator problems, invalid
    replies after one retry, and transport errors.
  - After k consecutive failures, the next scan waits for `rescanTokens · 2^min(k, 6)` new tokens; calls in
    between fail at once, with no model call.
  - Candidate updates from failed scans are kept in memory, as in App. A.1, and the Tracker does not rescan
    messages it has seen.
  - This memory is per process: it is lost on resume (design §4.1), and in headless mode every turn is a new
    process.
- **Safety net, not in the paper.**
  - A failed or cooling-down fold falls back to dsh's own summary (`super.summarize()`) when the session's last
    request is at `fallbackRatio` (0.95) of the model's window or above.
  - The current CarryOn checkpoint is put in front of it; carriers and the execution context do not change.
  - The paper does not say what happens at the window limit. Without this, a session whose folds keep failing
    would overflow.
- **Retry conversation.** dsh request messages need durable ids for assistant turns. So a retry after an invalid
  reply is one user message: the original request, then "# Your previous reply", then "# Problem".
- **Model output leniency.** Integer fields accept decimal strings (`"12"`), like pydantic's lax mode, because
  models often quote step numbers.
- **Result envelope.** A fold returns the unmarked `SummaryResult` variant: two role calls, not one
  `ctx.llm.stream()` call. Its `usage` is the sum of both, and `provider`/`model` name the role model.

## Not done yet

- A run with a real model. `scripts/real.patch.yml` is ready for `deepseek-v4.1-flash` (directly or through Token
  Harbor).
- Grounder checks (carrycode M2). `CompileRequest.checks` is parsed and ignored.
- Web profile: CarryOn mode uses the same engine, but P2 was not re-checked in the Web UI.
