// @ts-check
// allow: SIZE_OK — the plan mandates a single test file (tests/cli-plan-lint.test.mjs);
// splitting would create files outside the approved deliverable set.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readJsonSafe } from "../scripts/lib/fs-atomic.mjs";
import { validateTodoLine } from "../scripts/lib/schema.mjs";

const CLI = fileURLToPath(new URL("../scripts/asd.mjs", import.meta.url));

/**
 * Fresh os.tmpdir() subdirectory per test; removed via t.after.
 * @param {import("node:test").TestContext} t
 * @returns {string}
 */
function freshDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "asd-plan-"));
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

/**
 * Spawns the real CLI with cwd = ws.
 * @param {string} ws
 * @param {string[]} args
 * @returns {import("node:child_process").SpawnSyncReturns<string>}
 */
function run(ws, args) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd: ws, encoding: "utf8" });
}

/**
 * Runs a command asserting exit 0; returns the spawn result.
 * @param {string} ws
 * @param {string[]} args
 */
function ok(ws, args) {
  const r = run(ws, args);
  assert.equal(
    r.status,
    0,
    `cmd failed: asd ${args.join(" ")}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`,
  );
  return r;
}

/** @param {string} ws */
const stateOf = (ws) => readJsonSafe(path.join(ws, ".asd", "state.json"), null);

/** @param {string} ws @returns {string} */
const planOf = (ws) => fs.readFileSync(path.join(ws, ".asd", "PLAN.md"), "utf8");

/** @param {string} ws @param {string} md */
const writePlan = (ws, md) => fs.writeFileSync(path.join(ws, ".asd", "PLAN.md"), md);

/**
 * Reads .asd/TODO.md and asserts every task line passes validateTodoLine.
 * @param {string} ws
 * @returns {string[]}
 */
function assertTodoGrammar(ws) {
  const md = fs.readFileSync(path.join(ws, ".asd", "TODO.md"), "utf8");
  const lines = md.split(/\r?\n/).filter((l) => l.startsWith("- ["));
  for (const l of lines) {
    const v = validateTodoLine(l);
    assert.ok(v.ok, `invalid TODO line: ${JSON.stringify(l)} -> ${v.errors.join("; ")}`);
  }
  return lines;
}

/* ---------------- PLAN.md fixtures ---------------- */

/** A fully valid PLAN.md: includeTests/includeDebug false, profile eco, T1.1 BUILD. */
const PLAN_FIXTURE = `<!-- ASD-PLAN-V1: managed by scripts/asd.mjs -->
# ASD PLAN — Demo Plan (demo)

## 1. Current Project State
Fresh workspace with one source file.

## 2. Understood User Command
Build the demo module.
> ⚠️ 위 이해 내용이 의도와 다르거나 누락된 부분이 있다면 지적해 주세요. 수정 후 진행합니다.

## 3. Interview & Options
### 질문 (Questions)
(none)

### 옵션 (Options)
- includeTests: false
- includeDebug: false
- gitCheckpoint: false
- learnings: false
- profile: eco
- locale: ko

## 4. Turn & Task Execution Plan
### Turn 1: Build
- [ ] [BUILD] T1.1 build the core module · flash_lite
  files: src/core.js
  meta: category=general · difficulty=reasoning-low

## 5. Verification & Completion Criteria
- All tasks complete

## 6. Runtime Amendments
(none)
`;

/** Insert one task row (with files + meta lines) at the end of section 4. */
const addTask = (md, row, files) =>
  md.replace(
    "\n## 5. Verification & Completion Criteria",
    `\n${row}\n  files: ${files}\n  meta: category=general · difficulty=reasoning-low\n## 5. Verification & Completion Criteria`,
  );

/** Refine fixture: same T1.1 plus a new Turn 4 with T4.1 VERIFY. */
const PLAN_UPDATED = PLAN_FIXTURE.replace(
  "\n## 5. Verification & Completion Criteria",
  `\n### Turn 4: Verify\n- [ ] [VERIFY] T4.1 verify the final result · flash\n  files: -\n  meta: category=verification · difficulty=reasoning-low\n\n## 5. Verification & Completion Criteria`,
);

/* ------------------------------------------------------------------ */

test("plan-init creates a strictly formatted PLAN.md that passes lint", (t) => {
  const ws = freshDir(t);
  ok(ws, [
    "plan-init", "--slug", "demo", "--title", "Demo Plan",
    "--project-state", "fresh workspace", "--understood", "build the demo",
  ]);
  const md = planOf(ws);
  for (const h of [
    "## 1. Current Project State",
    "## 2. Understood User Command",
    "## 3. Interview & Options",
    "## 4. Turn & Task Execution Plan",
    "## 5. Verification & Completion Criteria",
    "## 6. Runtime Amendments",
  ]) {
    assert.ok(md.includes(h), `PLAN.md must contain "${h}"`);
  }
  assert.ok(md.includes("위 이해 내용이 의도와 다르거나"), "Korean correction callout required");
  assert.ok(md.includes("fresh workspace"));
  assert.ok(md.includes("build the demo"));
  assert.ok(md.includes("- includeTests: false"), "state defaults must be declared");

  const r = ok(ws, ["lint"]);
  assert.ok(r.stdout.includes("lint: passed"));
  assert.deepEqual(stateOf(ws).lintErrors, []);
});

test("lint: six distinct failure cases each exit 1 and record state.lintErrors", (t) => {
  /** @type {[string, string, string][]} name, mutated plan, expected error code */
  const cases = [
    [
      "missing heading",
      PLAN_FIXTURE.replace("## 5. Verification & Completion Criteria\n", ""),
      "MISSING_HEADING",
    ],
    [
      "missing section-2 correction notice",
      PLAN_FIXTURE.replace(
        "> ⚠️ 위 이해 내용이 의도와 다르거나 누락된 부분이 있다면 지적해 주세요. 수정 후 진행합니다.\n",
        "",
      ),
      "MISSING_CORRECTION_NOTICE",
    ],
    [
      "TEST task while includeTests false",
      addTask(PLAN_FIXTURE, "- [ ] [TEST] T1.2 test the core module · flash", "-"),
      "TEST_TASK_FORBIDDEN_BY_OPTIONS",
    ],
    [
      "pre-planned DEBUG task while includeDebug false",
      addTask(PLAN_FIXTURE, "- [ ] [DEBUG] T1.3 debug the odd failure · flash", "-"),
      "DEBUG_TASK_FORBIDDEN_BY_OPTIONS",
    ],
    [
      "summary longer than 40 chars",
      addTask(PLAN_FIXTURE, `- [ ] [BUILD] T1.4 ${"x".repeat(41)} · flash`, "-"),
      "SUMMARY_TOO_LONG",
    ],
    [
      "duplicate file in the same Turn",
      addTask(PLAN_FIXTURE, "- [ ] [BUILD] T1.5 another build task here · flash", "src/core.js"),
      "DUPLICATE_FILE_IN_TURN",
    ],
  ];
  for (const [name, md, code] of cases) {
    const ws = freshDir(t);
    ok(ws, ["plan-init", "--slug", "demo", "--title", "Demo Plan"]);
    writePlan(ws, md);
    const r = run(ws, ["lint"]);
    assert.equal(r.status, 1, `${name}: lint must exit 1\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.ok(r.stderr.includes(code), `${name}: stderr must include ${code}\nstderr: ${r.stderr}`);
    const lintErrors = stateOf(ws).lintErrors;
    assert.ok(
      lintErrors.some((/** @type {string} */ e) => e.includes(code)),
      `${name}: state.lintErrors must record ${code} (got ${JSON.stringify(lintErrors)})`,
    );
  }
});

test("plan-import fresh populates state turns/tasks/options and renders TODO.md", (t) => {
  const ws = freshDir(t);
  ok(ws, ["plan-init", "--slug", "demo", "--title", "Demo Plan"]);
  writePlan(ws, PLAN_FIXTURE);
  ok(ws, ["plan-import"]);

  const st = stateOf(ws);
  assert.equal(st.tasks.length, 1);
  const task = st.tasks[0];
  assert.equal(task.id, "T1.1");
  assert.equal(task.flag, "BUILD");
  assert.equal(task.summary, "build the core module");
  assert.equal(task.tier, "flash_lite");
  assert.equal(task.role, "worker");
  assert.equal(task.status, " ");
  assert.deepEqual(task.files, ["src/core.js"]);
  assert.equal(task.category, "general");
  assert.equal(st.turns[0].turn, 1);
  assert.equal(st.turns[0].title, "Build");
  assert.equal(st.options.includeTests, false);
  assert.equal(st.options.includeDebug, false);
  assert.equal(st.profile, "eco", "plan profile must be applied to state");
  assert.equal(st.limits.proCap, 0, "eco proCap must follow the imported profile");

  const todoLines = assertTodoGrammar(ws);
  assert.ok(todoLines.some((l) => l.includes("T1.1")), "TODO.md must list T1.1");
});

test("plan-import refine preserves completed [x] tasks and adds new plan tasks", (t) => {
  const ws = freshDir(t);
  ok(ws, ["plan-init", "--slug", "demo", "--title", "Demo Plan"]);
  writePlan(ws, PLAN_FIXTURE);
  ok(ws, ["plan-import"]);
  ok(ws, ["task", "done", "T1.1", "--evidence", "ev.txt"]);

  writePlan(ws, PLAN_UPDATED);
  ok(ws, ["plan-import"]);

  const st = stateOf(ws);
  const t1 = st.tasks.find((/** @type {any} */ x) => x.id === "T1.1");
  assert.equal(t1.status, "x", "completed status must survive re-import");
  assert.equal(t1.evidencePath, "ev.txt", "evidencePath must survive re-import");
  const t4 = st.tasks.find((/** @type {any} */ x) => x.id === "T4.1");
  assert.ok(t4, "new plan task T4.1 must be imported");
  assert.equal(t4.flag, "VERIFY");
  assert.equal(t4.status, " ");
  assertTodoGrammar(ws);
});

test("amend appends a timestamped entry under section 6 and PLAN.md still passes lint", (t) => {
  const ws = freshDir(t);
  ok(ws, ["plan-init", "--slug", "demo", "--title", "Demo Plan"]);
  writePlan(ws, PLAN_FIXTURE);
  const json = '{"turn":4,"task":1,"flag":"BUILD","summary":"hotfix the thing","tier":"flash"}';
  ok(ws, ["amend", "--reason", "runtime fix needed", "--add-task-json", json]);

  const md = planOf(ws);
  const sec6 = md.slice(md.indexOf("## 6. Runtime Amendments"));
  assert.match(
    sec6,
    /- \[\d{4}-\d{2}-\d{2}T[^\]]*\] runtime fix needed/,
    "timestamped amendment entry required",
  );
  assert.ok(sec6.includes(json), "added-task JSON must be recorded");
  assert.ok(!sec6.includes("(none)"), 'the "(none)" placeholder must be replaced');
  ok(ws, ["lint"]);
});

test("adversarial: lint/amend/plan-import on missing or corrupt PLAN.md never crash", (t) => {
  const ws = freshDir(t);
  // No .asd at all.
  const bare = run(ws, ["lint"]);
  assert.equal(bare.status, 1);
  assert.ok(bare.stderr.includes("PLAN_NOT_FOUND"));
  assert.ok(bare.stderr.includes("STATE_NOT_FOUND"));

  const noPlanAmend = run(ws, ["amend", "--reason", "x"]);
  assert.equal(noPlanAmend.status, 1);
  assert.ok(noPlanAmend.stderr.includes("no .asd/PLAN.md found"));

  // Initialized workspace, then PLAN.md removed / corrupted.
  ok(ws, ["plan-init", "--slug", "demo", "--title", "Demo Plan"]);
  fs.rmSync(path.join(ws, ".asd", "PLAN.md"));
  const noImport = run(ws, ["plan-import"]);
  assert.equal(noImport.status, 1);
  assert.ok(noImport.stderr.includes("no .asd/PLAN.md found"));

  writePlan(ws, "complete garbage — not a plan");
  const corrupt = run(ws, ["lint"]);
  assert.equal(corrupt.status, 1);
  assert.ok(corrupt.stderr.includes("MISSING_HEADING"));
});
