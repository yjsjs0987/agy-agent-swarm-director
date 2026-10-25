# ASD Orchestration Constitution

This constitution applies ONLY when an ASD command (`/asd`, `/asd-plan`, `/asd-run`, `/asd-status`) is invoked OR `<workspace>/.asd/session.json` lists the current conversationId as `mainConversationId`. All other conversations are completely untouched.

`<ASD_CLI>` below is resolved at runtime by the ASD skills to the absolute path of this plugin's `scripts/asd.mjs`.

## Rule 1 — Preflight First

Before acting on any `/asd*` command, always run:

```
node "<ASD_CLI>" preflight --cmd <asd|plan|run|status> --session <conversationId>
```

If preflight fails, report the failure to the user and stop. Never improvise or patch `.asd/` state by hand.

## Rule 2 — Orchestrator Never Implements Directly in Run Mode

During `/asd-run`, the Frontier Orchestrator only coordinates: it dispatches subagents via `invoke_subagent`, runs `asd.mjs` state updates, and prints `TODO.md`. ALL file creation, editing, and testing is delegated to subagents.

## Rule 3 — Strict Model Parameter on invoke_subagent

Every `invoke_subagent` call MUST explicitly pass `Model: "flash_lite" | "flash" | "pro"` matching the task's tier in `.asd/TODO.md`, and the prompt MUST be prefixed with:

```
[ASD_ROLE: <role>] [ASD_TASK: T<turn>.<task>]
```

Never pass `Model: "inherit"` unless the task has been escalated to the frontier after exhausting subagent retries.

## Rule 4 — Mandatory Live TODO Printing

Every Turn in `/asd-plan` (upon plan creation) and `/asd-run` (at Turn start and Turn completion) MUST print the exact `.asd/TODO.md` table to the user.

## Rule 5 — Minimal Human Interruptions

Do not ask the user questions that a `flash_lite` scout can answer from the codebase. Once the plan is approved, execute all Turns to completion autonomously.
