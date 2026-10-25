# ASD Escalation Protocol (X2)

The failure-handling ladder for `/asd-run`. Companion to `SKILL.md` Step 3. The ladder mirrors `resolveNextEscalation` in `scripts/lib/routing.mjs`: `flash_lite` -> `flash` -> `pro` -> `orchestrator` -> `[!]` blocked.

## When a task fails

When the Turn verifier rejects a task, or a dispatched subagent reports an error:

1. Record the failure:

   ```
   node "<ASD_CLI>" task fail <id> --reason "<error>"
   ```

   The CLI applies the escalation ladder internally: the task's tier moves up one rung (`flash_lite` -> `flash` -> `pro` -> `orchestrator`) and the failure is logged. A task is marked `[!]` blocked when the ladder returns `blocked` (orchestrator attempt failed, or the ladder exhausted with no next tier).

2. If the error requires a new prerequisite or bugfix step that the original plan does not contain, mutate the TODO list:

   ```
   node "<ASD_CLI>" todo add --turn <n> --flag FIX --summary "<fix summary>" --files <csv> --acceptance "<criteria>"
   ```

   and record the plan change:

   ```
   node "<ASD_CLI>" amend --reason "<why the fix task was added>"
   ```

   The `FIX` flag maps to the `worker` role. Give the fix task a summary of 40 characters or fewer.

3. Print the updated `.asd/TODO.md` to the user in chat, then re-dispatch the failed task at its new escalated tier (the tier `turn next --json` now reports for it).

## The ladder, rung by rung

| Current tier | On failure, next tier | Notes |
|---|---|---|
| `flash_lite` | `flash` | Straight escalation, always available. |
| `flash` | `pro` | Only if the profile's pro budget allows (see below); otherwise the task retries at `flash` with diagnostic context appended, then escalates to `orchestrator` when attempts are exhausted. |
| `pro` | `orchestrator` | Pro attempt failed; escalate to the orchestrator tier. |
| `orchestrator` | none: `[!]` blocked | Terminal. The task row renders as `[!]` with `· orchestrator`. |

## Pro-cap awareness per budget profile

The `pro` rung is gated by the profile's `proCap` (concurrent/used pro budget):

| Profile | proCap | Behavior |
|---|---|---|
| eco | 0 | `pro` is never dispatched; the ladder skips from `flash` retries straight to `orchestrator`. |
| balanced | 2 | Up to 2 pro dispatches; beyond that, `flash` retries then `orchestrator`. |
| performance | 6 | Up to 6 pro dispatches. |

When the CLI downgrades or denies `pro`, it emits a warning naming the profile and the `proUsed/proCap` counts. Honor the tier that `turn next --json` reports on re-entry: never hand-pick a higher tier than the CLI assigned.

## Re-dispatch rules

- Re-dispatch at exactly the tier the CLI assigned after `task fail`. The prompt keeps the same `[ASD_ROLE]`/`[ASD_TASK]` header and SCOPE, plus a short diagnostic context section describing what the previous attempt got wrong.
- A `FIX` task added via `todo add --flag FIX` is dispatched like any other task, at the tier the CLI resolves for it.
- Never re-dispatch a `[!]` blocked task on your own initiative.

## When to pause for the human

Only one condition pauses `/asd-run`: a task reaches `[!]` blocked after ALL escalation attempts, including the orchestrator tier, are exhausted. When that happens:

1. Print the current `.asd/TODO.md` to the user.
2. State which task is blocked, the failure history, and what decision or input you need from the human.
3. Stop. Do not continue later Turns while a block is unresolved unless the blocked task's Turn-mates are fully independent and the user has been informed.

Every other failure is handled autonomously inside the loop: fail, mutate TODO if needed, re-dispatch at the escalated tier, verify again.
