# ASD Subagent Prompt Template

Every subagent dispatched by `/asd-run` receives a prompt built from this exact template. The `Model` parameter on `invoke_subagent` plus the header tags carry all routing, so `/asd-run` works identically whether the `agents/*.md` personas or built-in subagent types are invoked (per `docs/runtime-contract.md` R5: plugin `agents/*.md` discovery is unverified; the explicit `Model` parameter is the reliable path).

## Template

```
[ASD_ROLE: <role>] [ASD_TASK: T<turn>.<task>]

TASK:
<one-sentence statement of the work>

DELIVERABLE:
<exact expected result: files created/changed, test outcome>

SCOPE (ALLOWED FILES ONLY):
- <workspace-relative path>
- ...

VERIFY:
<command to run, e.g. node --test tests/<x>.test.mjs> -> <expected exit code>
```

## Roles and tiers

| Role | Model | Duty |
|------|-------|------|
| scout | flash_lite | read-only codebase exploration, structured findings |
| worker | flash | implement + unit test within SCOPE |
| verifier | flash_lite | independent acceptance check, read-only |
| debugger | flash | root-cause diagnosis, then fix within SCOPE |

## Rules

- `Model` on `invoke_subagent` MUST match the task's tier in `.asd/TODO.md`. Never `inherit` unless the task was escalated to the frontier after exhausting subagent retries.
- The `[ASD_TASK: T<n>.<m>]` id MUST match the TODO row being executed.
- SCOPE lists are exhaustive: a subagent never touches a file not in its SCOPE list.
