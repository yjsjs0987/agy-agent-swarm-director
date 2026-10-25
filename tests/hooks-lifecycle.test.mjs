// @ts-check
// allow: SIZE_OK — the overage is pure fixture data (validateState-clean
// session/state literals and a lint-clean PLAN.md the plan mandates); logic
// is well under 250.
/**
 * Stdin-fixture tests for the ASD lifecycle hooks (plan Todo 16):
 * session-start-resume, pre-invocation-status, post-tool-ledger, stop-guard.
 *
 * Every scenario spawns the hook as a REAL child process (the only honest way
 * to test stdin/stdout/exit-code behavior) using a fresh tmp workspace with
 * `.asd/session.json` + `.asd/state.json` seeded, cleaned up in `t.after`.
 * Every captured stdout is recorded for the global never-allow scan.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HOOKS_DIR = fileURLToPath(new URL("../scripts/hooks/", import.meta.url));
const hook = (name) => path.join(HOOKS_DIR, name);

/** Every stdout any hook ever produced in this suite (never-allow scan). */
const allOutputs = [];

/**
 * Spawns a hook with `stdin` (objects are JSON-serialized), asserts exit 0,
 * records stdout for the global scan, and returns `{ stdout, ms }`.
 * @param {string} hookName
 * @param {Record<string, unknown> | string} stdin
 */
function runHook(hookName, stdin) {
  const input = typeof stdin === "string" ? stdin : JSON.stringify(stdin);
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [hook(hookName)], {
    input,
    encoding: "utf8",
    timeout: 10000,
  });
  const ms = Date.now() - t0;
  assert.equal(r.status, 0, `${hookName} must exit 0 (stderr: ${r.stderr})`);
  const stdout = r.stdout ?? "";
  allOutputs.push(stdout);
  return { stdout, ms };
}

/** Fresh tmp workspace, removed in `t.after`. @param {import("node:test").TestContext} t */
function freshWs(t) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "asd-lifecycle-"));
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
      { id: "T1.1", turn: 1, task: 1, flag: "BUILD", summary: "build the thing", category: "general", difficulty: "reasoning-low", tier: "flash", role: "worker", status: " ", files: ["src/a.js"], dependsOn: [], acceptance: "it builds", attempts: 0, lastError: null, subagentId: null, evidencePath: null },
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

/** @param {string} ws @returns {any} */
function readState(ws) {
  return JSON.parse(fs.readFileSync(path.join(ws, ".asd", "state.json"), "utf8"));
}

/** Lint-clean PLAN.md fixture (passes validatePlanMarkdown). */
const VALID_PLAN = [
  "# Demo Plan",
  "",
  "## 1. Current Project State",
  "Empty.",
  "",
  "## 2. Understood User Command",
  "⚠️ 위 이해 내용이 의도와 다르거나 누락된 부분이 있다면 지금 알려주세요.",
  "",
  "## 3. Interview & Options",
  "(none)",
  "",
  "## 4. Turn & Task Execution Plan",
  "- [ ] [BUILD] T1.1 build the thing · flash",
  "  files: src/a.js",
  "",
  "## 5. Verification & Completion Criteria",
  "All tests pass.",
  "",
  "## 6. Runtime Amendments",
  "(none)",
  "",
].join("\n");

// ---------------------------------------------------------------------------
// session-start-resume.mjs (SessionStart, X1)
// ---------------------------------------------------------------------------

test("session-start: unfinished running state -> resume banner with turn, remaining, CLI path", (t) => {
  const ws = freshWs(t);
  writeState(ws, state({ phase: "running" })); // 1 pending task -> 1 remaining
  const r = runHook("session-start-resume.mjs", { conversationId: "conv-main", workspacePaths: [ws] });
  const out = JSON.parse(r.stdout);
  assert.ok(Array.isArray(out.injectSteps) && out.injectSteps.length === 1);
  const msg = out.injectSteps[0].ephemeralMessage;
  assert.match(msg, /\[ASD_RESUME\]/);
  assert.match(msg, /phase "running"/);
  assert.match(msg, /Turn T1/);
  assert.match(msg, /1 remaining task/);
  // CLI path resolves from the hook's own location (cwd-independent), so it
  // points at the REAL repo's scripts/asd.mjs and must be absolute.
  const cliLine = msg.split("\n").find((/** @type {string} */ l) => l.startsWith("ASD CLI: "));
  assert.ok(cliLine, `CLI line missing: ${msg}`);
  const cliPath = cliLine.slice("ASD CLI: ".length).trim();
  assert.ok(path.isAbsolute(cliPath), `CLI path must be absolute: ${cliPath}`);
  assert.equal(path.basename(cliPath), "asd.mjs");
  assert.equal(path.basename(path.dirname(cliPath)), "scripts");
  assert.match(msg, /\/asd-run/);
  assert.match(msg, /\/asd-status/);
});

test("session-start: done phase or no .asd/ -> {}", (t) => {
  const ws = freshWs(t);
  writeState(ws, state({ phase: "done" }));
  assert.equal(runHook("session-start-resume.mjs", { conversationId: "c", workspacePaths: [ws] }).stdout, "{}");
  const bare = freshWs(t);
  const r = runHook("session-start-resume.mjs", { conversationId: "c", workspacePaths: [bare] });
  assert.equal(r.stdout, "{}");
  assert.ok(r.ms < 2000, `fast-exit took ${r.ms}ms (must be < 2000ms)`);
});

// ---------------------------------------------------------------------------
// pre-invocation-status.mjs (PreInvocation)
// ---------------------------------------------------------------------------

test("pre-invocation: main session -> [ASD_STATE] with all fields + reminder; writes throttled", (t) => {
  const ws = freshWs(t);
  writeSession(ws);
  writeState(ws, state({ phase: "running", lintErrors: ["PLAN.md: MISSING_HEADING: x"] }));
  const r = runHook("pre-invocation-status.mjs", { conversationId: "conv-main", workspacePaths: [ws] });
  const out = JSON.parse(r.stdout);
  const msg = out.injectSteps[0].ephemeralMessage;
  assert.match(msg, /\[ASD_STATE\] cli="/);
  assert.match(msg, /session="conv-main"/);
  assert.match(msg, /phase="running"/);
  assert.match(msg, /profile="balanced"/);
  assert.match(msg, /turn="T1"/);
  assert.match(msg, /pending=1 in_progress=0 done=0 blocked=0/);
  assert.match(msg, /LINT: PLAN\.md: MISSING_HEADING/);
  assert.match(msg, /Remember: update and print \.asd\/TODO\.md/);
  assert.ok(msg.split("\n").length <= 6, `message must be <= 6 lines, got ${msg.split("\n").length}`);
  // Writes happened: orchestrator counter incremented, lastSeenAt refreshed.
  assert.equal(readState(ws).counters.orchestrator, 1);
  const session = JSON.parse(fs.readFileSync(path.join(ws, ".asd", "session.json"), "utf8"));
  assert.ok(Date.parse(session.lastSeenAt) >= Date.now() - 60_000);
  // Second call within 30s: message still injected, but writes are throttled.
  const r2 = runHook("pre-invocation-status.mjs", { conversationId: "conv-main", workspacePaths: [ws] });
  assert.match(JSON.parse(r2.stdout).injectSteps[0].ephemeralMessage, /\[ASD_STATE\]/);
  assert.equal(readState(ws).counters.orchestrator, 1, "throttle must skip the second increment");
});

test("pre-invocation: subagent conversationId -> {} immediately", (t) => {
  const ws = freshWs(t);
  writeSession(ws);
  writeState(ws, state());
  const r = runHook("pre-invocation-status.mjs", { conversationId: "conv-subagent-1", workspacePaths: [ws] });
  assert.equal(r.stdout, "{}");
  assert.equal(readState(ws).counters.orchestrator, 0, "subagent must not bump the orchestrator counter");
});

// ---------------------------------------------------------------------------
// post-tool-ledger.mjs (PostToolUse)
// ---------------------------------------------------------------------------

test("post-tool-ledger: invoke_subagent -> always {} + ledger row + tier counter", (t) => {
  const ws = freshWs(t);
  writeSession(ws);
  writeState(ws, state());
  const r = runHook("post-tool-ledger.mjs", {
    conversationId: "conv-main",
    workspacePaths: [ws],
    toolCall: { name: "invoke_subagent", args: { Model: "flash", Prompt: "do it" } },
  });
  assert.equal(r.stdout, "{}", "PostToolUse must ALWAYS output {}");
  const ledger = fs.readFileSync(path.join(ws, ".asd", "ledger.jsonl"), "utf8").trim().split("\n");
  assert.equal(ledger.length, 1);
  const row = JSON.parse(ledger[0]);
  assert.equal(row.event, "subagent_dispatch");
  assert.equal(row.tool, "invoke_subagent");
  assert.equal(row.tier, "flash");
  assert.equal(readState(ws).counters.flash, 1);
});

test("post-tool-ledger: malformed PLAN.md write -> lintErrors recorded; valid write clears them", (t) => {
  const ws = freshWs(t);
  writeSession(ws);
  writeState(ws, state());
  const planPath = path.join(ws, ".asd", "PLAN.md");
  fs.writeFileSync(planPath, "not a plan at all\n");
  const bad = runHook("post-tool-ledger.mjs", {
    conversationId: "conv-main",
    workspacePaths: [ws],
    toolCall: { name: "write_to_file", args: { path: planPath } },
  });
  assert.equal(bad.stdout, "{}");
  const linted = readState(ws).lintErrors;
  assert.ok(linted.length > 0, "violations must be stored in state.lintErrors");
  assert.ok(linted.every((/** @type {string} */ e) => e.startsWith("PLAN.md: ")));
  // A lint-clean write clears the errors.
  fs.writeFileSync(planPath, VALID_PLAN);
  const good = runHook("post-tool-ledger.mjs", {
    conversationId: "conv-main",
    workspacePaths: [ws],
    toolCall: { name: "write_to_file", args: { path: planPath } },
  });
  assert.equal(good.stdout, "{}");
  assert.deepEqual(readState(ws).lintErrors, []);
});

test("post-tool-ledger: non-matching tool -> {} and no ledger file", (t) => {
  const ws = freshWs(t);
  writeSession(ws);
  writeState(ws, state());
  const r = runHook("post-tool-ledger.mjs", {
    conversationId: "conv-main",
    workspacePaths: [ws],
    toolCall: { name: "run_command", args: { CommandLine: "npm test" } },
  });
  assert.equal(r.stdout, "{}");
  assert.ok(!fs.existsSync(path.join(ws, ".asd", "ledger.jsonl")));
});

// ---------------------------------------------------------------------------
// stop-guard.mjs (Stop)
// ---------------------------------------------------------------------------

test("stop-guard: main session, running, tasks remain, fullyIdle -> decision continue + counter bump", (t) => {
  const ws = freshWs(t);
  writeSession(ws);
  writeState(ws, state({ phase: "running" })); // 1 pending task
  const r = runHook("stop-guard.mjs", {
    conversationId: "conv-main",
    workspacePaths: [ws],
    terminationReason: "NO_TOOL_CALL",
    fullyIdle: true,
  });
  const out = JSON.parse(r.stdout);
  assert.equal(out.decision, "continue");
  assert.match(out.reason, /\[ASD_AUTONOMOUS_RUN\]/);
  assert.match(out.reason, /Turn T1 has 1 remaining tasks/);
  assert.match(out.reason, /Continue \/asd-run/);
  assert.equal(readState(ws).counters.noProgressContinues, 1);
});

test("stop-guard: subagent conversationId -> {} (NEVER trapped)", (t) => {
  const ws = freshWs(t);
  writeSession(ws);
  writeState(ws, state({ phase: "running" }));
  const r = runHook("stop-guard.mjs", {
    conversationId: "subagent-uuid-999",
    workspacePaths: [ws],
    terminationReason: "NO_TOOL_CALL",
    fullyIdle: true,
  });
  assert.equal(r.stdout, "{}");
  assert.equal(readState(ws).counters.noProgressContinues, 0);
});

test("stop-guard: fullyIdle false -> {}; USER_CANCELED -> {}", (t) => {
  const ws = freshWs(t);
  writeSession(ws);
  writeState(ws, state({ phase: "running" }));
  const idle = runHook("stop-guard.mjs", {
    conversationId: "conv-main",
    workspacePaths: [ws],
    terminationReason: "NO_TOOL_CALL",
    fullyIdle: false,
  });
  assert.equal(idle.stdout, "{}");
  const canceled = runHook("stop-guard.mjs", {
    conversationId: "conv-main",
    workspacePaths: [ws],
    terminationReason: "USER_CANCELED",
    fullyIdle: true,
  });
  assert.equal(canceled.stdout, "{}");
  assert.equal(readState(ws).counters.noProgressContinues, 0, "no counter bump on blocked stops");
});

test("stop-guard: circuit breaker - 3 consecutive continues then phase flips to paused", (t) => {
  const ws = freshWs(t);
  writeSession(ws);
  // Two continues still allowed (0 -> 1 -> 2).
  writeState(ws, state({ phase: "running" }));
  for (let i = 1; i <= 2; i++) {
    const r = runHook("stop-guard.mjs", {
      conversationId: "conv-main",
      workspacePaths: [ws],
      terminationReason: "NO_TOOL_CALL",
      fullyIdle: true,
    });
    assert.equal(JSON.parse(r.stdout).decision, "continue");
    assert.equal(readState(ws).counters.noProgressContinues, i);
  }
  // Third continue reaches the limit (2 -> 3).
  const third = runHook("stop-guard.mjs", {
    conversationId: "conv-main",
    workspacePaths: [ws],
    terminationReason: "NO_TOOL_CALL",
    fullyIdle: true,
  });
  assert.equal(JSON.parse(third.stdout).decision, "continue");
  assert.equal(readState(ws).counters.noProgressContinues, 3);
  // Fourth call: noProgressContinues (3) >= max (3) -> paused + {}.
  const fourth = runHook("stop-guard.mjs", {
    conversationId: "conv-main",
    workspacePaths: [ws],
    terminationReason: "NO_TOOL_CALL",
    fullyIdle: true,
  });
  assert.equal(fourth.stdout, "{}");
  assert.equal(readState(ws).phase, "paused", "circuit breaker must pause the run");
  // A paused run never continues again.
  const after = runHook("stop-guard.mjs", {
    conversationId: "conv-main",
    workspacePaths: [ws],
    terminationReason: "NO_TOOL_CALL",
    fullyIdle: true,
  });
  assert.equal(after.stdout, "{}");
});

// ---------------------------------------------------------------------------
// Cross-hook adversarial probes + config
// ---------------------------------------------------------------------------

test("adversarial: malformed stdin to every hook -> {} exit 0", () => {
  const hooks = [
    "session-start-resume.mjs",
    "pre-invocation-status.mjs",
    "post-tool-ledger.mjs",
    "stop-guard.mjs",
  ];
  for (const h of hooks) {
    for (const bad of ["\u0000\u0001\u0002 not json at all", '{"conversationId":"x",', ""]) {
      const r = runHook(h, bad);
      assert.equal(r.stdout, "{}", `${h} must fail-open on malformed stdin`);
    }
  }
});

test("hooks.json: valid JSON registering all 5 hooks with correct event shapes", () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const cfg = JSON.parse(fs.readFileSync(path.join(root, "hooks.json"), "utf8"));
  const expected = {
    "asd-pre-tool-guard": ["PreToolUse"],
    "asd-session-start": ["SessionStart"],
    "asd-pre-invocation": ["PreInvocation"],
    "asd-post-tool-ledger": ["PostToolUse"],
    "asd-stop-guard": ["Stop"],
  };
  assert.deepEqual(Object.keys(cfg).sort(), Object.keys(expected).sort());
  for (const [name, events] of Object.entries(expected)) {
    for (const ev of events) {
      const arr = cfg[name][ev];
      assert.ok(Array.isArray(arr) && arr.length === 1, `${name}.${ev} must be a flat handler array`);
      const handler = ev === "PreToolUse" || ev === "PostToolUse" ? arr[0].hooks[0] : arr[0];
      assert.equal(handler.type, "command");
      assert.match(handler.command, /^node scripts\/hooks\/[\w-]+\.mjs$/, "Windows-compatible relative command");
    }
  }
  // Grouped matcher shape for tool events; flat for lifecycle events.
  assert.ok(typeof cfg["asd-pre-tool-guard"].PreToolUse[0].matcher === "string");
  assert.ok(typeof cfg["asd-stop-guard"].Stop[0].command === "string");
});

test("global: no hook output in this suite ever contains decision allow", () => {
  assert.ok(allOutputs.length >= 20, `expected recorded outputs, got ${allOutputs.length}`);
  for (const out of allOutputs) {
    assert.doesNotMatch(out, /"decision":\s*"allow"/, `forbidden allow decision: ${out}`);
  }
});
