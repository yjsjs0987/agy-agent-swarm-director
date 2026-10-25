# ASD Dispatch Protocol (X5)

How `/asd-run` composes and launches parallel subagent batches. Companion to `SKILL.md` Step 2 and `subagent-roles.md`.

## Batch composition

1. Run `node "<ASD_CLI>" turn next --json`. The JSON payload identifies the current Turn `T<n>` and its batch of up to 8 independent tasks (`T<n>.1 .. T<n>.k`). Tasks in one Turn never depend on each other, so the whole batch is dispatchable simultaneously.
2. Cap the batch at 8 concurrent `invoke_subagent` calls (`maxConcurrent: 8`). If a Turn ever lists more than 8 tasks, dispatch the first 8 and queue the rest for the next dispatch wave within the same Turn.
3. Before dispatching, mark every task in the batch as in-progress via `node "<ASD_CLI>" task start <id>` and print the updated `.asd/TODO.md` to the user.

## Model / tier mapping

| Task tier from `turn next --json` | `Model` parameter on `invoke_subagent` |
|---|---|
| `flash_lite` | `"flash_lite"` |
| `flash` | `"flash"` |
| `pro` | `"pro"` (only when the plan's budget profile permits it, see below) |

- The `Model` parameter MUST exactly match the task's tier. Never `Model: "inherit"` on a routine worker dispatch: inherited frontier models destroy the low-cost budget routing. `inherit` is reserved for tasks escalated to the orchestrator tier after exhausting the subagent ladder.
- `pro` dispatches are gated by the profile's `proCap` (eco: 0, balanced: 2, performance: 6). If the tier says `pro` but the profile's pro budget is exhausted, the CLI's routing layer downgrades to `flash` and reports a warning; honor whatever tier `turn next --json` reports on re-entry.

## Prompt template

Build every prompt from the template in `subagent-roles.md`:

```
[ASD_ROLE: <task.role>] [ASD_TASK: <task.id>]

TASK:
<one-sentence statement of the work>

DELIVERABLE:
<exact expected result: files created/changed, test outcome>

SCOPE (ALLOWED FILES ONLY):
- <workspace-relative path from task.files>
- ...

VERIFY:
<command to run> -> <expected exit code>
```

- The `[ASD_TASK: T<n>.<m>]` id MUST match the TODO row being executed.
- The SCOPE list is exactly `task.files` from `turn next --json`. It is exhaustive: a subagent never touches a file not in its SCOPE list.
- Roles: scout (read-only exploration), worker (implement + test), verifier (read-only acceptance check), debugger (root-cause then fix). See `subagent-roles.md` for the full role/tier table.

## Launch discipline

- Issue ALL `invoke_subagent` calls for the batch in a SINGLE turn. Serializing dispatches (launch one, wait, launch the next) wastes wall-clock time and defeats X5.
- One `invoke_subagent` call per task, `Model` set per the mapping above, prompt built per the template above.

## Reactive waiting

- Wait reactively: subagent completion notifications wake the Main Agent on their own.
- NEVER poll. NEVER sleep. NEVER run a wait/retry loop around subagent status. Any construct that periodically checks whether subagents finished is a protocol violation: it burns tokens and turns a cheap parallel run into a busy-loop.

## Lingering subagent cleanup

- Some environments keep finished subagents alive via external global hooks. When a subagent has returned its output but its conversation lingers:
  1. Record the subagent's output (deliverables, verification results, evidence) in the Turn's working notes first.
  2. Then terminate it cleanly: `manage_subagents(Action: "kill", ConversationIds: [<conversation ids of the lingering subagents>])`.
- Never kill a subagent before its output is recorded.
