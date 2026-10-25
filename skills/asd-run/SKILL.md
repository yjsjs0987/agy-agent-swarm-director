---
name: asd-run
description: "Autonomous low-cost parallel execution command (/asd-run). Verifies .asd/PLAN.md via preflight, dispatches up to 8 concurrent subagents per Turn using flash_lite/flash/pro according to budget profile, updates and prints .asd/TODO.md every Turn, verifies deliverables, and dynamically mutates TODO on errors."
---

# /asd-run: Autonomous Turn-by-Turn Parallel Execution

You are the Main Agent (Orchestrator) for this run. You coordinate, dispatch, verify, and report. You NEVER write product code yourself: all implementation, testing, debugging, and verification work is delegated to subagents. Your only direct writes are `.asd/` machine files via the ASD CLI and chat output to the user.

Throughout this skill, `<ASD_CLI>` is the workspace path to `scripts/asd.mjs`. Every CLI call is run as `node "<ASD_CLI>" <subcommand>` from the workspace root.

## Execution Loop

Run Steps 0 through 4 in order. Repeat Steps 1 through 3 once per Turn until `turn next` reports no remaining pending tasks, then run Step 4.

### Step 0: Preflight and Resume Check (X1)

1. Run:

   ```
   node "<ASD_CLI>" preflight --cmd run --session <id>
   ```

2. Run:

   ```
   node "<ASD_CLI>" phase set running --approve-autonomy
   ```

3. Interpret the preflight result:
   - `mode === "refuse_no_plan"`: STOP. No valid `.asd/PLAN.md` exists. Tell the user to run `/asd-plan` (to author a plan interactively) or `/asd` (for the full flow), and end the command.
   - Resuming an interrupted run (X1): announce "Resuming at Turn T<n>" to the user and print the current `.asd/TODO.md` block in chat before continuing.
   - Fresh run: announce the run is starting and continue to Step 1.

### Step 1: Turn Selection and Live TODO Output

1. Run:

   ```
   node "<ASD_CLI>" turn next --json
   ```

   This returns the current Turn `T<n>` and its batch of up to 8 independent tasks (`T<n>.1 .. T<n>.k`) with each task's `id`, `role`, `tier`, `files`, and `acceptance` criteria.

2. If the JSON reports no remaining pending tasks, skip to Step 4.

3. Mark every task in the batch as in-progress `[>]` by running, for each task id:

   ```
   node "<ASD_CLI>" task start <id>
   ```

4. Print the updated `.asd/TODO.md` block directly to the user in chat. The user must see the live TODO state at the start of every Turn.

### Step 2: Parallel Low-Cost Subagent Dispatch (X5, max 8 concurrent)

1. In a SINGLE turn, issue parallel `invoke_subagent` calls for ALL tasks in the current Turn batch (at most 8 at once). Do not serialize dispatches and do not wait for one subagent before launching the next.

2. For each task, set the subagent parameters exactly as follows:
   - `Model: "<task.tier>"` where `<task.tier>` is `"flash_lite"`, `"flash"`, or a plan-approved `"pro"` taken from the task's tier in `.asd/TODO.md`. NEVER pass `Model: "inherit"` on a routine worker dispatch: an inherited frontier model defeats the entire low-cost budget routing. `inherit` is only legal after a task has been escalated all the way to the orchestrator tier.
   - `Prompt`: built from the template in `references/subagent-roles.md`, prefixed with the header tags `[ASD_ROLE: <task.role>] [ASD_TASK: <task.id>]`, and strictly scoped to `task.files`. The subagent must not touch any file outside its SCOPE list.

3. Wait reactively for subagents to complete. NEVER poll, NEVER sleep, NEVER run a wait loop: subagent completion notifications arrive on their own and wake you. Any `sleep`/`while`/retry-until-done construct in the dispatch flow is a bug.

4. If a finished subagent lingers (kept alive by external global hooks), record its output first, then terminate it cleanly:

   ```
   manage_subagents(Action: "kill", ConversationIds: [<lingering conversation ids>])
   ```

Full dispatch details: `references/dispatch-protocol.md`.

### Step 3: Independent Turn Verification (X2) and Dynamic Error Recovery

1. Dispatch ONE independent verifier subagent (`Model: "flash_lite"`, or `Model: "flash"` when the plan's budget profile is `performance`) that checks ALL completed tasks in the Turn against their `acceptance` criteria AND confirms no out-of-scope files were modified. The verifier is read-only and must not fix anything itself.

2. If ALL tasks pass verification:
   - For each task, run:

     ```
     node "<ASD_CLI>" task done <id> --evidence <path-or-description>
     ```

   - If the plan option `gitCheckpoint` (X6) is enabled, run:

     ```
     node "<ASD_CLI>" checkpoint --turn <n>
     ```

   - If the plan option `learnings` (X7) is enabled and a reusable insight surfaced this Turn, run:

     ```
     node "<ASD_CLI>" learn --category <build|test|debug|repo> --note <insight>
     ```

   - Print the updated `.asd/TODO.md` block directly to the user in chat.
   - Immediately advance to the next Turn (back to Step 1) WITHOUT asking the human for permission. Autonomy was granted at preflight.

3. If ANY task fails verification or a subagent reports an error:
   - Run:

     ```
     node "<ASD_CLI>" task fail <id> --reason "<error>"
     ```

   - If the error requires a new prerequisite or bugfix step that is not in the original plan, dynamically mutate the TODO list:

     ```
     node "<ASD_CLI>" todo add --turn <n> --flag FIX --summary "<fix summary>" --files <csv> --acceptance "<criteria>"
     ```

     and record why the plan changed:

     ```
     node "<ASD_CLI>" amend --reason "<why the fix task was added>"
     ```

   - Print the updated `.asd/TODO.md` block to the user in chat.
   - Re-dispatch the failed task at the escalated tier following the ladder in `references/escalation-protocol.md` (`flash_lite` -> `flash` -> `pro` -> `orchestrator`), respecting the profile's `proCap`.
   - Only pause and ask the human when a task reaches `[!]` blocked after ALL escalation attempts (including the orchestrator tier) are exhausted. When pausing, print the current `.asd/TODO.md`, state which task is blocked and why, and stop.

### Step 4: Final Synthesis and Work Summary

1. When `turn next` reports no remaining pending tasks, synthesize all completed subagents' deliverables into a concise summary of changes, verified tests, and key outcomes.

2. Run:

   ```
   node "<ASD_CLI>" summary --notes "<concise synthesis of changes, verified tests, and key outcomes>"
   ```

   This generates `.asd/SUMMARY.md` and transitions the session `phase` to `done`.

3. Output the Final Work Summary plus the final `100% Done` `.asd/TODO.md` block directly to the user in chat.

## Hard Rules

- The Orchestrator NEVER writes product code during `/asd-run`. All code, tests, and fixes come from subagents. Orchestrator writes are limited to `.asd/` machine files via the ASD CLI.
- NEVER pass `Model: "inherit"` on routine worker dispatches.
- NEVER poll or sleep while waiting for subagents. Wait reactively.
- Print `.asd/TODO.md` to the user at the start of every Turn, after every verification pass, and after every TODO mutation.
- Advance between Turns autonomously; only pause for a `[!]` blocked task that exhausted the escalation ladder.
- References: `references/dispatch-protocol.md`, `references/escalation-protocol.md`, `references/subagent-roles.md`.

## MCP Tools (asd-mcp)

When the `asd` MCP server is connected, prefer its tools over the equivalent CLI invocations above: `asd_preflight` (Step 0), `asd_todo_mutate` with `action: "start" | "done" | "fail" | "add" | "update"` (Steps 1–3), and `asd_render_summary` (Step 4). In Step 3, run `asd_verify_turn` for the current Turn BEFORE marking tasks done: it compares the working tree against the Turn's `baselineSnapshot`, so files modified in earlier Turns or pre-existing dirty files are never false-flagged, and any file changed this Turn that is outside the tasks' declared `files[]` is reported in `outOfScopeFiles` (fail those tasks). The CLI commands remain the fallback when MCP is unavailable.

Subagent research tools (pass through in prompts when relevant): `context7` for official docs before coding external APIs, `grep_app` for production code examples, `websearch` for error debugging.
