// @ts-check
import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  validateSession,
  validateState,
  validateTask,
  validateTodoLine,
  validatePlanMarkdown,
  validateInterviewMarkdown,
} from "../scripts/lib/schema.mjs";

const ISO = "2026-10-25T10:00:00.000Z";

const validTask = () => ({
  id: "T1.1",
  turn: 1,
  task: 1,
  flag: "SCAN",
  summary: "Scan repo structure",
  category: "repo-explore",
  difficulty: "reasoning-low",
  tier: "flash_lite",
  role: "scout",
  status: " ",
  files: ["src/scan.ts"],
  dependsOn: [],
  acceptance: "Structure report produced",
  attempts: 0,
  lastError: null,
  subagentId: null,
  evidencePath: null,
});

const validSession = () => ({
  schemaVersion: 1,
  mainConversationId: "conv-1",
  projectRoot: "C:/Users/x/proj",
  activeCommand: "asd",
  phase: "planning",
  startedAt: ISO,
  lastSeenAt: ISO,
  autonomyGranted: false,
  previousSessions: [
    { conversationId: "conv-0", endedAt: ISO, reason: "took_over_stale_session" },
  ],
});

const validState = () => ({
  schemaVersion: 1,
  slug: "auth-feature",
  title: "Auth feature",
  phase: "planning",
  profile: "balanced",
  options: {
    includeTests: true,
    includeDebug: true,
    gitCheckpoint: true,
    learnings: true,
    locale: "ko",
    maxConcurrent: 4,
  },
  limits: {
    maxTurns: 3,
    maxTasksTotal: 12,
    maxAttemptsPerTask: 3,
    maxNoProgressContinues: 2,
    proCap: 2,
  },
  counters: { flash_lite: 1, flash: 0, pro: 0, orchestrator: 0, noProgressContinues: 0 },
  currentTurn: 0,
  turns: [
    {
      turn: 1,
      title: "Turn 1 — Setup",
      status: "pending",
      checkpointCommit: null,
      baselineSnapshot: { "src/a.ts": { mtimeMs: 1234.5, sha256: "ab" } },
    },
  ],
  tasks: [validTask()],
  lintErrors: [],
  updatedAt: ISO,
});

const validPlanMd = () =>
  [
    "## 1. Current Project State",
    "- Node 24, zero deps",
    "## 2. Understood User Command",
    "> ⚠️ 위 이해 내용이 의도와 다르거나 빠진 부분이 있다면 이 부분을 수정해 달라고 말씀해 주세요.",
    "사용자는 인증 기능을 원한다.",
    "## 3. Interview & Options",
    "- Q1: 어떤 DB를 사용하는가?",
    "## 4. Turn & Task Execution Plan",
    "### Turn 1 — Setup",
    "- [ ] [SCAN] T1.1 Scan repo structure · flash_lite",
    "  - files: src/scan.ts",
    "- [ ] [BUILD] T1.2 Build auth module · flash",
    "  - files: src/auth.ts, src/auth.test.ts",
    "## 5. Verification & Completion Criteria",
    "- 모든 테스트 통과",
    "## 6. Runtime Amendments",
    "- (none)",
  ].join("\n");

/** @param {unknown} r */
const assertInvalid = (r) => {
  assert.ok(r && typeof r === "object", "validator returned an object");
  const res = /** @type {{ ok: boolean, errors: unknown[] }} */ (r);
  assert.strictEqual(res.ok, false, `expected ok:false, errors=${JSON.stringify(res.errors)}`);
  assert.ok(Array.isArray(res.errors) && res.errors.length > 0, "errors is a non-empty array");
  for (const e of res.errors) assert.strictEqual(typeof e, "string", "error entries are strings");
};

const NON_OBJECTS = [null, undefined, 42, "x", true, [], () => {}];

// ---------------------------------------------------------------- session

test("validateSession accepts a valid session", () => {
  const r = validateSession(validSession());
  assert.deepStrictEqual(r, { ok: true, errors: [] });
});

test("validateSession rejects malformed input", () => {
  for (const input of NON_OBJECTS) assertInvalid(validateSession(input));
  const cases = [
    ["schemaVersion 2", (s) => { s.schemaVersion = 2; }],
    ["missing mainConversationId", (s) => { delete s.mainConversationId; }],
    ["empty mainConversationId", (s) => { s.mainConversationId = ""; }],
    ["projectRoot number", (s) => { s.projectRoot = 123; }],
    ["unknown activeCommand", (s) => { s.activeCommand = "asd-lint"; }],
    ["unknown phase", (s) => { s.phase = "flying"; }],
    ["non-ISO startedAt", (s) => { s.startedAt = "2026-10-25 10:00:00"; }],
    ["non-ISO lastSeenAt", (s) => { s.lastSeenAt = "yesterday"; }],
    ["autonomyGranted string", (s) => { s.autonomyGranted = "yes"; }],
    ["previousSessions not array", (s) => { s.previousSessions = {}; }],
    ["previousSessions entry null", (s) => { s.previousSessions = [null]; }],
    ["previousSessions entry bad endedAt", (s) => {
      s.previousSessions = [{ conversationId: "a", endedAt: "bad", reason: "r" }];
    }],
    ["previousSessions entry empty reason", (s) => {
      s.previousSessions = [{ conversationId: "a", endedAt: ISO, reason: "" }];
    }],
  ];
  for (const [label, mutate] of cases) {
    const s = validSession();
    mutate(s);
    assertInvalid(validateSession(s));
  }
});

test("validateSession accepts activeCommand null and all phases", () => {
  for (const phase of ["idle", "scouting", "interviewing", "planning", "awaiting_approval", "running", "paused", "done"]) {
    const s = validSession();
    s.phase = phase;
    s.activeCommand = null;
    assert.deepStrictEqual(validateSession(s), { ok: true, errors: [] }, phase);
  }
});

// ---------------------------------------------------------------- task

test("validateTask accepts a valid task", () => {
  assert.deepStrictEqual(validateTask(validTask()), { ok: true, errors: [] });
});

test("validateTask rejects malformed input", () => {
  for (const input of NON_OBJECTS) assertInvalid(validateTask(input));
  const cases = [
    ["malformed id", (t) => { t.id = "1.1"; }],
    ["malformed id no dot", (t) => { t.id = "T1"; }],
    ["malformed id trailing dot", (t) => { t.id = "T1."; }],
    ["id/turn mismatch", (t) => { t.id = "T1.2"; }],
    ["turn 0", (t) => { t.turn = 0; }],
    ["task 0", (t) => { t.task = 0; }],
    ["turn non-integer", (t) => { t.turn = 1.5; }],
    ["unknown flag HACK", (t) => { t.flag = "HACK"; }],
    ["summary 41 chars", (t) => { t.summary = "x".repeat(41); }],
    ["summary empty", (t) => { t.summary = ""; }],
    ["unknown category", (t) => { t.category = "backend"; }],
    ["unknown difficulty", (t) => { t.difficulty = "reasoning-extreme"; }],
    ["unknown tier", (t) => { t.tier = "ultra"; }],
    ["unknown role", (t) => { t.role = "admin"; }],
    ["status done (symbol set only)", (t) => { t.status = "done"; }],
    ["files not array", (t) => { t.files = "src/a.ts"; }],
    ["files empty entry", (t) => { t.files = [""]; }],
    ["dependsOn number entry", (t) => { t.dependsOn = [42]; }],
    ["acceptance empty", (t) => { t.acceptance = ""; }],
    ["attempts negative", (t) => { t.attempts = -1; }],
    ["attempts string", (t) => { t.attempts = "0"; }],
    ["lastError number", (t) => { t.lastError = 42; }],
    ["subagentId undefined", (t) => { delete t.subagentId; }],
    ["evidencePath object", (t) => { t.evidencePath = {}; }],
  ];
  for (const [label, mutate] of cases) {
    const t = validTask();
    mutate(t);
    assertInvalid(validateTask(t));
  }
});

test("validateTask accepts 40-char summary and every status symbol", () => {
  for (const status of [" ", ">", "x", "!", "~"]) {
    const t = validTask();
    t.status = status;
    t.summary = "x".repeat(40);
    assert.deepStrictEqual(validateTask(t), { ok: true, errors: [] }, JSON.stringify(status));
  }
});

// ---------------------------------------------------------------- state

test("validateState accepts a valid state", () => {
  assert.deepStrictEqual(validateState(validState()), { ok: true, errors: [] });
});

test("validateState rejects malformed input", () => {
  for (const input of NON_OBJECTS) assertInvalid(validateState(input));
  const cases = [
    ["schemaVersion 0", (s) => { s.schemaVersion = 0; }],
    ["slug empty", (s) => { s.slug = ""; }],
    ["title missing", (s) => { delete s.title; }],
    ["phase empty", (s) => { s.phase = ""; }],
    ["unknown profile", (s) => { s.profile = "ultra"; }],
    ["options missing", (s) => { delete s.options; }],
    ["options.includeTests string", (s) => { s.options.includeTests = "yes"; }],
    ["options unknown locale jp", (s) => { s.options.locale = "jp"; }],
    ["options.maxConcurrent 0", (s) => { s.options.maxConcurrent = 0; }],
    ["options.maxConcurrent 9", (s) => { s.options.maxConcurrent = 9; }],
    ["options.maxConcurrent 1.5", (s) => { s.options.maxConcurrent = 1.5; }],
    ["options.maxConcurrent string", (s) => { s.options.maxConcurrent = "4"; }],
    ["limits missing", (s) => { delete s.limits; }],
    ["limits.maxTurns negative", (s) => { s.limits.maxTurns = -1; }],
    ["limits.proCap string", (s) => { s.limits.proCap = "2"; }],
    ["counters missing", (s) => { delete s.counters; }],
    ["counters.flash negative", (s) => { s.counters.flash = -1; }],
    ["currentTurn negative", (s) => { s.currentTurn = -1; }],
    ["currentTurn non-integer", (s) => { s.currentTurn = 1.5; }],
    ["turns not array", (s) => { s.turns = "nope"; }],
    ["turn entry null", (s) => { s.turns = [null]; }],
    ["turn status invalid", (s) => { s.turns[0].status = "running"; }],
    ["turn number 0", (s) => { s.turns[0].turn = 0; }],
    ["turn title empty", (s) => { s.turns[0].title = ""; }],
    ["checkpointCommit number", (s) => { s.turns[0].checkpointCommit = 123; }],
    ["baselineSnapshot string", (s) => { s.turns[0].baselineSnapshot = "x"; }],
    ["baselineSnapshot bad entry", (s) => {
      s.turns[0].baselineSnapshot = { "a.ts": { mtimeMs: "x", sha256: "" } };
    }],
    ["tasks not array", (s) => { s.tasks = {}; }],
    ["tasks contains invalid task", (s) => { s.tasks[0].flag = "HACK"; }],
    ["lintErrors string", (s) => { s.lintErrors = "none"; }],
    ["lintErrors number entry", (s) => { s.lintErrors = [42]; }],
    ["updatedAt non-ISO", (s) => { s.updatedAt = "2026-10-25"; }],
  ];
  for (const [label, mutate] of cases) {
    const s = validState();
    mutate(s);
    assertInvalid(validateState(s));
  }
});

test("validateState accepts maxConcurrent boundaries 1 and 8", () => {
  for (const n of [1, 8]) {
    const s = validState();
    s.options.maxConcurrent = n;
    assert.deepStrictEqual(validateState(s), { ok: true, errors: [] }, String(n));
  }
});

// ---------------------------------------------------------------- todo line

test("validateTodoLine accepts a valid line and parses fields", () => {
  const r = validateTodoLine("- [ ] [SCAN] T1.1 Scan repo structure · flash_lite");
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.parsed, {
    status: " ",
    flag: "SCAN",
    turn: 1,
    task: 1,
    summary: "Scan repo structure",
    tier: "flash_lite",
  });
});

test("validateTodoLine accepts every status symbol, flags, and tiers", () => {
  for (const status of [" ", ">", "x", "!", "~"]) {
    const r = validateTodoLine(`- [${status}] [BUILD] T2.3 작업 완료 · flash`);
    assert.strictEqual(r.ok, true, status);
  }
  for (const flag of ["SCAN", "PLAN", "BUILD", "TEST", "DEBUG", "VERIFY", "FIX"]) {
    const r = validateTodoLine(`- [x] [${flag}] T1.1 Sum · flash_lite`);
    assert.strictEqual(r.ok, true, flag);
  }
  for (const tier of ["flash_lite", "flash", "pro", "orchestrator"]) {
    const r = validateTodoLine(`- [~] [FIX] T3.2 Sum · ${tier}`);
    assert.strictEqual(r.ok, true, tier);
  }
});

test("validateTodoLine accepts exactly 40-char summary and trailing CR", () => {
  assert.strictEqual(
    validateTodoLine(`- [ ] [SCAN] T1.1 ${"x".repeat(40)} · flash_lite`).ok,
    true,
  );
  assert.strictEqual(
    validateTodoLine("- [ ] [SCAN] T1.1 Sum · flash_lite\r").ok,
    true,
  );
});

test("validateTodoLine rejects malformed input", () => {
  for (const input of [null, undefined, 42, {}, []]) assertInvalid(validateTodoLine(input));
  const badLines = [
    `- [ ] [SCAN] T1.1 ${"x".repeat(45)} · flash_lite`, // 45-char summary
    `- [ ] [SCAN] T1.1 ${"x".repeat(41)} · flash_lite`, // 41-char summary
    "- [ ] [HACK] T1.1 Sum · flash_lite", // unknown flag
    "- [ ] [SCAN] T1.1 Sum · ultra", // unknown tier
    "- [ ] [SCAN] T1.1 Sum", // missing tier part
    "- [ ] [SCAN] T1.1 Sum · flash_lite extra", // trailing junk
    "- [] [SCAN] T1.1 Sum · flash_lite", // missing status char
    "- [d] [SCAN] T1.1 Sum · flash_lite", // unknown status char
    "- [ ] [scan] T1.1 Sum · flash_lite", // lowercase flag
    "- [ ] [SCAN] T1 Sum · flash_lite", // id without task number
    "- [ ] [SCAN] T1.1  · flash_lite", // empty summary
    "  - [ ] [SCAN] T1.1 Sum · flash_lite", // leading indent
    "- [ ] [SCAN] T1.1 Sum · flash_lite\nsecond line", // multi-line
  ];
  for (const line of badLines) assertInvalid(validateTodoLine(line));
});

// ---------------------------------------------------------------- plan markdown

test("validatePlanMarkdown accepts a valid plan", () => {
  assert.deepStrictEqual(validatePlanMarkdown(validPlanMd()), { ok: true, errors: [] });
});

test("validatePlanMarkdown accepts an English ⚠️ correction banner", () => {
  const md = validPlanMd()
    .replace(
      "> ⚠️ 위 이해 내용이 의도와 다르거나 빠진 부분이 있다면 이 부분을 수정해 달라고 말씀해 주세요.",
      "> ⚠️ If any of the above is wrong, tell me to fix it.",
    );
  assert.deepStrictEqual(validatePlanMarkdown(md), { ok: true, errors: [] });
});

test("validatePlanMarkdown rejects missing headings", () => {
  const md = validPlanMd().replace("## 5. Verification & Completion Criteria\n", "");
  const r = validatePlanMarkdown(md);
  assertInvalid(r);
  assert.ok(
    r.errors.includes("MISSING_HEADING: ## 5. Verification & Completion Criteria"),
    JSON.stringify(r.errors),
  );
});

test("validatePlanMarkdown rejects wrong heading order", () => {
  const lines = validPlanMd().split("\n");
  const i4 = lines.indexOf("## 4. Turn & Task Execution Plan");
  const i5 = lines.indexOf("## 5. Verification & Completion Criteria");
  [lines[i4], lines[i5]] = [lines[i5], lines[i4]];
  const r = validatePlanMarkdown(lines.join("\n"));
  assertInvalid(r);
  assert.ok(r.errors.some((e) => e.startsWith("HEADING_ORDER:")), JSON.stringify(r.errors));
});

test("validatePlanMarkdown rejects missing correction notice in section 2", () => {
  const md = validPlanMd().replace(/^.+⚠️.+$/m, "- 사용자는 인증 기능을 원한다.");
  const r = validatePlanMarkdown(md);
  assertInvalid(r);
  assert.ok(r.errors.some((e) => e.startsWith("MISSING_CORRECTION_NOTICE:")), JSON.stringify(r.errors));
});

test("validatePlanMarkdown rejects duplicate files in the same Turn", () => {
  const md = validPlanMd()
    .replace("### Turn 1 — Setup", "### Turn 2 — Build")
    .replace("- [ ] [SCAN] T1.1 Scan repo structure · flash_lite", "- [ ] [BUILD] T2.1 Wire login · flash")
    .replace("  - files: src/scan.ts", "  - files: src/auth.ts, src/util.ts")
    .replace("- [ ] [BUILD] T1.2 Build auth module · flash", "- [ ] [BUILD] T2.2 Guard routes · flash")
    .replace("  - files: src/auth.ts, src/auth.test.ts", "  - files: src/routes.ts, src/auth.ts");
  const r = validatePlanMarkdown(md);
  assertInvalid(r);
  assert.ok(
    r.errors.includes("DUPLICATE_FILE_IN_TURN: Turn 2 -> src/auth.ts"),
    JSON.stringify(r.errors),
  );
});

test("validatePlanMarkdown allows the same file in different Turns", () => {
  const md = validPlanMd() + [
    "",
    "### Turn 2 — Extend",
    "- [ ] [BUILD] T2.1 Extend auth · flash",
    "  - files: src/scan.ts",
  ].join("\n");
  assert.deepStrictEqual(validatePlanMarkdown(md), { ok: true, errors: [] });
});

test("validatePlanMarkdown rejects non-string and empty input", () => {
  for (const input of [null, undefined, 42, {}, "", "   "]) {
    assertInvalid(validatePlanMarkdown(input));
  }
});

// ---------------------------------------------------------------- interview markdown

test("validateInterviewMarkdown accepts Korean/English question headings and numbered questions", () => {
  assert.deepStrictEqual(
    validateInterviewMarkdown("### 3. 심층 질문 및 플랜 옵션\n- 옵션 A?"),
    { ok: true, errors: [] },
  );
  assert.deepStrictEqual(
    validateInterviewMarkdown("## Questions & Options\n- DB?"),
    { ok: true, errors: [] },
  );
  assert.deepStrictEqual(
    validateInterviewMarkdown("## 인터뷰\n1. 어떤 DB를 사용하나요?"),
    { ok: true, errors: [] },
  );
  assert.deepStrictEqual(
    validateInterviewMarkdown("### Q1: 데이터베이스 선택"),
    { ok: true, errors: [] },
  );
});

test("validateInterviewMarkdown rejects empty and question-less input", () => {
  for (const input of [null, undefined, 42, {}, "", "   "]) {
    assertInvalid(validateInterviewMarkdown(input));
  }
  assertInvalid(validateInterviewMarkdown("## Notes\n- 그냥 메모입니다."));
});

// ---------------------------------------------------------------- cross-cutting

test("validators never throw on hostile nested input", () => {
  const hostile = {
    options: null,
    limits: null,
    counters: null,
    turns: [null, "x", { turn: "a", baselineSnapshot: "b" }],
    tasks: [null, "x", { id: "T0.0", turn: 0, task: 0 }],
    lintErrors: null,
    previousSessions: [null, "x"],
  };
  assertInvalid(validateSession(hostile));
  assertInvalid(validateState(hostile));
  assertInvalid(validateTask(hostile));
});
