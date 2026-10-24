// @ts-check
/**
 * Tests for scripts/lib/render.mjs: byte-identical golden rendering,
 * TODO-grammar compliance via validateTodoLine, PLAN.md round-trip,
 * DUPLICATE_FILE_IN_TURN rejection, SUMMARY.md Mermaid/diff/tier rendering,
 * legend localization, and graceful parsePlanMarkdown failure.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  renderTodoMarkdown,
  renderTodoConsoleBox,
  renderPlanTemplate,
  parsePlanMarkdown,
  renderInterviewMarkdown,
  renderLearningsMarkdown,
  renderSummaryMarkdown,
} from "../scripts/lib/render.mjs";
import {
  validateTodoLine,
  validatePlanMarkdown,
  validateInterviewMarkdown,
} from "../scripts/lib/schema.mjs";

/* ---------------- fixtures ---------------- */

const STATE = {
  title: "Add auth module",
  phase: "running",
  profile: "balanced",
  currentTurn: 2,
  options: { locale: "ko" },
  turns: [
    { turn: 1, title: "Scout & scaffold", status: "done" },
    { turn: 2, title: "Implement auth", status: "in_progress" },
  ],
  tasks: [
    { id: "T1.1", turn: 1, task: 1, flag: "SCAN", status: "x", summary: "Explore repo structure", tier: "flash_lite" },
    { id: "T1.2", turn: 1, task: 2, flag: "BUILD", status: "x", summary: "Scaffold auth module", tier: "flash" },
    { id: "T2.1", turn: 2, task: 1, flag: "BUILD", status: ">", summary: "Implement login endpoint", tier: "pro" },
    { id: "T2.2", turn: 2, task: 2, flag: "TEST", status: " ", summary: "Write auth tests", tier: "flash" },
  ],
  counters: { flash_lite: 1, flash: 2, pro: 1, orchestrator: 0 },
};

const PLAN_INPUT = {
  slug: "add-auth",
  title: "Add auth module",
  projectState: "Express app with no auth.",
  understoodCommand: "사용자 인증 모듈을 추가한다",
  questions: ["Which auth provider?", "Session vs JWT?"],
  options: {
    includeTests: true,
    includeDebug: false,
    gitCheckpoint: true,
    learnings: true,
    profile: "performance",
  },
  turns: [{ turn: 1, title: "Scout" }, { turn: 2, title: "Build" }],
  tasks: [
    { turn: 1, task: 1, flag: "SCAN", summary: "Explore repo structure", tier: "flash_lite", files: ["docs/notes.md"], category: "repo-explore", difficulty: "reasoning-low" },
    { turn: 2, task: 1, flag: "BUILD", summary: "Implement login endpoint", tier: "pro", files: ["src/auth.ts", "src/routes.ts"], category: "general", difficulty: "reasoning-medium" },
    { turn: 2, task: 2, flag: "TEST", summary: "Write auth tests", tier: "flash", files: [], category: "verification", difficulty: "reasoning-none" },
  ],
  criteria: ["All tests pass", "Lint clean"],
  amendments: [],
  locale: "ko",
};

/* ---------------- golden rendering ---------------- */

const EXPECTED_TODO_MD = `<!-- ASD-GENERATED: DO NOT EDIT MANUALLY. Managed by scripts/asd.mjs -->
# ASD TODO — Add auth module [Phase: running | Turn: T2/2 | Profile: balanced | Done: 2/4]

## Turn 1: Scout & scaffold
- [x] [SCAN] T1.1 Explore repo structure · flash_lite
- [x] [BUILD] T1.2 Scaffold auth module · flash

## Turn 2: Implement auth
- [>] [BUILD] T2.1 Implement login endpoint · pro
- [ ] [TEST] T2.2 Write auth tests · flash

---
## Legend
- Flags: SCAN=스캔 · PLAN=계획 · BUILD=빌드 · TEST=테스트 · DEBUG=디버그 · VERIFY=검증 · FIX=수정
- Status: [ ] 대기 · [>] 진행 중 · [x] 완료 · [!] 실패 · [~] 건너뜀
`;

const EXPECTED_CONSOLE_BOX = `# ASD TODO — Add auth module [Phase: running | Turn: T2/2 | Profile: balanced | Done: 2/4]

## Turn 1: Scout & scaffold
- [x] [SCAN] T1.1 Explore repo structure · flash_lite
- [x] [BUILD] T1.2 Scaffold auth module · flash

## Turn 2: Implement auth
- [>] [BUILD] T2.1 Implement login endpoint · pro
- [ ] [TEST] T2.2 Write auth tests · flash
`;

test("renderTodoMarkdown produces the byte-identical golden output (ko default)", () => {
  assert.equal(renderTodoMarkdown(STATE), EXPECTED_TODO_MD);
});

test("renderTodoConsoleBox produces the byte-identical golden output and no timestamps", () => {
  const box = renderTodoConsoleBox(STATE);
  assert.equal(box, EXPECTED_CONSOLE_BOX);
  assert.doesNotMatch(box, /\d{4}-\d{2}-\d{2}/);
});

test("every rendered TODO.md task line passes validateTodoLine", () => {
  const taskLines = renderTodoMarkdown(STATE)
    .split("\n")
    .filter((l) => /^- \[[ >x!~]\] \[/.test(l));
  assert.equal(taskLines.length, 4);
  for (const line of taskLines) {
    const r = validateTodoLine(line);
    assert.equal(r.ok, true, `line failed validateTodoLine: ${line}`);
  }
});

test("legend is localized: ko default vs en", () => {
  const ko = renderTodoMarkdown(STATE);
  assert.match(ko, /SCAN=스캔/);
  assert.match(ko, /\[ \] 대기/);
  assert.match(ko, /## Legend/);
  const en = renderTodoMarkdown({ ...STATE, options: { locale: "en" } });
  assert.match(en, /SCAN=scan/);
  assert.match(en, /\[ \] pending/);
  assert.doesNotMatch(en, /스캔/);
});

/* ---------------- PLAN.md render + round-trip ---------------- */

test("renderPlanTemplate output passes validatePlanMarkdown (ko and en)", () => {
  const koMd = renderPlanTemplate(PLAN_INPUT);
  const koV = validatePlanMarkdown(koMd);
  assert.equal(koV.ok, true, JSON.stringify(koV.errors));
  assert.ok(koMd.includes("위 이해 내용이 의도와 다르거나"));

  const enMd = renderPlanTemplate({ ...PLAN_INPUT, locale: "en" });
  const enV = validatePlanMarkdown(enMd);
  assert.equal(enV.ok, true, JSON.stringify(enV.errors));
});

test("round-trip renderPlanTemplate -> parsePlanMarkdown preserves options, turns, tasks, files, category, difficulty, locale", () => {
  const parsed = parsePlanMarkdown(renderPlanTemplate(PLAN_INPUT));
  assert.equal(parsed.ok, true, JSON.stringify(parsed.errors));

  assert.equal(parsed.options.includeTests, true);
  assert.equal(parsed.options.includeDebug, false);
  assert.equal(parsed.options.gitCheckpoint, true);
  assert.equal(parsed.options.learnings, true);
  assert.equal(parsed.options.profile, "performance");
  assert.equal(parsed.options.locale, "ko");

  assert.equal(parsed.turns.length, 2);
  assert.equal(parsed.turns[0].turn, 1);
  assert.equal(parsed.turns[0].title, "Scout");
  assert.equal(parsed.turns[1].turn, 2);
  assert.equal(parsed.turns[1].title, "Build");

  assert.equal(parsed.tasks.length, 3);
  const [t0, t1, t2] = parsed.tasks;
  assert.equal(t0.id, "T1.1");
  assert.equal(t0.turn, 1);
  assert.equal(t0.task, 1);
  assert.equal(t0.flag, "SCAN");
  assert.equal(t0.summary, "Explore repo structure");
  assert.equal(t0.tier, "flash_lite");
  assert.equal(t0.status, " ");
  assert.deepEqual(t0.files, ["docs/notes.md"]);
  assert.equal(t0.category, "repo-explore");
  assert.equal(t0.difficulty, "reasoning-low");

  assert.deepEqual(t1.files, ["src/auth.ts", "src/routes.ts"]);
  assert.equal(t1.category, "general");
  assert.equal(t1.difficulty, "reasoning-medium");

  assert.deepEqual(t2.files, []);
  assert.equal(t2.category, "verification");
  assert.equal(t2.difficulty, "reasoning-none");
});

test("round-trip preserves locale=en and category/difficulty", () => {
  const parsed = parsePlanMarkdown(
    renderPlanTemplate({ ...PLAN_INPUT, locale: "en" }),
  );
  assert.equal(parsed.ok, true, JSON.stringify(parsed.errors));
  assert.equal(parsed.options.locale, "en");
  assert.equal(parsed.tasks[0].category, "repo-explore");
  assert.equal(parsed.tasks[0].difficulty, "reasoning-low");
});

test("parsePlanMarkdown rejects duplicate files in the same Turn with DUPLICATE_FILE_IN_TURN", () => {
  const dupMd = renderPlanTemplate({
    ...PLAN_INPUT,
    tasks: [
      { turn: 2, task: 1, flag: "BUILD", summary: "Touch auth file A", tier: "pro", files: ["src/auth.ts"], category: "general", difficulty: "reasoning-low" },
      { turn: 2, task: 2, flag: "TEST", summary: "Touch auth file B", tier: "flash", files: ["src/auth.ts"], category: "general", difficulty: "reasoning-low" },
    ],
  });
  const direct = validatePlanMarkdown(dupMd);
  assert.equal(direct.ok, false);
  assert.ok(
    direct.errors.includes("DUPLICATE_FILE_IN_TURN: Turn 2 -> src/auth.ts"),
    JSON.stringify(direct.errors),
  );
  const parsed = parsePlanMarkdown(dupMd);
  assert.equal(parsed.ok, false);
  assert.ok(
    parsed.errors.includes("DUPLICATE_FILE_IN_TURN: Turn 2 -> src/auth.ts"),
    JSON.stringify(parsed.errors),
  );
});

test("parsePlanMarkdown fails gracefully on malformed/truncated input (never throws)", () => {
  const nullish = parsePlanMarkdown(null);
  assert.equal(nullish.ok, false);
  assert.deepEqual(nullish.turns, []);
  assert.deepEqual(nullish.tasks, []);

  const empty = parsePlanMarkdown("");
  assert.equal(empty.ok, false);
  assert.equal(empty.options.locale, "ko");

  const truncated = parsePlanMarkdown(
    "## 3. Interview & Options\n- includeTests: true\n- locale: en",
  );
  assert.equal(truncated.ok, false); // missing headings -> errors
  assert.equal(truncated.options.includeTests, true);
  assert.equal(truncated.options.locale, "en");
  assert.deepEqual(truncated.turns, []);
  assert.deepEqual(truncated.tasks, []);
});

/* ---------------- interview.md / learnings.md ---------------- */

test("renderInterviewMarkdown passes validateInterviewMarkdown", () => {
  const md = renderInterviewMarkdown({
    title: "Auth requirements",
    questions: [
      { question: "Which auth provider?", options: ["Google", "GitHub"] },
      "Session vs JWT?",
    ],
  });
  const v = validateInterviewMarkdown(md);
  assert.equal(v.ok, true, JSON.stringify(v.errors));
  assert.match(md, /^## Q1\. Which auth provider\?$/m);
  assert.match(md, /^## Q2\. Session vs JWT\?$/m);
  assert.match(md, /^1\. Google$/m);
});

test("renderLearningsMarkdown renders entries under the ASD Project Learnings header", () => {
  const md = renderLearningsMarkdown([
    { date: "2026-10-25", category: "pattern", note: "Pure renderers, no fs" },
  ]);
  assert.match(md, /^# ASD Project Learnings$/m);
  assert.match(md, /^- \[2026-10-25\] \[pattern\] Pure renderers, no fs$/m);
});

/* ---------------- SUMMARY.md ---------------- */

const SUMMARY_STATE = {
  ...STATE,
  tasks: [
    { id: "T1.1", turn: 1, task: 1, flag: "SCAN", status: "x", summary: "Explore repo structure", tier: "flash_lite" },
    { id: "T1.2", turn: 1, task: 2, flag: "BUILD", status: "x", summary: "Scaffold auth module", tier: "flash" },
    { id: "T2.1", turn: 2, task: 1, flag: "BUILD", status: "x", summary: "Implement login endpoint", tier: "pro" },
    { id: "T2.2", turn: 2, task: 2, flag: "VERIFY", status: "x", summary: "Verify auth flows", tier: "flash" },
  ],
};

test("renderSummaryMarkdown contains header, Mermaid flowchart, diff table, tier counts, badges, notes", () => {
  const md = renderSummaryMarkdown(SUMMARY_STATE, {
    finalNotes: "Auth module shipped.",
    diffStats: [{ file: "src/auth.ts", added: 12, deleted: 3 }],
  });
  assert.ok(md.startsWith("<!-- ASD-SUMMARY-V1 -->"));
  assert.match(md, /```mermaid/);
  assert.match(md, /flowchart LR/);
  assert.match(md, /T1\["Turn 1 \(2 tasks\)"\]/);
  assert.match(md, /T1 --> T2/);
  assert.match(md, /\| src\/auth\.ts \| \+12 \| -3 \|/);
  assert.match(md, /- flash_lite: 1/);
  assert.match(md, /- flash: 2/);
  assert.match(md, /- pro: 1/);
  assert.match(md, /- orchestrator: 0/);
  assert.match(md, /- ✅ T2\.2 Verify auth flows/);
  assert.match(md, /- ✅ All tasks complete/);
  assert.match(md, /Auth module shipped\./);
});

test("renderSummaryMarkdown emits failure badge when tasks are incomplete", () => {
  const md = renderSummaryMarkdown(STATE, {
    finalNotes: "In progress.",
    diffStats: [],
  });
  assert.match(md, /- ❌ 2 task\(s\) incomplete/);
  assert.match(md, /- \(no verification tasks\)/);
});
