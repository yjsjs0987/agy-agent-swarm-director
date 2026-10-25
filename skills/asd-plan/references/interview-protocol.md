# /asd-plan Interview Protocol

The Socratic Deep Grill: ask only what the scouts could not answer, always
show the recommended default first, and never ask about anything the repo
already proves. User-facing prose is Korean by default (`locale: "ko"`);
structural headings stay in English.

## X8 3-part frame (render on EVERY interview turn)

```markdown
### 1. 현재 프로젝트 상태 (Current Project State)
- <scout finding bullet>
- <scout finding bullet>
- preflight: <new_plan | refine_plan>

### 2. 현재 이해한 유저의 명령 설명 (Understood Command)
<one-paragraph restatement of what the user wants built/changed>

> ⚠️ 위 이해 내용이 의도와 다르거나 빠진 부분이 있다면 이 부분을 수정해 달라고 말씀해 주세요.

### 3. 심층 질문 및 플랜 옵션 (Questions & Options)
1. <question> (권장: <default>)
2. <question> (권장: <default>)
...
```

Rules:

- Part 1 is refreshed from scout results each turn; never stale.
- Part 2 restatement and the ⚠️ callout are mandatory and verbatim — the
  callout text is what `asd.mjs lint` looks for in PLAN.md section 2.
- Part 3 questions come from the 9 dimensions below, filtered to genuine
  owner-decisions. Use the `ask_question` UI where appropriate, recommended
  default first.

## The 9 Socratic coverage dimensions

Ask across all nine; skip a dimension only when scouts or the user's command
already answered it.

1. **목표와 범위 (Goal & Scope)** — What is in scope, what is explicitly out?
   Example: "이번 작업에서 명시적으로 제외할 기능이 있을까요? (권장: 없음)"
2. **완료 기준 (Acceptance Criteria)** — How do we know it is done?
   Example: "완료 판단 기준을 하나의 문장으로 정의해 주실 수 있나요?"
3. **기술 스택과 제약 (Stack & Constraints)** — Fixed stack choices,
   version pins, forbidden dependencies.
   Example: "기존 라이브러리만 사용해야 할까요, 새 의존성 추가를 허용할까요? (권장: 기존 라이브러리)"
4. **영향 범위 (Affected Files & Modules)** — Which modules/files will this
   touch? Any file two tasks in the same Turn must not both edit?
   Example: "이 변경이 src/api 외에 다른 디렉터리에도 영향을 주나요?"
5. **데이터와 스키마 (Data & Schema Changes)** — Migrations, config changes,
   persisted formats.
   Example: "저장 포맷이나 설정 파일이 바뀌어야 하나요? (권장: 아니요)"
6. **테스트 전략 (Testing Strategy)** — What must be tested, at what level?
   Example: "새 엔드포인트에 통합 테스트를 작성할까요? (권장: 예)"
7. **위험과 롤백 (Risk & Rollback)** — What can break, how do we roll back?
   Example: "배포 전 되돌릴 수 없는 변경이 포함되어 있나요?"
8. **성능과 보안 (Performance & Security)** — Latency budgets, auth,
   input-validation requirements.
   Example: "이 엔드포인트에 인증이 필요한가요? (권장: 기존 미들웨어 재사용)"
9. **호환성과 마이그레이션 (Compatibility & Migration)** — Backward
   compatibility, deprecation windows, consumer impact.
   Example: "기존 API 소비자와의 호환성을 유지해야 하나요? (권장: 예)"

## Plan options (ask exactly once, in part 3 of the frame)

| Option | Question | Default |
|---|---|---|
| `includeTests` | `[TEST]` 턴을 계획에 포함할지 여부 | `true` (권장) |
| `includeDebug` | `[DEBUG]` 턴을 포함할지 여부 | `false` (사전 계획 대상 아님; 런타임에 `amend`로 추가) |
| `gitCheckpoint` | 매 턴 완료 시 자동 커밋 생성 여부 | `true` (권장) |
| `learnings` | `.asd/learnings.md` 학습 메모리 기록/재활용 여부 | `true` (권장) |
| `profile` | 모델 예산 프로필 | `balanced` (권장: `flash_lite` 탐색 + `flash` 구현 + 핵심 `pro` 최대 2회); `eco` = `pro` 0회 초절약; `performance` = `flash` 탐색 + `pro` 최대 6회 |

The chosen values must appear verbatim in PLAN.md section 3 as
`- <key>: true|false` / `- profile: eco|balanced|performance` lines.

## Plan Refinement Mode interview

When preflight returns `refine_plan`:

- Announce **계획 구체화 모드 (Plan Refinement Mode)** first.
- Load `.asd/PLAN.md`, `.asd/TODO.md`, `.asd/learnings.md` before asking
  anything; summarize current progress (`[x]` vs open tasks) in part 1.
- Part 3 questions target the delta only: what to refine, add, or re-scope.
- Never drop or rewrite `[x]` completed task rows — `plan-import` preserves
  completed status only for task ids that still exist in the new PLAN.md.
- Confirm explicitly which existing Turns/Tasks change and which stay.
