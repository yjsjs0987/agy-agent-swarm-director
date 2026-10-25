---
name: asd
description: "All-in-one ASD command (/asd): runs the full lifecycle - Socratic deep planning (/asd-plan), a single plan approval gate, autonomous parallel execution (/asd-run), and the final work summary (/asd-status) - in one flow."
---

# /asd — All-in-One: Plan → Approve → Run → Summarize

## Step 0 — Preflight

```
node "<ASD_CLI>" preflight --cmd asd --session <conversationId>
```

- `mode: "new_plan"` → continue to Step 1.
- `mode: "refine_plan"` → Step 1 runs in Plan Refinement Mode (existing `[x]`
  tasks are preserved; the interview focuses on what to refine, add, or
  re-scope).
- `mode: "locked_by_other_session"` → ask the user about
  `--force-takeover`, or suggest `/asd-status unlock`.

## Step 1 — Plan (full /asd-plan protocol)

Execute the complete planning protocol defined in
[skills/asd-plan/SKILL.md](../asd-plan/SKILL.md):

1. Pass 0 `flash_lite` scouting (`[SCAN]`) before asking the user anything.
2. X8 3-part frame interview: Current Project State → Understood Command with
   the ⚠️ correction callout → Questions & Options (includeTests, includeDebug,
   gitCheckpoint, learnings, profile).
3. Turn/Task decomposition → write `.asd/PLAN.md` → `lint` → `plan-import` →
   print the generated `.asd/TODO.md` block to the user.

## Step 2 — Single Plan Approval Gate

Present the finalized Turn plan and TODO.md and ask the user exactly once:

> 위 계획과 TODO 구성으로 병렬 실행(`/asd-run`)을 바로 시작할까요? (승인 시 완료될 때까지 자동으로 진행 및 오류 수정이 수행됩니다.)

- If the user's initial `/asd` prompt already explicitly requested autonomous
  execution (e.g. "알아서 끝까지 실행해줘", "자동으로 진행해"), record
  `autonomyGranted: true` via
  `node "<ASD_CLI>" phase set awaiting_approval --approve-autonomy` and proceed
  immediately without asking.

## Step 3 — Run (full /asd-run protocol)

Execute the complete execution protocol defined in
[skills/asd-run/SKILL.md](../asd-run/SKILL.md): Turn-by-Turn parallel subagent
dispatch (max 8 concurrent), live `.asd/TODO.md` printing every Turn,
independent Turn verification, dynamic `[FIX]` mutation on errors, and tier
escalation (`flash_lite` → `flash` → `pro` → `orchestrator`).

## Step 4 — Final Summary

When all Turns/Tasks are complete:

```
node "<ASD_CLI>" summary --notes "<final synthesis of changes, verified tests, and key outcomes>"
```

Then run the `/asd-status` report (see
[skills/asd-status/SKILL.md](../asd-status/SKILL.md)) to output the Final Work
Summary (`.asd/SUMMARY.md`) and the final `100% Done` TODO.md to the user.

## Rules

- `/asd-plan`, `/asd-run`, and `/asd-status` remain fully functional standalone
  commands — `/asd` composes them, it does not replace them.
- The approval gate is asked exactly once per `/asd` invocation.
- The Orchestrator never writes product code directly — it coordinates;
  subagents implement.
