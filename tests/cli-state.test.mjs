// @ts-check
// allow: SIZE_OK — the plan mandates a single test file (tests/cli-state.test.mjs);
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "asd-cli-"));
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

/** @param {string} ws @returns {any[]} */
const ledgerOf = (ws) =>
  fs
    .readFileSync(path.join(ws, ".asd", "ledger.jsonl"), "utf8")
    .trim()
    .split(/\r?\n/)
    .map((l) => JSON.parse(l));

/* ------------------------------------------------------------------ */

test("happy chain: init -> todo add -> turn next -> task start -> task fail -> task done", (t) => {
  const ws = freshDir(t);
  fs.mkdirSync(path.join(ws, "src"), { recursive: true });
  fs.writeFileSync(path.join(ws, "src", "a.js"), "console.log(1);\n");

  ok(ws, ["init", "--slug", "demo", "--title", "Demo Plan"]);
  assert.ok(fs.existsSync(path.join(ws, ".asd", "state.json")));
  assert.ok(fs.existsSync(path.join(ws, ".asd", "TODO.md")));
  assert.ok(fs.existsSync(path.join(ws, ".asd", "session.json")));
  const st0 = stateOf(ws);
  assert.equal(st0.phase, "planning");
  assert.equal(st0.profile, "balanced");
  assert.equal(st0.options.maxConcurrent, 8);
  assert.equal(st0.limits.maxAttemptsPerTask, 3);
  assert.equal(st0.limits.proCap, 2);
  assert.equal(st0.currentTurn, 0);
  assertTodoGrammar(ws);

  ok(ws, [
    "todo", "add", "--turn", "1", "--flag", "BUILD",
    "--summary", "build the thing",
    "--difficulty", "reasoning-none", "--tier", "flash_lite",
    "--files", "src/a.js",
  ]);
  assertTodoGrammar(ws);
  let st = stateOf(ws);
  assert.equal(st.tasks.length, 1);
  assert.equal(st.tasks[0].id, "T1.1");
  assert.equal(st.tasks[0].tier, "flash_lite");
  assert.equal(st.tasks[0].role, "worker");
  assert.equal(st.tasks[0].status, " ");
  assert.deepEqual(st.tasks[0].files, ["src/a.js"]);

  ok(ws, ["turn", "next"]);
  assertTodoGrammar(ws);
  st = stateOf(ws);
  assert.equal(st.currentTurn, 1);
  const entry = st.turns.find((/** @type {any} */ x) => x.turn === 1);
  assert.equal(entry.status, "in_progress");
  assert.ok(entry.baselineSnapshot && typeof entry.baselineSnapshot === "object");
  const snap = entry.baselineSnapshot["src/a.js"];
  assert.ok(snap, "baseline snapshot must include src/a.js");
  assert.match(snap.sha256, /^[0-9a-f]{64}$/);
  assert.equal(typeof snap.mtimeMs, "number");
  assert.equal(
    Object.keys(entry.baselineSnapshot).some((k) => k.startsWith(".asd/")),
    false,
    ".asd/** must be excluded from the baseline",
  );

  ok(ws, ["task", "start", "T1.1", "--subagent", "w1"]);
  assertTodoGrammar(ws);
  st = stateOf(ws);
  assert.equal(st.tasks[0].status, ">");
  assert.equal(st.tasks[0].subagentId, "w1");

  ok(ws, ["task", "fail", "T1.1", "--reason", "boom"]);
  assertTodoGrammar(ws);
  st = stateOf(ws);
  assert.equal(st.tasks[0].attempts, 1);
  assert.equal(st.tasks[0].tier, "flash", "flash_lite must escalate to flash");
  assert.equal(st.tasks[0].status, " ", "escalate keeps the task pending");
  assert.equal(st.tasks[0].lastError, "boom");
  const failRow = ledgerOf(ws).find((/** @type {any} */ r) => r.event === "task_fail");
  assert.equal(failRow.taskId, "T1.1");
  assert.equal(failRow.reason, "boom");
  assert.equal(failRow.nextTier, "flash");
  assert.equal(failRow.action, "escalate");

  ok(ws, ["task", "done", "T1.1", "--evidence", "ev.txt", "--summary", "done ok"]);
  assertTodoGrammar(ws);
  st = stateOf(ws);
  assert.equal(st.tasks[0].status, "x");
  assert.equal(st.tasks[0].evidencePath, "ev.txt");
  const doneRow = ledgerOf(ws).find((/** @type {any} */ r) => r.event === "task_done");
  assert.equal(doneRow.taskId, "T1.1");
  assert.equal(doneRow.summary, "done ok");
});

test("turn next --json returns <=8 ready tasks with resolved tiers and marks the turn in_progress", (t) => {
  const ws = freshDir(t);
  ok(ws, ["init", "--slug", "demo", "--title", "Demo Plan"]);
  for (let i = 1; i <= 10; i++) {
    ok(ws, ["todo", "add", "--turn", "1", "--flag", "BUILD", "--summary", `task number ${i}`]);
  }
  ok(ws, ["todo", "add", "--turn", "2", "--flag", "VERIFY", "--summary", "verify all", "--depends", "T1.1"]);
  const r = ok(ws, ["--json", "turn", "next"]);
  const out = JSON.parse(r.stdout);
  assert.equal(out.turn, 1, "first turn with open tasks is Turn 1");
  assert.equal(out.tasks.length, 8, "maxConcurrent caps the ready list at 8");
  for (const task of out.tasks) {
    assert.match(task.id, /^T1\.\d+$/);
    assert.ok(["flash_lite", "flash", "pro", "orchestrator"].includes(task.tier));
    assert.ok(Array.isArray(task.files));
  }
  const st = stateOf(ws);
  const entry = st.turns.find((/** @type {any} */ x) => x.turn === 1);
  assert.equal(entry.status, "in_progress");
  assert.ok(entry.baselineSnapshot, "baselineSnapshot must be populated");
});

test("turn next excludes tasks whose dependsOn are not done", (t) => {
  const ws = freshDir(t);
  ok(ws, ["init", "--slug", "demo", "--title", "Demo Plan"]);
  ok(ws, ["todo", "add", "--turn", "1", "--flag", "BUILD", "--summary", "first thing"]);
  ok(ws, ["todo", "add", "--turn", "1", "--flag", "TEST", "--summary", "second thing", "--depends", "T1.1"]);
  const r = ok(ws, ["--json", "turn", "next"]);
  const out = JSON.parse(r.stdout);
  assert.equal(out.tasks.length, 1);
  assert.equal(out.tasks[0].id, "T1.1");
});

test("summary writes SUMMARY.md with ASD-SUMMARY-V1 and transitions phases to done", (t) => {
  const ws = freshDir(t);
  ok(ws, ["init", "--slug", "demo", "--title", "Demo Plan"]);
  ok(ws, ["todo", "add", "--turn", "1", "--flag", "BUILD", "--summary", "build it"]);
  ok(ws, ["turn", "next"]);
  ok(ws, ["task", "done", "T1.1"]);
  const r = ok(ws, ["summary", "--notes", "all good"]);
  const md = fs.readFileSync(path.join(ws, ".asd", "SUMMARY.md"), "utf8");
  assert.ok(md.includes("ASD-SUMMARY-V1"));
  assert.ok(md.includes("all good"));
  assert.ok(r.stdout.includes("# ASD SUMMARY"), "final summary printed to stdout");
  assert.equal(stateOf(ws).phase, "done");
  const session = readJsonSafe(path.join(ws, ".asd", "session.json"), null);
  assert.equal(session.phase, "done");
});

test("status --json outputs parseable JSON", (t) => {
  const ws = freshDir(t);
  ok(ws, ["init", "--slug", "demo", "--title", "Demo Plan"]);
  const r = ok(ws, ["--json", "status"]);
  const out = JSON.parse(r.stdout);
  assert.ok(out.session);
  assert.equal(out.session.mainConversationId, "asd-cli");
  assert.equal(typeof out.currentTurn, "number");
  assert.ok(out.counters);
  assert.ok(out.todoMarkdown.includes("ASD-GENERATED"));
});

test("phase set updates state and session; --approve-autonomy grants autonomy", (t) => {
  const ws = freshDir(t);
  ok(ws, ["init", "--slug", "demo", "--title", "Demo Plan"]);
  ok(ws, ["phase", "set", "running", "--approve-autonomy"]);
  assert.equal(stateOf(ws).phase, "running");
  const session = readJsonSafe(path.join(ws, ".asd", "session.json"), null);
  assert.equal(session.phase, "running");
  assert.equal(session.autonomyGranted, true);
  const bad = run(ws, ["phase", "set", "warp-speed"]);
  assert.equal(bad.status, 1);
  assert.ok(bad.stderr.includes("phase must be one of"));
});

test("todo update changes status and summary", (t) => {
  const ws = freshDir(t);
  ok(ws, ["init", "--slug", "demo", "--title", "Demo Plan"]);
  ok(ws, ["todo", "add", "--turn", "1", "--flag", "BUILD", "--summary", "original summary"]);
  ok(ws, ["todo", "update", "T1.1", "--status", "x", "--summary", "revised summary"]);
  assertTodoGrammar(ws);
  const st = stateOf(ws);
  assert.equal(st.tasks[0].status, "x");
  assert.equal(st.tasks[0].summary, "revised summary");
  const bad = run(ws, ["todo", "update", "T1.1", "--status", "nope"]);
  assert.equal(bad.status, 1);
  assert.ok(bad.stderr.includes("--status must be one of"));
});

test("preflight --cmd status prints a JSON result", (t) => {
  const ws = freshDir(t);
  ok(ws, ["init", "--slug", "demo", "--title", "Demo Plan"]);
  const r = ok(ws, ["--json", "preflight", "--cmd", "status"]);
  const out = JSON.parse(r.stdout);
  assert.equal(out.mode, "status");
  assert.ok(out.session);
});

test("invalid todo add flag exits 1 with stderr and leaves state byte-unchanged", (t) => {
  const ws = freshDir(t);
  ok(ws, ["init", "--slug", "demo", "--title", "Demo Plan"]);
  const before = fs.readFileSync(path.join(ws, ".asd", "state.json"));
  const r = run(ws, ["todo", "add", "--turn", "1", "--flag", "INVALID", "--summary", "bad"]);
  assert.equal(r.status, 1);
  assert.ok(r.stderr.length > 0);
  assert.ok(r.stderr.includes("--flag must be one of"));
  const after = fs.readFileSync(path.join(ws, ".asd", "state.json"));
  assert.ok(before.equals(after), "state.json must be byte-unchanged on rejection");
});

test("todo add rejects summary > 40 chars", (t) => {
  const ws = freshDir(t);
  ok(ws, ["init", "--slug", "demo", "--title", "Demo Plan"]);
  const long = "x".repeat(41);
  const r = run(ws, ["todo", "add", "--turn", "1", "--flag", "BUILD", "--summary", long]);
  assert.equal(r.status, 1);
  assert.ok(r.stderr.includes("1..40 chars"));
  assert.equal(stateOf(ws).tasks.length, 0);
});

test("summary refuses when tasks are incomplete", (t) => {
  const ws = freshDir(t);
  ok(ws, ["init", "--slug", "demo", "--title", "Demo Plan"]);
  ok(ws, ["todo", "add", "--turn", "1", "--flag", "BUILD", "--summary", "build it"]);
  const r = run(ws, ["summary"]);
  assert.equal(r.status, 1);
  assert.ok(r.stderr.includes("cannot summarize"));
  assert.ok(r.stderr.includes("T1.1"));
  assert.equal(stateOf(ws).phase, "planning", "phase must not transition on refusal");
  assert.equal(fs.existsSync(path.join(ws, ".asd", "SUMMARY.md")), false);
});

test("usage errors: unknown subcommand, unknown flag, missing task, double init, empty turn next", (t) => {
  const ws = freshDir(t);
  ok(ws, ["init", "--slug", "demo", "--title", "Demo Plan"]);

  const unknown = run(ws, ["warp"]);
  assert.equal(unknown.status, 1);
  assert.ok(unknown.stderr.includes("unknown subcommand"));

  const badFlag = run(ws, ["todo", "add", "--turn", "1", "--flag", "BUILD", "--summary", "s", "--frob", "1"]);
  assert.equal(badFlag.status, 1);
  assert.ok(badFlag.stderr.includes("unknown flag"));

  const missing = run(ws, ["task", "fail", "T9.9", "--reason", "nope"]);
  assert.equal(missing.status, 1);
  assert.ok(missing.stderr.includes("not found"));

  const again = run(ws, ["init", "--slug", "demo", "--title", "Demo Plan"]);
  assert.equal(again.status, 1);
  assert.ok(again.stderr.includes("already initialized"));

  const empty = run(ws, ["turn", "next"]);
  assert.equal(empty.status, 1);
  assert.ok(empty.stderr.includes("no Turn with pending"));
});

test("task fail escalation ladder marks [!] when exhausted", (t) => {
  const ws = freshDir(t);
  // eco profile: proCap 0 -> flash retries then escalates to orchestrator/blocked.
  ok(ws, ["init", "--slug", "eco", "--title", "Eco Plan", "--profile", "eco"]);
  ok(ws, ["todo", "add", "--turn", "1", "--flag", "BUILD", "--summary", "eco task", "--tier", "flash"]);
  ok(ws, ["task", "start", "T1.1"]);
  ok(ws, ["task", "fail", "T1.1", "--reason", "try 1"]);
  let st = stateOf(ws);
  assert.equal(st.tasks[0].tier, "flash", "eco cannot reach pro; flash retries");
  assert.equal(st.tasks[0].status, " ");
  ok(ws, ["task", "fail", "T1.1", "--reason", "try 2"]);
  ok(ws, ["task", "fail", "T1.1", "--reason", "try 3"]);
  st = stateOf(ws);
  assert.equal(st.tasks[0].attempts, 3);
  assert.equal(st.tasks[0].status, "!", "exhausted attempts mark the task blocked");
  assert.equal(st.tasks[0].tier, "orchestrator");
  assertTodoGrammar(ws);
  const rows = ledgerOf(ws).filter((/** @type {any} */ r) => r.event === "task_fail");
  assert.equal(rows.length, 3);
});
