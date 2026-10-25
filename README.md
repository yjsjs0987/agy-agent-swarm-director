# ASD (Agent Swarm Director)

**A**rchitect · **S**pawn · **D**elegate

Antigravity용 오케스트레이션 플러그인. 프론티어 모델이 소크라틱 질문으로 요구사항을 꼼꼼히 캐물어 계획을 세우고, 승인 한 번 이후에는 모든 구현·테스트·검증을 저비용 서브에이전트(`flash_lite` / `flash`, 필요할 때만 제한된 `pro`)에 병렬로 위임합니다.

## 왜 `asd`인가

`asd`는 왼손 홈 행(손가락이 자판에 놓이는 기본 자리)의 첫 세 글자입니다. 손 위치를 흐트리지 않고 입력할 수 있어 자주 호출해도 편하고, `wer`처럼 상단 행을 오가는 조합과 달리 행 이동으로 인한 오타가 적습니다. 명령어 접두사(`/asd`), 프로젝트 관리 폴더(`.asd/`), 플러그인 이름(`asd`)을 모두 하나로 통일했습니다.

## 요구 사항

- Node.js >= 20
- npm 의존성 0개 (Node 내장 모듈만 사용하는 순수 ESM)

## 설치

GitHub에서 바로 설치:

```bash
agy plugin install https://github.com/<owner>/agent-swarm-director
```

복제 후 설치:

```bash
git clone https://github.com/<owner>/agent-swarm-director asd
agy plugin install ./asd
```

`<owner>`는 실제 저장소 소유자(또는 본인 포크)로 바꾸세요.

로컬 개발용 링크 설치:

```bash
node scripts/install.mjs install --scope global --mode link
```

- `--scope global`: `~/.gemini/config`의 `plugins.json`에 이 플러그인의 상위 디렉터리를 등록합니다.
- `--scope workspace` (기본값): 현재 작업공간의 `.agents` 디렉터리에 등록합니다.
- 등록 상태 확인: `node scripts/install.mjs status`

## 명령어

| 명령어 | 역할 |
|--------|------|
| `/asd` | 올인원: 소크라틱 계획 → 사용자 승인 1회 → 자율 실행 → 상태 리포트까지 하나의 흐름으로 수행 |
| `/asd-plan` | 계획 전용. 인터뷰를 거쳐 `.asd/PLAN.md`와 `.asd/TODO.md`를 저작 |
| `/asd-run` | 실행 전용. 턴마다 최대 8개 서브에이전트를 병렬로 dispatch하고 독립 검증 후 자동으로 다음 턴 진행 |
| `/asd-status` | 진행 상황 조회와 세션 라이프사이클 제어 |

`/asd-status`에서 쓰는 세션 제어. `<ASD_CLI>`는 이 플러그인의 `scripts/asd.mjs` 경로입니다:

| 동작 | 명령 |
|------|------|
| 일시정지 | `node "<ASD_CLI>" phase set paused` |
| 재개 | `node "<ASD_CLI>" phase set running` (이후 `/asd-run` 호출 시 중단 지점부터 이어서 실행) |
| 특정 턴으로 되돌리기 | `node "<ASD_CLI>" rollback --turn <n>` (해당 턴 체크포인트로 되돌리고 이후 턴은 대기 상태로 초기화) |
| 잠긴 세션 강제 인계 | `node "<ASD_CLI>" preflight --cmd status --session <id> --force-takeover` |

## `.asd/` 디렉터리 구조

모든 상태는 작업공간의 `.asd/` 폴더에 저장되며, 최초 `/asd*` 명령 호출 시 자동 생성됩니다.

| 경로 | 내용 | 관리 주체 |
|------|------|-----------|
| `PLAN.md` | 6섹션 계획서 (현재 상태, 이해 내용, 인터뷰·옵션, 턴/작업 실행 계획, 검증 기준, 실행 중 수정) | 오케스트레이터 (lint 검증) |
| `TODO.md` | 턴/작업 체크리스트. 매 턴 사용자에게 그대로 출력 | ASD CLI 전용 (기계 파일) |
| `state.json` | 작업 상태, 예산 프로필, 티어 카운터 | ASD CLI 전용 (기계 파일) |
| `session.json` | 세션 소유권과 잠금 | ASD CLI 전용 (기계 파일) |
| `interview.md` | 소크라틱 인터뷰 기록 | 오케스트레이터 (lint 검증) |
| `learnings.md` | 재사용 가능한 학습 메모 (계획 옵션으로 활성화) | 오케스트레이터 (lint 검증) |
| `ledger.jsonl` | 작업 이벤트 원장 (시작/완료/실패) | ASD CLI |
| `history/` | 계획 변경 시 이전 PLAN/TODO 스냅샷 | ASD CLI |
| `SUMMARY.md` | 실행 완료 시 생성되는 최종 요약 | ASD CLI |

`.asd/.gitignore`가 `session.json`, `ledger.jsonl`, `*.lock`, `*.tmp`를 자동 제외하므로 세션 정보가 저장소에 커밋되지 않습니다.

**세션 잠금.** `.asd/session.json`이 현재 대화(conversationId)를 소유합니다. 다른 대화에서 `/asd*` 명령을 호출하면, 30분 이상 비활동이거나 종료된 세션이면 자동으로 인계하고, 활성 세션이면 `lockConflict`를 보고합니다. 강제 인계는 `--force-takeover`로만 가능합니다.

## TODO.md 엄격한 형식

모든 작업 줄은 아래 문법을 정확히 따라야 하며, 어긋나면 `asd lint`가 거절합니다.

```
- [<status>] [<FLAG>] T<turn>.<task> <요약 1..40자> · <tier>
```

7개 플래그:

| 플래그 | 역할 | 기본 배정 |
|--------|------|-----------|
| `[SCAN]` | 코드베이스·자료 탐색 | scout · `flash_lite` |
| `[PLAN]` | 계획 보조 | planner |
| `[BUILD]` | 구현 | worker · `flash` |
| `[TEST]` | 테스트 작성·실행 | worker · `flash` |
| `[DEBUG]` | 디버깅 | debugger · `flash` |
| `[VERIFY]` | 독립 검증 | verifier · `flash_lite` |
| `[FIX]` | 실행 중 오류 발생 시 동적 삽입되는 수정 작업 | worker |

5개 상태:

| 표기 | 의미 |
|------|------|
| `[ ]` | 대기 |
| `[>]` | 진행 중 |
| `[x]` | 완료 |
| `[!]` | 차단 (에스컬레션 사다리 소진) |
| `[~]` | 보류 |

예시:

```
- [x] [SCAN] T1.1 저장소 구조 탐색 · flash_lite
- [>] [BUILD] T1.2 진입점 리팩터링 · flash
- [ ] [TEST] T1.3 단위 테스트 추가 · flash
```

## 예산 프로필

계획 단계에서 세 가지 프로필 중 하나를 선택합니다.

| 프로필 | 성격 | `pro` 상한 |
|--------|------|-----------|
| `eco` | 최대 절약. 탐색·검증은 `flash_lite`, 구현도 저비용 티어 우선 | 0 |
| `balanced` | 기본값. 구현·디버깅은 `flash`, `pro`는 심층 추론 작업에만 | 2 |
| `performance` | 고성능. `pro` 적극 허용 | 6 |

작업이 실패하면 `flash_lite` → `flash` → `pro` → 오케스트레이터 순서로 티어를 올리며 재시도하고, 프로필의 `pro` 상한을 넘을 수 없습니다. 모든 재시도가 소진되면 해당 작업을 `[!]` 차단으로 표시하고 사용자에게 보고합니다.

## 안전장치 (하이브리드 훅 가드)

5개 라이프사이클 훅이 실행 내내 흐름을 지킵니다.

- **PreToolUse 가드**: `.asd/TODO.md`, `state.json`, `session.json` 같은 기계 파일의 직접 쓰기를 차단하고, 실행 모드에서 오케스트레이터가 직접 구현하는 것을 차단하며, 서브에이전트 호출의 `Model` 파라미터 누락·위반을 차단합니다. 훅 출력은 중립 통과 또는 거절뿐이며 어떤 경로에서도 허용 결정을 내리지 않습니다. 훅 자체 오류는 fail-open으로 동작해 대화를 막지 않습니다.
- **Stop 가드**: 메인 세션은 남은 작업이 있으면 계속 진행하고, 서브에이전트는 언제든 자유롭게 종료할 수 있도록 격리합니다.
- **서브에이전트 격리**: 각 서브에이전트는 자신의 작업에 지정된 `files` 목록 안의 파일만 다룰 수 있습니다.
- **서킷 브레이커**: 진전 없는 반복이 프로필 한도를 넘으면 자동으로 중단하고 사용자에게 보고합니다.

## Quick Start (English)

ASD (Agent Swarm Director) is an Antigravity orchestration plugin. A frontier model grills your requirements through a Socratic interview and writes a strict plan; after a single approval, all implementation, testing, and verification run as parallel low-cost subagents (`flash_lite` / `flash`, with capped `pro`).

Requirements: Node.js >= 20, zero npm dependencies.

Install from GitHub (replace `<owner>` with the actual repository owner):

```bash
agy plugin install https://github.com/<owner>/agent-swarm-director
```

Then, in any project:

| Command | What it does |
|----------|--------------|
| `/asd` | All-in-one: plan, single approval, run, status |
| `/asd-plan` | Socratic planning only (authors `.asd/PLAN.md` and `.asd/TODO.md`) |
| `/asd-run` | Autonomous turn-by-turn parallel execution (up to 8 subagents per turn) |
| `/asd-status` | Progress report plus pause / resume / rollback / unlock controls |

All state lives under `.asd/` in your project. Machine-managed files (`TODO.md`, `state.json`, `session.json`) are written only by the ASD CLI; a PreToolUse hook blocks direct writes and never issues an allow decision.

## 라이선스

MIT
