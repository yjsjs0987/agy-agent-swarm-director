// @ts-check
// allow: SIZE_OK — the plan mandates a single test file (tests/session-preflight.test.mjs);
// splitting would create files outside the approved deliverable set.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  loadOrInitSession,
  isMainOrchestratorSession,
} from "../scripts/lib/session.mjs";
import { runPreflight } from "../scripts/lib/preflight.mjs";
import { renderPlanTemplate } from "../scripts/lib/render.mjs";
import { readJsonSafe } from "../scripts/lib/fs-atomic.mjs";

/**
 * Fresh os.tmpdir() subdirectory per test; removed via t.after.
 * @param {import("node:test").TestContext} t
 * @returns {string}
 */
function freshDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "asd-session-"));
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

/** @param {string} ws @returns {string} */
const ASD = (ws) => path.join(ws, ".asd");

/**
 * Valid two-task PLAN.md (renderPlanTemplate output passes
 * validatePlanMarkdown). `allDone` marks every task `[x]`.
 * @param {{ allDone?: boolean }} [opts]
 * @returns {string}
 */
function planMd(opts = {}) {
  const md = renderPlanTemplate({
    slug: "demo",
    title: "Demo Plan",
    projectState: "clean repo",
    understoodCommand: "demo the plugin",
    questions: [],
    options: {
      includeTests: true,
      includeDebug: false,
      gitCheckpoint: true,
      learnings: true,
      profile: "balanced",
    },
    turns: [{ turn: 1, title: "Build & verify" }],
    tasks: [
      { turn: 1, task: 1, flag: "BUILD", summary: "build the thing", tier: "flash", files: ["src/a.js"], category: "general", difficulty: "reasoning-low" },
      { turn: 1, task: 2, flag: "VERIFY", summary: "verify the thing", tier: "flash", files: [], category: "verification", difficulty: "reasoning-low" },
    ],
    criteria: ["all tests pass"],
    amendments: [],
  });
  return opts.allDone ? md.replace(/- \[ \]/g, "- [x]") : md;
}

/**
 * Overwrites session.json fields (tests simulate holder phase/lastSeenAt
 * directly, without going through the lock path).
 * @param {string} ws
 * @param {Record<string, unknown>} patch
 */
function patchSession(ws, patch) {
  const p = path.join(ASD(ws), "session.json");
  const s = readJsonSafe(p, null);
  fs.writeFileSync(p, JSON.stringify({ ...s, ...patch }, null, 2) + "\n");
}

/** A fully valid state.json payload (passes validateState). */
function validState() {
  return {
    schemaVersion: 1,
    slug: "demo",
    title: "Demo Plan",
    phase: "running",
    profile: "balanced",
    options: { includeTests: true, includeDebug: false, gitCheckpoint: true, learnings: true, locale: "ko", maxConcurrent: 4 },
    limits: { maxTurns: 10, maxTasksTotal: 100, maxAttemptsPerTask: 2, maxNoProgressContinues: 3, proCap: 2 },
    counters: { flash_lite: 0, flash: 0, pro: 0, orchestrator: 0, noProgressContinues: 0 },
    currentTurn: 1,
    turns: [{ turn: 1, title: "Build & verify", status: "in_progress", checkpointCommit: null, baselineSnapshot: null }],
    tasks: [
      { id: "T1.1", turn: 1, task: 1, flag: "BUILD", summary: "build the thing", category: "general", difficulty: "reasoning-low", tier: "flash", role: "worker", status: "x", files: ["src/a.js"], dependsOn: [], acceptance: "it builds", attempts: 1, lastError: null, subagentId: null, evidencePath: null },
      { id: "T1.2", turn: 1, task: 2, flag: "VERIFY", summary: "verify the thing", category: "verification", difficulty: "reasoning-low", tier: "flash", role: "verifier", status: " ", files: [], dependsOn: ["T1.1"], acceptance: "tests pass", attempts: 0, lastError: null, subagentId: null, evidencePath: null },
    ],
    lintErrors: [],
    updatedAt: new Date().toISOString(),
  };
}

test("runPreflight plan/asd on a new workspace creates .asd skeleton + session (new_plan)", async (t) => {
  for (const cmd of ["plan", "asd"]) {
    const ws = freshDir(t);
    const r = await runPreflight(ws, { cmd, sessionId: "conv-main" });
    assert.equal(r.mode, "new_plan");
    assert.ok(fs.existsSync(path.join(ASD(ws), "session.json")), "session.json created");
    assert.ok(fs.existsSync(path.join(ASD(ws), "history")), "history/ created");
    assert.ok(fs.existsSync(path.join(ASD(ws), "reports")), "reports/ created");
    const s = readJsonSafe(path.join(ASD(ws), "session.json"), null);
    assert.equal(s.mainConversationId, "conv-main");
    assert.equal(s.phase, "idle");
    assert.equal(s.activeCommand, cmd === "plan" ? "asd-plan" : "asd");
  }
});

test("existing PLAN.md -> refine_plan with history snapshots; original byte-identical", async (t) => {
  const ws = freshDir(t);
  fs.mkdirSync(ASD(ws), { recursive: true });
  // T1.1 completed, T1.2 pending: completed [x] must be preserved in the summary.
  const md = planMd().replace("- [ ] [BUILD]", "- [x] [BUILD]");
  const planPath = path.join(ASD(ws), "PLAN.md");
  fs.writeFileSync(planPath, md);
  fs.writeFileSync(path.join(ASD(ws), "TODO.md"), "# TODO stub\n");
  const before = fs.readFileSync(planPath);

  const r = await runPreflight(ws, { cmd: "plan", sessionId: "conv-main" });
  assert.equal(r.mode, "refine_plan");

  const after = fs.readFileSync(planPath);
  assert.ok(before.equals(after), "PLAN.md must be byte-identical after preflight");
  const history = fs.readdirSync(path.join(ASD(ws), "history"));
  const planSnap = history.find((f) => /-PLAN\.md$/.test(f));
  const todoSnap = history.find((f) => /-TODO\.md$/.test(f));
  assert.ok(planSnap, "PLAN snapshot exists in history/");
  assert.ok(todoSnap, "TODO snapshot exists in history/");
  assert.ok(!planSnap.includes(":"), "snapshot filename must be Windows-safe");
  assert.equal(
    fs.readFileSync(path.join(ASD(ws), "history", planSnap), "utf8"),
    md,
    "snapshot content matches the original PLAN.md",
  );
  const tasks = r.plan?.tasks ?? [];
  assert.equal(tasks.find((x) => x.id === "T1.1")?.status, "x");
  assert.equal(tasks.find((x) => x.id === "T1.2")?.status, " ");
});

test("fresh active session of another conversation -> lockConflict", async (t) => {
  const ws = freshDir(t);
  await loadOrInitSession(ws, { conversationId: "conv-A", command: "plan" });
  patchSession(ws, { phase: "running", lastSeenAt: new Date().toISOString() });
  const r = await runPreflight(ws, { cmd: "plan", sessionId: "conv-B" });
  assert.equal(r.mode, "locked_by_other_session");
  assert.equal(r.lockConflict, true);
  assert.equal(r.holderConversationId, "conv-A");
  // Holder is untouched on disk; the caller must ask the human about --force-takeover.
  const s = readJsonSafe(path.join(ASD(ws), "session.json"), null);
  assert.equal(s.mainConversationId, "conv-A");
});

test("stale session (>30m) is taken over and archived", async (t) => {
  const ws = freshDir(t);
  await loadOrInitSession(ws, { conversationId: "conv-A", command: "plan" });
  patchSession(ws, {
    phase: "running",
    lastSeenAt: new Date(Date.now() - 31 * 60 * 1000).toISOString(),
  });
  const r = await loadOrInitSession(ws, { conversationId: "conv-B", command: "run" });
  assert.ok("status" in r, "expected takeover, not lockConflict");
  assert.equal(r.status, "took_over_stale_session");
  const s = readJsonSafe(path.join(ASD(ws), "session.json"), null);
  assert.equal(s.mainConversationId, "conv-B");
  assert.equal(s.phase, "idle");
  assert.equal(s.previousSessions.length, 1);
  assert.equal(s.previousSessions[0].conversationId, "conv-A");
  assert.equal(s.previousSessions[0].reason, "stale_last_seen");
});

test("inactive phase (done) allows takeover even when fresh", async (t) => {
  const ws = freshDir(t);
  await loadOrInitSession(ws, { conversationId: "conv-A", command: "plan" });
  patchSession(ws, { phase: "done" }); // lastSeenAt is fresh
  const r = await loadOrInitSession(ws, { conversationId: "conv-B", command: "plan" });
  assert.ok("status" in r);
  assert.equal(r.status, "took_over_stale_session");
  assert.equal(r.session.previousSessions.length, 1);
  assert.equal(r.session.previousSessions[0].reason, "inactive_phase_done");
});

test("forceTakeover seizes a fresh active session", async (t) => {
  const ws = freshDir(t);
  await loadOrInitSession(ws, { conversationId: "conv-A", command: "plan" });
  patchSession(ws, { phase: "running", lastSeenAt: new Date().toISOString() });
  const r = await loadOrInitSession(ws, {
    conversationId: "conv-B",
    command: "run",
    forceTakeover: true,
  });
  assert.ok("status" in r);
  assert.equal(r.status, "took_over_forced");
  const s = readJsonSafe(path.join(ASD(ws), "session.json"), null);
  assert.equal(s.mainConversationId, "conv-B");
  assert.equal(s.previousSessions[0].reason, "forced_takeover");
});

test("isMainOrchestratorSession: main true; subagent and missing false", async (t) => {
  const empty = freshDir(t); // no .asd/ at all
  assert.equal(isMainOrchestratorSession(empty, "conv-main"), false);
  const ws = freshDir(t);
  await loadOrInitSession(ws, { conversationId: "conv-main", command: "plan" });
  assert.equal(isMainOrchestratorSession(ws, "conv-main"), true);
  assert.equal(isMainOrchestratorSession(ws, "subagent-worker-1"), false);
});

test("same-conversation heartbeat returns ok and refreshes lastSeenAt/activeCommand", async (t) => {
  const ws = freshDir(t);
  const first = await loadOrInitSession(ws, { conversationId: "conv-A", command: "plan" });
  assert.ok("status" in first);
  assert.equal(first.status, "created");
  const before = readJsonSafe(path.join(ASD(ws), "session.json"), null);
  const r = await loadOrInitSession(ws, { conversationId: "conv-A", command: "status" });
  assert.ok("status" in r);
  assert.equal(r.status, "ok");
  const after = readJsonSafe(path.join(ASD(ws), "session.json"), null);
  assert.equal(after.activeCommand, "asd-status");
  assert.ok(Date.parse(after.lastSeenAt) >= Date.parse(before.lastSeenAt));
});

test("corrupt session.json is re-initialized (adversarial: malformed input)", async (t) => {
  const ws = freshDir(t);
  fs.mkdirSync(ASD(ws), { recursive: true });
  fs.writeFileSync(path.join(ASD(ws), "session.json"), "{ not json !!");
  const r = await loadOrInitSession(ws, { conversationId: "conv-A", command: "plan" });
  assert.ok("status" in r);
  assert.equal(r.status, "created");
  const s = readJsonSafe(path.join(ASD(ws), "session.json"), null);
  assert.equal(s.mainConversationId, "conv-A");
});

test("run without PLAN.md refuses with guidance", async (t) => {
  const ws = freshDir(t);
  const r = await runPreflight(ws, { cmd: "run", sessionId: "conv-A" });
  assert.equal(r.mode, "refuse_no_plan");
  assert.ok(r.guidance?.includes("/asd-plan"));
});

test("run with unfinished tasks -> resume_or_start_run with nextTurn + readyTasks", async (t) => {
  const ws = freshDir(t);
  fs.mkdirSync(ASD(ws), { recursive: true });
  fs.writeFileSync(path.join(ASD(ws), "PLAN.md"), planMd());
  const r = await runPreflight(ws, { cmd: "run", sessionId: "conv-A" });
  assert.equal(r.mode, "resume_or_start_run");
  assert.equal(r.nextTurn, 1);
  assert.equal(r.readyTasks?.length, 2);
});

test("run with all tasks [x] -> already_done", async (t) => {
  const ws = freshDir(t);
  fs.mkdirSync(ASD(ws), { recursive: true });
  fs.writeFileSync(path.join(ASD(ws), "PLAN.md"), planMd({ allDone: true }));
  const r = await runPreflight(ws, { cmd: "run", sessionId: "conv-A" });
  assert.equal(r.mode, "already_done");
});

test("run prefers valid state.json: dependency filtering applies", async (t) => {
  const ws = freshDir(t);
  fs.mkdirSync(ASD(ws), { recursive: true });
  fs.writeFileSync(path.join(ASD(ws), "PLAN.md"), planMd());
  fs.writeFileSync(path.join(ASD(ws), "state.json"), JSON.stringify(validState(), null, 2));
  const r = await runPreflight(ws, { cmd: "run", sessionId: "conv-A" });
  assert.equal(r.mode, "resume_or_start_run");
  assert.equal(r.nextTurn, 1);
  assert.equal(r.readyTasks?.length, 1, "T1.2 only: T1.1 done, T1.2 depends on it");
  assert.equal(r.readyTasks?.[0]?.id, "T1.2");
});

test("status without state.json: summary with null todoMarkdown", async (t) => {
  const ws = freshDir(t);
  const r = await runPreflight(ws, { cmd: "status", sessionId: "conv-A" });
  assert.equal(r.mode, "status");
  assert.equal(r.phase, "idle");
  assert.equal(r.todoMarkdown, null);
  assert.equal(r.turnProgress, null);
  assert.equal(r.artifacts?.state, false);
});

test("status with valid state.json renders TODO markdown + turn progress", async (t) => {
  const ws = freshDir(t);
  fs.mkdirSync(ASD(ws), { recursive: true });
  fs.writeFileSync(path.join(ASD(ws), "state.json"), JSON.stringify(validState(), null, 2));
  const r = await runPreflight(ws, { cmd: "status", sessionId: "conv-A" });
  assert.equal(r.mode, "status");
  assert.equal(r.phase, "idle"); // session phase, not state phase
  assert.equal(r.turnProgress?.currentTurn, 1);
  assert.equal(r.turnProgress?.doneTasks, 1);
  assert.equal(r.turnProgress?.totalTasks, 2);
  assert.ok(r.todoMarkdown?.includes("# ASD TODO"));
  assert.ok(r.todoMarkdown?.includes("T1.2"));
});

test("status tolerates corrupt state.json (adversarial: malformed input)", async (t) => {
  const ws = freshDir(t);
  fs.mkdirSync(ASD(ws), { recursive: true });
  fs.writeFileSync(path.join(ASD(ws), "state.json"), "<<corrupt>>");
  const r = await runPreflight(ws, { cmd: "status", sessionId: "conv-A" });
  assert.equal(r.mode, "status");
  assert.equal(r.todoMarkdown, null);
  assert.equal(r.artifacts?.state, false);
});

test("unknown cmd throws TypeError", async (t) => {
  const ws = freshDir(t);
  await assert.rejects(
    runPreflight(ws, { cmd: "bogus", sessionId: "conv-A" }),
    TypeError,
  );
});
