---
name: asd-plan
description: "Deep Socratic planning command (/asd-plan). Checks for existing .asd/ files (entering Plan Refinement Mode if present), scans the repo with flash_lite scouts, interviews the user with the 3-part State/Intent/Questions frame, and creates .asd/PLAN.md and .asd/TODO.md divided into parallelizable Turns and Tasks."
---

# /asd-plan — Deep Socratic Planning

Run when the user invokes `/asd-plan` or asks to create or refine an ASD plan.
Output: `.asd/PLAN.md` and `.asd/TODO.md`. Nothing else.

`<ASD_CLI>` below is this plugin's `scripts/asd.mjs`. Resolve it at runtime
relative to this skill's plugin root (`../../scripts/asd.mjs` from
`skills/asd-plan/SKILL.md`); never hardcode an absolute path.

## Hard constraints

- **Never edit, create, or delete project source files outside `.asd/`.**
  This command plans; it does not implement. The only permitted writes are
  `.asd/PLAN.md` (a markdown artifact you author) and files produced by
  `asd.mjs` subcommands.
- Machine-managed files (`.asd/TODO.md`, `.asd/state.json`,
  `.asd/session.json`) are written exclusively by `asd.mjs`. Never write them
  with file tools directly.
- Structural headings and phase flags stay in English; user-facing prose
  defaults to Korean (`locale: "ko"`, switchable to `"en"`).

## Step 0 — Preflight & `.asd/` check

Run:

```
node "<ASD_CLI>" preflight --cmd plan --session <conversation-id>
```

- `mode === "refine_plan"`: announce **계획 구체화 모드 (Plan Refinement
  Mode)** to the user. Load the existing `.asd/PLAN.md`, `.asd/TODO.md`, and
  `.asd/learnings.md` (if present). Focus the interview on what the user
  wants to refine, add, or re-scope. Never lose `[x]` completed tasks: keep
  their rows unchanged (section 4) — `plan-import` preserves `status: "x"`
  on matching task ids, but only if the rows still exist.
- `mode === "new_plan"`: initialize the workspace:

  ```
  node "<ASD_CLI>" init --slug <slug> --title <title>
  ```

  Derive `<slug>` (kebab-case) and `<title>` from the user's command. This
  creates `.asd/`, `.asd/state.json`, `.asd/session.json`, and
  `.asd/TODO.md`.

## Step 1 — Pass 0 automated `flash_lite` scouting

Before asking the user ANY question, dispatch 1–3 parallel
`invoke_subagent` calls with `Model: "flash_lite"`:

1. Project structure scout: directory layout, entry points, module graph.
2. Tech-stack scout: languages, frameworks, build/test commands, configs.
3. (Optional) Test scout: existing test locations, conventions, coverage.

Also read `.asd/learnings.md` if present and fold prior learnings into the
scout summary. Keep scout prompts read-only; scouts must not write files.

## Step 2 — Socratic Deep Grill with the X8 3-part frame

Every interview turn renders the 3-part frame below to the user (exact
template and question bank: [interview-protocol.md](./references/interview-protocol.md)).

1. `### 1. 현재 프로젝트 상태 (Current Project State)` — concise bullets from
   the scouts plus the preflight status (`new_plan` / `refine_plan`).
2. `### 2. 현재 이해한 유저의 명령 설명 (Understood Command)` — explicit
   restatement of what the user wants built or changed, followed by the
   mandatory callout, verbatim:

   > ⚠️ 위 이해 내용이 의도와 다르거나 빠진 부분이 있다면 이 부분을 수정해 달라고 말씀해 주세요.

3. `### 3. 심층 질문 및 플랜 옵션 (Questions & Options)` — Socratic questions
   for genuine owner-decisions across the 9 coverage dimensions (use the
   `ask_question` UI where appropriate; always show the recommended default
   first), PLUS the mandatory plan options, asked exactly once:

   - **테스트 포함 여부 (`includeTests`)**: `[TEST]` 턴을 계획에 포함할지 여부
   - **디버깅 턴 포함 여부 (`includeDebug`)**: `[DEBUG]` 턴을 포함할지 여부
   - **턴별 Git 체크포인트 (`gitCheckpoint`)**: 매 턴 완료 시 자동 커밋 생성 여부
   - **학습 메모리 (`learnings`)**: `.asd/learnings.md` 기록 및 재활용 여부
   - **모델 예산 프로필 (`profile`)**: `Balanced` (권장 기본: `flash_lite`
     탐색 + `flash` 구현 + 핵심 `pro` 최대 2회) / `Eco` (`pro` 0회,
     초절약) / `Performance` (`flash` 탐색 + `pro` 최대 6회)

Repeat interview turns until all ambiguities the scouts could not answer are
resolved. In Plan Refinement Mode, focus questions on the delta only.

## Step 3 — Turn & Task decomposition and format-enforced generation

1. Divide the work into sequential **Turns (`T1..Tn`)**; within each Turn,
   up to 8 parallel **Tasks (`T<turn>.<task>`)**. `files[]` must not overlap
   within a Turn (`asd.mjs lint` rejects duplicates with
   `DUPLICATE_FILE_IN_TURN`).
2. Always include deliverable/code creation (`[BUILD]`). Include `[TEST]`
   and `[DEBUG]` turns according to the user's answers (lint rejects `[TEST]`
   rows when `includeTests: false` and `[DEBUG]` rows when
   `includeDebug: false`). Include `[VERIFY]` for independent turn
   verification.
3. Write `.asd/PLAN.md` following [plan-template.md](./references/plan-template.md)
   exactly: the 6 English headings in order, the section-2 correction
   callout, explicit `- includeTests: true|false` / `- includeDebug:` /
   `- gitCheckpoint:` / `- learnings:` / `- profile: eco|balanced|performance`
   lines in section 3, and section-4 rows as a TODO-grammar line plus a
   `files:` CSV line plus a `meta: category=... · difficulty=...` line per
   task (summary ≤ 40 chars).
4. Run `node "<ASD_CLI>" lint`. Fix every reported error in PLAN.md and
   re-run until it exits 0.
5. Run `node "<ASD_CLI>" plan-import`. This merges options/turns/tasks into
   `.asd/state.json` and regenerates `.asd/TODO.md`.
6. **Print the generated `.asd/TODO.md` block to the user verbatim**, then
   ask for approval before any `/asd-run` dispatch.

## Verification checklist

- `node "<ASD_CLI>" lint` exits 0.
- `node "<ASD_CLI>" plan-import` exits 0 and `.asd/TODO.md` exists with one
  grammar-valid line per planned task.
- No file outside `.asd/` was touched.
