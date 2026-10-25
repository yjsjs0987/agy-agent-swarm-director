// @ts-check
// allow: SIZE_OK — the overage is the PLAN.md fixture plus 7 sequential
// lifecycle stages that must share ONE isolated temp git workspace; splitting
// stages into separate files would multiply workspace setup, not logic.
/**
 * End-to-end lifecycle integration suite (plan Todo 19).
 *
 * Simulates a realistic user project through the complete multi-turn ASD
 * workflow in ONE isolated temp git repository (os.tmpdir(), synthetic local
 * git identity, removed + asserted-removed in t.after):
 *
 *   1. Preflight new_plan        -> .asd/ + session.json skeleton
 *   2. Plan creation + format    -> lint, plan-import, strict TODO grammar
 *   3. Hook guard in planning    -> PLAN_GUARD + FORMAT_GUARD denies
 *   4. Turn 1 + git checkpoint   -> SHA recorded, TODO [x]
 *   5. Turn 2 error + [FIX]      -> escalation flash_lite->flash, amend
 *   6. Subagent stop isolation   -> subagent {}, main "continue"
 *   7. Interruption/resume       -> resume banner, refine_plan snapshot,
 *                                   plan-import preserves [x], adds T4.1
 *
 * Zero external deps: node:test + node:assert/strict + node:child_process.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const ASD_CLI = path.join(REPO_ROOT, "scripts", "asd.mjs");
const hook = (name) => path.join(REPO_ROOT, "scripts", "hooks", name);

const { validateTodoLine } = await import(
  pathToFileURL(path.join(REPO_ROOT, "scripts", "lib", "schema.mjs")).href
);

/** Runs the ASD CLI synchronously against `ws`. @param {string} ws @param {string[]} args */
function runCli(ws, args) {
  return spawnSync(process.execPath, [ASD_CLI, "--workspace", ws, ...args], {
    encoding: "utf8",
    timeout: 30_000,
  });
}

/**
 * Spawns a hook with a JSON payload, asserts exit 0, returns parsed stdout.
 * @param {string} name @param {Record<string, unknown>} payload
 */
function runHook(name, payload) {
  const r = spawnSync(process.execPath, [hook(name)], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    timeout: 15_000,
  });
  assert.equal(r.status, 0, `${name} must exit 0 (stderr: ${r.stderr})`);
  return JSON.parse(r.stdout ?? "{}");
}

/** @param {string} ws @returns {any} */
const readState = (ws) => JSON.parse(fs.readFileSync(path.join(ws, ".asd", "state.json"), "utf8"));
/** @param {string} ws @returns {string} */
const readTodo = (ws) => fs.readFileSync(path.join(ws, ".asd", "TODO.md"), "utf8");
/** @param {string} ws @param {string} id @returns {string} TODO row for task id */
function todoRow(ws, id) {
  const row = readTodo(ws)
    .split(/\r?\n/)
    .find((l) => l.includes(` ${id} `));
  assert.ok(row !== undefined, `TODO.md must contain a row for ${id}`);
  return row;
}

/** Lint-clean PLAN fixture: all options declared, 3 turns, T2.1 on flash_lite. */
const PLAN_V1 = [
  "# Lifecycle Demo Plan",
  "",
  "## 1. Current Project State",
  "Empty.",
  "",
  "## 2. Understood User Command",
  "⚠️ 위 이해 내용이 의도와 다르거나 누락된 부분이 있다면 지금 알려주세요.",
  "",
  "## 3. Interview & Options",
  "- includeTests: true",
  "- includeDebug: true",
  "- gitCheckpoint: true",
  "- learnings: true",
  "- profile: balanced",
  "(none)",
  "",
  "## 4. Turn & Task Execution Plan",
  "- [ ] [SCAN] T1.1 scan repo structure · flash_lite",
  "  files: -",
  "- [ ] [BUILD] T1.2 build entry module · flash",
  "  files: src/app.js",
  "- [ ] [BUILD] T2.1 wire the runner · flash_lite",
  "  files: src/runner.js",
  "  meta: category=general · difficulty=reasoning-none",
  "- [ ] [BUILD] T3.1 polish output · flash",
  "  files: src/app.js",
  "",
  "## 5. Verification & Completion Criteria",
  "All checks pass.",
  "",
  "## 6. Runtime Amendments",
  "(none)",
  "",
].join("\n");

/** Refined PLAN: done tasks marked [x], T2.2 [FIX] folded in, T4.1 added. */
const PLAN_V2 = [
  "# Lifecycle Demo Plan",
  "",
  "## 1. Current Project State",
  "Turns 1-2 complete; fix task folded in.",
  "",
  "## 2. Understood User Command",
  "⚠️ 위 이해 내용이 의도와 다르거나 누락된 부분이 있다면 지금 알려주세요.",
  "",
  "## 3. Interview & Options",
  "- includeTests: true",
  "- includeDebug: true",
  "- gitCheckpoint: true",
  "- learnings: true",
  "- profile: balanced",
  "(none)",
  "",
  "## 4. Turn & Task Execution Plan",
  "- [x] [SCAN] T1.1 scan repo structure · flash_lite",
  "  files: -",
  "- [x] [BUILD] T1.2 build entry module · flash",
  "  files: src/app.js",
  "- [x] [BUILD] T2.1 wire the runner · flash",
  "  files: src/runner.js",
  "- [x] [FIX] T2.2 fix runner crash · flash",
  "  files: src/runner-fix.js",
  "- [ ] [BUILD] T3.1 polish output · flash",
  "  files: src/app.js",
  "- [ ] [BUILD] T4.1 final docs pass · flash_lite",
  "  files: docs.md",
  "",
  "## 5. Verification & Completion Criteria",
  "All checks pass.",
  "",
  "## 6. Runtime Amendments",
  "(none)",
  "",
].join("\n");

test("e2e lifecycle: preflight -> plan -> guards -> turns -> fix -> hooks -> resume/refine", async (t) => {
  // One isolated temp workspace that is ALSO a git repo with a synthetic
  // LOCAL identity (never the user's global git config).
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "asd-e2e-"));
  t.after(() => {
    fs.rmSync(ws, { recursive: true, force: true });
    assert.equal(fs.existsSync(ws), false, "temp workspace must be cleaned up");
  });
  const git = (/** @type {string[]} */ ...args) =>
    execFileSync("git", args, { cwd: ws, encoding: "utf8" });
  git("init");
  git("config", "user.email", "asd-test@example.com");
  git("config", "user.name", "ASD Test");
  git("config", "core.autocrlf", "false");
  git("commit", "--allow-empty", "-m", "init");

  // ---- Stage 1: Preflight new_plan -------------------------------------
  await t.test("stage 1: preflight --cmd asd creates .asd/ + session (new_plan)", () => {
    const r = runCli(ws, ["preflight", "--cmd", "asd", "--session", "sess-main-1"]);
    assert.equal(r.status, 0, `preflight failed: ${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.mode, "new_plan");
    const session = JSON.parse(fs.readFileSync(path.join(ws, ".asd", "session.json"), "utf8"));
    assert.equal(session.mainConversationId, "sess-main-1");
  });

  // ---- Stage 2: Plan creation + format enforcement ---------------------
  await t.test("stage 2: lint + plan-import produce strict-grammar TODO.md", () => {
    assert.equal(runCli(ws, ["init", "--slug", "lifecycle", "--title", "Lifecycle Demo", "--session", "sess-main-1"]).status, 0);
    fs.writeFileSync(path.join(ws, ".asd", "PLAN.md"), PLAN_V1, "utf8");
    const lint = runCli(ws, ["lint"]);
    assert.equal(lint.status, 0, `lint failed: ${lint.stderr}`);
    const imp = runCli(ws, ["plan-import"]);
    assert.equal(imp.status, 0, `plan-import failed: ${imp.stderr}`);
    const rows = readTodo(ws).split(/\r?\n/).filter((l) => l.startsWith("- ["));
    assert.equal(rows.length, 4, "4 imported tasks");
    for (const row of rows) {
      const v = validateTodoLine(row);
      assert.ok(v.ok, `TODO row failed strict grammar: ${row} -> ${v.errors.join("; ")}`);
    }
  });

  // ---- Stage 3: Hook guard in planning phase ---------------------------
  await t.test("stage 3: pre-tool-guard denies source write + machine-file write", () => {
    const src = runHook("pre-tool-guard.mjs", {
      conversationId: "sess-main-1",
      workspacePaths: [ws],
      toolCall: { name: "write_to_file", args: { path: path.join(ws, "src", "app.js") } },
    });
    assert.equal(src.decision, "deny");
    assert.match(src.reason, /ASD_PLAN_GUARD/);
    const machine = runHook("pre-tool-guard.mjs", {
      conversationId: "sess-main-1",
      workspacePaths: [ws],
      toolCall: { name: "write_to_file", args: { path: path.join(ws, ".asd", "TODO.md") } },
    });
    assert.equal(machine.decision, "deny");
    assert.match(machine.reason, /ASD_FORMAT_GUARD/);
  });

  // ---- Stage 4: Turn 1 + git checkpoint --------------------------------
  await t.test("stage 4: turn 1 completes and checkpoint records a git SHA", () => {
    assert.equal(runCli(ws, ["phase", "set", "running", "--approve-autonomy"]).status, 0);
    assert.equal(runCli(ws, ["turn", "next"]).status, 0);
    for (const [id, summary] of [["T1.1", "scanned"], ["T1.2", "built"]]) {
      assert.equal(runCli(ws, ["task", "start", id]).status, 0, `start ${id}`);
      assert.equal(runCli(ws, ["task", "done", id, "--summary", summary]).status, 0, `done ${id}`);
    }
    const cp = runCli(ws, ["checkpoint", "--turn", "1"]);
    assert.equal(cp.status, 0, `checkpoint failed: ${cp.stderr}`);
    const entry = readState(ws).turns.find((/** @type {any} */ x) => x.turn === 1);
    assert.match(entry.checkpointCommit, /^[0-9a-f]{40}$/, "checkpoint SHA recorded in state.json");
    assert.match(todoRow(ws, "T1.1"), /^- \[x\] \[SCAN\] T1\.1 /);
    assert.match(todoRow(ws, "T1.2"), /^- \[x\] \[BUILD\] T1\.2 /);
  });

  // ---- Stage 5: Turn 2 error + [FIX] + escalation ----------------------
  await t.test("stage 5: T2.1 fails -> flash_lite escalates to flash; T2.2 [FIX] added + amended", () => {
    assert.equal(runCli(ws, ["turn", "next"]).status, 0);
    assert.equal(runCli(ws, ["task", "start", "T2.1"]).status, 0);
    assert.equal(runCli(ws, ["task", "fail", "T2.1", "--reason", "runner crashed on empty input"]).status, 0);
    const t21 = readState(ws).tasks.find((/** @type {any} */ x) => x.id === "T2.1");
    assert.equal(t21.tier, "flash", "escalation flash_lite -> flash");
    assert.equal(t21.status, " ", "failed task returns to retry");
    assert.equal(t21.attempts, 1);

    assert.equal(
      runCli(ws, ["todo", "add", "--turn", "2", "--flag", "FIX", "--summary", "fix runner crash", "--files", "src/runner.js"]).status,
      0,
    );
    assert.ok(readState(ws).tasks.some((/** @type {any} */ x) => x.id === "T2.2"), "T2.2 in state");
    const amend = runCli(ws, [
      "amend",
      "--reason",
      "T2.1 failed; adding dynamic fix task",
      "--add-task-json",
      JSON.stringify({ id: "T2.2", flag: "FIX", summary: "fix runner crash" }),
    ]);
    assert.equal(amend.status, 0, `amend failed: ${amend.stderr}`);
    const plan = fs.readFileSync(path.join(ws, ".asd", "PLAN.md"), "utf8");
    const sec6 = plan.split("## 6. Runtime Amendments")[1] ?? "";
    assert.match(sec6, /T2\.1 failed; adding dynamic fix task/, "amendment recorded in PLAN section 6");
    assert.match(todoRow(ws, "T2.2"), /\[FIX\] T2\.2 /, "T2.2 [FIX] in TODO.md");

    for (const [id, summary] of [["T2.1", "rewired"], ["T2.2", "fixed"]]) {
      assert.equal(runCli(ws, ["task", "start", id]).status, 0, `start ${id}`);
      assert.equal(runCli(ws, ["task", "done", id, "--summary", summary]).status, 0, `done ${id}`);
    }
  });

  // ---- Stage 6: Subagent stop-hook isolation ---------------------------
  await t.test("stage 6: stop-guard shields subagent, continues main session", () => {
    const sub = runHook("stop-guard.mjs", {
      conversationId: "subagent-worker-1",
      workspacePaths: [ws],
      terminationReason: "NO_TOOL_CALL",
      fullyIdle: true,
    });
    assert.deepEqual(sub, {}, "subagent must terminate freely");
    const main = runHook("stop-guard.mjs", {
      conversationId: "sess-main-1",
      workspacePaths: [ws],
      terminationReason: "NO_TOOL_CALL",
      fullyIdle: true,
    });
    assert.equal(main.decision, "continue", "main session continues while T3.1 pending");
  });

  // ---- Stage 7: Interruption/resume + refinement -----------------------
  await t.test("stage 7: resume banner, refine_plan snapshot, import preserves [x] + adds T4.1", () => {
    const resume = runHook("session-start-resume.mjs", { workspacePaths: [ws] });
    assert.match(resume.injectSteps[0].ephemeralMessage, /ASD_RESUME/);

    const pf = runCli(ws, ["preflight", "--cmd", "plan", "--session", "sess-main-1"]);
    assert.equal(pf.status, 0, `refine preflight failed: ${pf.stderr}`);
    const pfOut = JSON.parse(pf.stdout);
    assert.equal(pfOut.mode, "refine_plan");
    assert.ok(fs.existsSync(pfOut.snapshots.plan), "history PLAN snapshot created");
    assert.ok(fs.existsSync(path.join(ws, ".asd", "history")), ".asd/history/ exists");

    fs.writeFileSync(path.join(ws, ".asd", "PLAN.md"), PLAN_V2, "utf8");
    const imp = runCli(ws, ["plan-import"]);
    assert.equal(imp.status, 0, `re-import failed: ${imp.stderr}`);
    for (const id of ["T1.1", "T1.2", "T2.1", "T2.2"]) {
      assert.match(todoRow(ws, id), /^- \[x\] /, `${id} completion preserved`);
    }
    assert.match(todoRow(ws, "T4.1"), /^- \[ \] \[BUILD\] T4\.1 /, "T4.1 added by refinement");
  });
});
