---
name: asd-status
description: "ASD session status and control command (/asd-status). Shows the active session, phase, budget profile, Turn progress, and subagent tier counts, prints .asd/TODO.md verbatim, and supports pause / resume / rollback <turn> / unlock subcommands."
---

# /asd-status — Session Status & Control

## Step 0 — Preflight

Run:

```
node "<ASD_CLI>" preflight --cmd status --session <conversationId>
```

If the session is locked by another conversation, the preflight result says
`locked_by_other_session` — offer `/asd-status unlock` (see Subcommands).

## Step 1 — Report

Display to the user:

- Active session ID (`.asd/session.json` → `mainConversationId`)
- Current phase (`state.phase`) and budget profile (`state.profile`)
- Turn progress: current Turn `T<n>` and done/total task counts
- Subagent dispatch counts by model tier (`state.counters`:
  `flash_lite` / `flash` / `pro` / `orchestrator`)
- Any `state.lintErrors`
- The exact contents of `.asd/TODO.md`, printed verbatim in a fenced code block

Never guess or embellish — report only what the state files actually say.

## Subcommands

- `/asd-status pause` → `node "<ASD_CLI>" phase set paused`
- `/asd-status resume` → transition directly into the `/asd-run` protocol
  (see [skills/asd-run/SKILL.md](../asd-run/SKILL.md))
- `/asd-status rollback <turn>` → `node "<ASD_CLI>" rollback --turn <turn>`
  (X6: restores the working tree to that Turn's checkpoint commit and resets
  later Turns' tasks to `[ ]`; only runs when the user explicitly asks)
- `/asd-status unlock` → `node "<ASD_CLI>" preflight --cmd status --force-takeover`
  (reclaims a locked `.asd/session.json` when the holder is stale or the user
  confirms takeover)

## Rules

- Never modify `.asd/` machine files by hand — all mutations go through
  `<ASD_CLI>` subcommands.
- `rollback` is destructive: confirm the target Turn with the user before
  running it.
