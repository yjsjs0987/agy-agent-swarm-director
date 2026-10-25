// @ts-check
// allow: SIZE_OK — the overage is pure fixture data (validateState-clean
// session.json/state.json literals the plan mandates); logic is well under 250.
/**
 * Stdin-fixture tests for `scripts/hooks/pre-tool-guard.mjs` (plan Todo 15).
 *
 * Every scenario spawns the hook as a REAL child process (the only honest way
 * to test stdin/stdout/exit-code behavior) using a fresh tmp workspace. Every
 * captured stdout is recorded for the global never-allow scan (test 10).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HOOK = fileURLToPath(new URL("../scripts/hooks/pre-tool-guard.mjs", import.meta.url));

/** Every stdout the hook ever produced in this suite (never-allow scan). */
const allOutputs = [];

/**
 * Spawns the hook with `stdin` (objects are JSON-serialized), asserts exit 0,
 * records stdout for the global scan, and returns `{ stdout, ms }`.
 * @param {Record<string, unknown> | string} stdin
 */
function runHook(stdin) {
  const input = typeof stdin === "string" ? stdin : JSON.stringify(stdin);
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [HOOK], {
    input,
    encoding: "utf8",
    timeout: 10000,
  });
  const ms = Date.now() - t0;
  assert.equal(r.status, 0, `hook must exit 0 (stderr: ${r.stderr})`);
  const stdout = r.stdout ?? "";
  allOutputs.push(stdout);
  return { stdout, ms };
}

/** Fresh tmp workspace, removed in `t.after`. @param {import("node:test").TestContext} t */
function freshWs(t) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "asd-hook-"));
  t.after(() => {
    fs.rmSync(ws, { recursive: true, force: true });
  });
  return ws;
}

const now = () => new Date().toISOString();

/**
 * Writes a validateSession-clean `.asd/session.json` held by "conv-main".
 * @param {string} ws
 * @param {Record<string, unknown>} [patch]
 */
function writeSession(ws, patch = {}) {
  fs.mkdirSync(path.join(ws, ".asd"), { recursive: true });
  fs.writeFileSync(
    path.join(ws, ".asd", "session.json"),
    JSON.stringify(
      {
        schemaVersion: 1,
        mainConversationId: "conv-main",
        projectRoot: ws,
        activeCommand: "asd-run",
        phase: "running",
        startedAt: now(),
        lastSeenAt: now(),
        autonomyGranted: false,
        previousSessions: [],
        ...patch,
      },
      null,
      2,
    ) + "\n",
  );
}

/** A validateState-clean state payload. @param {Record<string, unknown>} [patch] */
function state(patch = {}) {
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
    ],
    lintErrors: [],
    updatedAt: now(),
    ...patch,
  };
}

/** @param {string} ws @param {Record<string, unknown>} s */
function writeState(ws, s) {
  fs.mkdirSync(path.join(ws, ".asd"), { recursive: true });
  fs.writeFileSync(path.join(ws, ".asd", "state.json"), JSON.stringify(s, null, 2) + "\n");
}

test("1. workspace without .asd/ -> {} exit 0, fast exit < 150ms", (t) => {
  const ws = freshWs(t);
  const r = runHook({
    conversationId: "conv-main",
    workspacePaths: [ws],
    toolCall: { name: "write_to_file", args: { path: "src/a.js" } },
  });
  assert.equal(r.stdout, "{}");
  assert.ok(r.ms < 150, `fast-exit took ${r.ms}ms (must be < 150ms)`);
});

test("2. direct write to .asd/TODO.md -> ASD_FORMAT_GUARD deny; non-machine .asd files pass", (t) => {
  const ws = freshWs(t);
  writeSession(ws);
  const r = runHook({
    conversationId: "conv-main",
    workspacePaths: [ws],
    toolCall: { name: "write_to_file", args: { path: path.join(ws, ".asd", "TODO.md") } },
  });
  const out = JSON.parse(r.stdout);
  assert.equal(out.decision, "deny");
  assert.match(out.reason, /\[ASD_FORMAT_GUARD\]/);
  assert.match(out.reason, /node "scripts\/asd\.mjs" <subcommand>/);
  // PLAN.md / interview.md / learnings.md are NOT machine files -> pass-through.
  const ok = runHook({
    conversationId: "conv-main",
    workspacePaths: [ws],
    toolCall: { name: "write_to_file", args: { path: path.join(ws, ".asd", "PLAN.md") } },
  });
  assert.equal(ok.stdout, "{}");
  // Relative path + PathToCurrentFile key are guarded too.
  const rel = runHook({
    conversationId: "conv-main",
    workspacePaths: [ws],
    toolCall: { name: "replace_file_content", args: { PathToCurrentFile: ".asd/state.json" } },
  });
  assert.match(JSON.parse(rel.stdout).reason, /\[ASD_FORMAT_GUARD\]/);
});

test("3. source edit during planning phase -> ASD_PLAN_GUARD (main AND scout subagent)", (t) => {
  const ws = freshWs(t);
  writeSession(ws, { phase: "planning", activeCommand: "asd-plan" });
  writeState(ws, state({ phase: "planning" }));
  for (const conv of ["conv-main", "conv-scout-sub"]) {
    const r = runHook({
      conversationId: conv,
      workspacePaths: [ws],
      toolCall: { name: "write_to_file", args: { path: path.join(ws, "src", "a.js") } },
    });
    const out = JSON.parse(r.stdout);
    assert.equal(out.decision, "deny");
    assert.match(out.reason, /\[ASD_PLAN_GUARD\]/);
  }
});

test("4. worker subagent source edit during running phase -> {} pass-through", (t) => {
  const ws = freshWs(t);
  writeSession(ws);
  writeState(ws, state({ phase: "running" }));
  const r = runHook({
    conversationId: "conv-worker-sub",
    workspacePaths: [ws],
    toolCall: { name: "write_to_file", args: { path: path.join(ws, "src", "a.js") } },
  });
  assert.equal(r.stdout, "{}");
});

test("5. invoke_subagent Model 'inherit' -> ASD_MODEL_POLICY deny with resolved target tier", (t) => {
  const ws = freshWs(t);
  writeSession(ws);
  writeState(ws, state({ phase: "running" }));
  const r = runHook({
    conversationId: "conv-main",
    workspacePaths: [ws],
    toolCall: { name: "invoke_subagent", args: { Model: "inherit", Prompt: "[ASD_ROLE: worker] do it" } },
  });
  const out = JSON.parse(r.stdout);
  assert.equal(out.decision, "deny");
  assert.match(out.reason, /\[ASD_MODEL_POLICY\]/);
  assert.match(out.reason, /Model: 'flash'/); // balanced profile worker role -> flash
  assert.match(out.reason, /active profile: balanced/);
});

test("6. invoke_subagent Model 'pro' under eco profile -> ASD_BUDGET_GUARD deny", (t) => {
  const ws = freshWs(t);
  writeSession(ws);
  const base = state();
  writeState(ws, state({ phase: "running", profile: "eco", limits: { ...base.limits, proCap: 0 } }));
  const r = runHook({
    conversationId: "conv-main",
    workspacePaths: [ws],
    toolCall: { name: "invoke_subagent", args: { Model: "pro", Prompt: "hard task" } },
  });
  const out = JSON.parse(r.stdout);
  assert.equal(out.decision, "deny");
  assert.match(out.reason, /\[ASD_BUDGET_GUARD\]/);
  assert.match(out.reason, /Profile 'eco'/);
  assert.match(out.reason, /Model: 'flash'/);
});

test("7. malformed stdin (binary garbage, truncated JSON, empty) -> {} exit 0", () => {
  for (const bad of ["\u0000\u0001\u0002 not json at all", '{"conversationId":"x",', ""]) {
    const r = runHook(bad);
    assert.equal(r.stdout, "{}");
  }
});

test("8. main-session running-phase edit WITHOUT orchestrator task -> ASD_ORCHESTRATOR_DELEGATION_GUARD", (t) => {
  const ws = freshWs(t);
  writeSession(ws);
  writeState(ws, state({ phase: "running" })); // only task is status "x" tier "flash"
  const r = runHook({
    conversationId: "conv-main",
    workspacePaths: [ws],
    toolCall: { name: "write_to_file", args: { path: path.join(ws, "src", "a.js") } },
  });
  const out = JSON.parse(r.stdout);
  assert.equal(out.decision, "deny");
  assert.match(out.reason, /\[ASD_ORCHESTRATOR_DELEGATION_GUARD\]/);
});

test("9. main-session edit covered by an in-progress orchestrator-tier task -> {} pass-through", (t) => {
  const ws = freshWs(t);
  writeSession(ws);
  const s = state({ phase: "running" });
  s.tasks.push({
    id: "T1.2", turn: 1, task: 2, flag: "BUILD", summary: "escalated fix", category: "general",
    difficulty: "reasoning-low", tier: "orchestrator", role: "worker", status: ">",
    files: ["src/a.js"], dependsOn: [], acceptance: "fixed", attempts: 3,
    lastError: "subagents failed", subagentId: null, evidencePath: null,
  });
  writeState(ws, s);
  const covered = runHook({
    conversationId: "conv-main",
    workspacePaths: [ws],
    toolCall: { name: "write_to_file", args: { path: path.join(ws, "src", "a.js") } },
  });
  assert.equal(covered.stdout, "{}");
  // A file NOT in the orchestrator task's files[] is still denied.
  const other = runHook({
    conversationId: "conv-main",
    workspacePaths: [ws],
    toolCall: { name: "write_to_file", args: { path: path.join(ws, "src", "b.js") } },
  });
  assert.match(JSON.parse(other.stdout).reason, /\[ASD_ORCHESTRATOR_DELEGATION_GUARD\]/);
});

test("adversarial: missing workspacePaths, no path key, traversal -> safe output, exit 0", (t) => {
  // Missing workspacePaths entirely -> fast neutral.
  const r0 = runHook({ conversationId: "c", toolCall: { name: "write_to_file", args: { path: "x" } } });
  assert.equal(r0.stdout, "{}");
  const ws = freshWs(t);
  writeSession(ws);
  writeState(ws, state({ phase: "planning" }));
  // Write tool without any recognizable path key -> neutral (cannot resolve a target).
  const r1 = runHook({
    conversationId: "conv-main",
    workspacePaths: [ws],
    toolCall: { name: "write_to_file", args: { content: "x" } },
  });
  assert.equal(r1.stdout, "{}");
  // Traversal that resolves back into a machine file -> FORMAT_GUARD.
  const r2 = runHook({
    conversationId: "conv-main",
    workspacePaths: [ws],
    toolCall: { name: "write_to_file", args: { path: path.join(ws, ".asd", "..", ".asd", "TODO.md") } },
  });
  assert.match(JSON.parse(r2.stdout).reason, /\[ASD_FORMAT_GUARD\]/);
  // Traversal escaping the workspace during planning -> PLAN_GUARD (outside .asd/).
  const r3 = runHook({
    conversationId: "conv-main",
    workspacePaths: [ws],
    toolCall: { name: "write_to_file", args: { path: path.join(ws, "..", "outside-escape.js") } },
  });
  assert.match(JSON.parse(r3.stdout).reason, /\[ASD_PLAN_GUARD\]/);
});

test("10. global: no hook output in this suite ever contains decision allow", () => {
  assert.ok(allOutputs.length >= 10, `expected recorded outputs, got ${allOutputs.length}`);
  for (const out of allOutputs) {
    assert.doesNotMatch(out, /"decision":\s*"allow"/, `forbidden allow decision: ${out}`);
  }
});
