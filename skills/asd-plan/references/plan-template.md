# /asd-plan PLAN.md Template

The complete, lint-passing `.asd/PLAN.md` example. Copy the fenced block
below as the starting point, then fill every section from the interview
answers. `node "<ASD_CLI>" lint` must exit 0 before `plan-import`.

Format contract (enforced by `scripts/asd.mjs lint` via
`scripts/lib/render.mjs` / `scripts/lib/schema.mjs`):

- The 6 English headings, exact text, in order.
- Section 2 must contain the Korean correction callout (or a ⚠️ line).
- Section 3 must declare `- includeTests: true|false`,
  `- includeDebug: true|false`, `- gitCheckpoint: true|false`,
  `- learnings: true|false`, and `- profile: eco|balanced|performance`
  explicitly.
- Section 4 rows: one TODO-grammar line
  `- [<status>] [<FLAG>] T<turn>.<task> <summary ≤ 40 chars> · <tier>`,
  followed by `  files: <comma-separated paths or ->` and
  `  meta: category=<cat> · difficulty=<diff>`.
  Valid flags: `SCAN|PLAN|BUILD|TEST|DEBUG|VERIFY|FIX`; valid tiers:
  `flash_lite|flash|pro|orchestrator`; valid categories:
  `repo-explore|external-research|multimodal|writing|frontend-ui|verification|general`;
  valid difficulties: `reasoning-none|reasoning-low|reasoning-medium|reasoning-deep`.
- `[TEST]` rows require `includeTests: true`; `[DEBUG]` rows require
  `includeDebug: true`. No file may appear in two tasks of the same Turn
  (`DUPLICATE_FILE_IN_TURN`).

## Example (extract this block verbatim into `.asd/PLAN.md`)

```markdown
<!-- ASD-PLAN-V1: managed by scripts/asd.mjs -->
# ASD PLAN — Add user profile API (add-user-profile)

## 1. Current Project State
Node 20+ ESM 프로젝트. src/api/에 REST 엔드포인트, tests/에 node --test 기반 테스트가 있다. 인증은 src/middleware/auth.js의 공통 미들웨어 사용. preflight 결과: new_plan (.asd/ 신규 초기화).

## 2. Understood User Command
사용자 프로필 조회/수정 REST API(GET /api/profile, PATCH /api/profile)를 추가한다. 검증 로직은 src/lib/validate.js의 공통 함수로 분리하고, 기존 인증 미들웨어를 재사용한다.

> ⚠️ 위 이해 내용이 의도와 다르거나 누락된 부분이 있다면 지적해 주세요. 수정 후 진행합니다.

## 3. Interview & Options
### 질문 (Questions)
1. 프로필 스키마 필드(displayName, bio, avatarUrl)를 이대로 확정할까요? (권장: 예)
2. PATCH는 부분 업데이트로 동작할까요? (권장: 예)
3. 기존 인증 미들웨어를 그대로 재사용할까요? (권장: 예)

### 옵션 (Options)
- includeTests: true
- includeDebug: false
- gitCheckpoint: true
- learnings: true
- profile: balanced
- locale: ko

## 4. Turn & Task Execution Plan
### Turn 1: Foundation
- [ ] [SCAN] T1.1 scout api and validate layout · flash_lite
  files: -
  meta: category=repo-explore · difficulty=reasoning-none
- [ ] [BUILD] T1.2 implement profile endpoint · flash
  files: src/api/profile.js, src/lib/validate.js
  meta: category=general · difficulty=reasoning-medium

### Turn 2: Verification
- [ ] [TEST] T2.1 write profile endpoint tests · flash
  files: tests/profile.test.js
  meta: category=verification · difficulty=reasoning-low
- [ ] [VERIFY] T2.2 verify endpoint against criteria · flash
  files: -
  meta: category=verification · difficulty=reasoning-low

## 5. Verification & Completion Criteria
- node --test tests/profile.test.js 전량 통과
- GET/PATCH /api/profile가 합의된 스펙대로 동작 (수동 호출로 확인)

## 6. Runtime Amendments
(none)
```

## Field notes

- Statuses: `[ ]` pending, `[>]` in progress, `[x]` done, `[!]` failed,
  `[~]` skipped. New plans use `[ ]` everywhere.
- `files: -` means "no files" (`none` / `(none)` / empty also accepted).
- Turn titles are free text after `### Turn <n>: `.
- Section 5 criteria become the `[VERIFY]` task acceptance references.
- Section 6 starts as `(none)`; `asd.mjs amend` appends runtime changes.
