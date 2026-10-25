// @ts-check
// allow: SIZE_OK — the overage is fixture data (validateState-clean state/session
// literals and a lint-clean PLAN.md); logic is well under 250.
/**
 * Adversarial resilience suite (plan Todo 21). Four areas:
 * 1. 8-way parallel subprocess stress against one .asd/state.json (X5).
 * 2. Hostile Windows paths (spaces + Hangul) with BOM/CRLF PLAN.md.
 * 3. Malformed/adversarial stdin fuzzing across ALL 5 hooks.
 * 4. Runaway stop-loop circuit breaker.
 *
 * Zero external deps: node:test + node:assert/strict + node:child_process.
 * All temp workspaces live under os.tmpdir() and are removed in t.after.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
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

const ALL_HOOKS = [
  "pre-tool-guard.mjs",
  "pre-invocation-status.mjs",
  "post-tool-ledger.mjs",
  "stop-guard.mjs",
  "session-start-resume.mjs",
];

/** Every stdout any hook produced in this suite (global never-allow scan). */
const hookOutputs = [];

/** Live stress-test children; killed in t.after as an orphan-process net. */
const liveChildren = new Set();

/**
 * Fresh tmp workspace, removed (and asserted removed) in `t.after`.
 * @param {import("node:test").TestContext} t
 * @param {string} prefix
 */
function freshWs(t, prefix) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => {
    fs.rmSync(ws, { recursive: true, force: true });
    assert.equal(fs.existsSync(ws), false, "temp workspace must be cleaned up");
  });
  return ws;
}

/**
 * Runs the ASD CLI synchronously against `ws`.
 * @param {string} ws @param {string[]} args
 */
function runCli(ws, args) {
  return spawnSync(process.execPath, [ASD_CLI, "--workspace", ws, ...args], {
    encoding: "utf8",
    timeout: 30_000,
  });
}

/**
 * Spawns one async CLI child (for parallel stress workers).
 * @param {string} ws @param {string[]} args
 * @returns {Promise<{ code: number, stderr: string }>}
 */
function spawnCli(ws, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [ASD_CLI, "--workspace", ws, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    liveChildren.add(child);
    let stderr = "";
    child.stderr.on("data", (/** @type {Buffer} */ d) => {
      stderr += String(d);
    });
    child.on("error", (e) => {
      liveChildren.delete(child);
      resolve({ code: -1, stderr: String(e) });
    });
    child.on("close", (code) => {
      liveChildren.delete(child);
      resolve({ code: code ?? -1, stderr });
    });
  });
}

/**
 * Spawns a hook with raw stdin (string, Buffer, or JSON-serializable object),
 * asserts exit 0, records stdout for the never-allow scan.
 * @param {string} name @param {string | Buffer | Record<string, unknown>} stdin
 */
function runHook(name, stdin) {
  const input =
    typeof stdin === "string" || Buffer.isBuffer(stdin) ? stdin : JSON.stringify(stdin);
  const r = spawnSync(process.execPath, [hook(name)], {
    input,
    encoding: "utf8",
    timeout: 15_000,
  });
  const stdout = r.stdout ?? "";
  hookOutputs.push(stdout);
  return r;
}

const now = () => new Date().toISOString();

/** validateSession-clean session.json held by "conv-main". @param {string} ws */
function writeSession(ws) {
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
      },
      null,
      2,
    ) + "\n",
  );
}

/** validateState-clean state payload. @param {Record<string, unknown>} [patch] */
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
const readState = (ws) => JSON.parse(fs.readFileSync(path.join(ws, ".asd", "state.json"), "utf8"));

/** Lint-clean PLAN.md fixture (passes validatePlanMarkdown + lintPlanMarkdown). */
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
  "- includeTests: false",
  "- includeDebug: false",
  "- gitCheckpoint: false",
  "- learnings: false",
  "- profile: balanced",
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
// Area 1 — 8-way parallel subprocess stress (X5)
// ---------------------------------------------------------------------------

test("stress: 8 parallel CLI writers x 15 writes -> 120 tasks, zero crashes, valid state/TODO", async (t) => {
  t.after(() => {
    for (const c of liveChildren) c.kill();
  });
  const ws = freshWs(t, "asd-stress-");
  const init = runCli(ws, ["init", "--slug", "stress", "--title", "Stress Test"]);
  assert.equal(init.status, 0, `init failed: ${init.stderr}`);

  // init caps maxTasksTotal at 64; the fixture raises it for 8x15=120 tasks.
  const statePath = path.join(ws, ".asd", "state.json");
  const st = JSON.parse(fs.readFileSync(statePath, "utf8"));
  st.limits.maxTasksTotal = 1000;
  fs.writeFileSync(statePath, JSON.stringify(st, null, 2) + "\n");

  /** @type {string[]} */
  const failures = [];
  const worker = async (/** @type {number} */ w) => {
    for (let j = 1; j <= 15; j++) {
      const r = await spawnCli(ws, ["todo", "add", "--turn", "1", "--flag", "BUILD", "--summary", `w${w} task ${j}`]);
      if (r.code !== 0) failures.push(`w${w}#${j} exit ${r.code}: ${r.stderr.slice(0, 200)}`);
    }
  };
  await Promise.all(Array.from({ length: 8 }, (_, w) => worker(w)));
  assert.deepEqual(failures, [], "every concurrent write must exit 0 (no EPERM/EBUSY crashes)");

  // Concurrent ledger appends + status flips through the same state lock.
  const ledgerWorkers = Array.from({ length: 8 }, (_, w) =>
    spawnCli(ws, ["task", "done", `T1.${w + 1}`, "--summary", `w${w} done`]),
  );
  const ledgerResults = await Promise.all(ledgerWorkers);
  assert.deepEqual(
    ledgerResults.map((r) => r.code),
    [0, 0, 0, 0, 0, 0, 0, 0],
    `concurrent task done must exit 0 (stderr: ${ledgerResults.map((r) => r.stderr.slice(0, 200)).join(" | ")})`,
  );

  const finalState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(finalState.tasks.length, 120, "exact total task count 8x15");
  assert.equal(new Set(finalState.tasks.map((/** @type {any} */ x) => x.id)).size, 120, "task ids unique under contention");

  const todo = fs.readFileSync(path.join(ws, ".asd", "TODO.md"), "utf8");
  const rows = todo.split(/\r?\n/).filter((l) => l.startsWith("- ["));
  assert.equal(rows.length, 120);
  for (const row of rows) {
    const v = validateTodoLine(row);
    assert.ok(v.ok, `TODO row failed grammar: ${row} -> ${v.errors.join("; ")}`);
  }

  const ledger = fs.readFileSync(path.join(ws, ".asd", "ledger.jsonl"), "utf8").trim().split("\n");
  assert.equal(ledger.length, 8, "8 concurrent ledger appends");
  for (const line of ledger) assert.ok(JSON.parse(line).event === "task_done");

  const asdFiles = fs.readdirSync(path.join(ws, ".asd"));
  assert.ok(!asdFiles.some((f) => f.endsWith(".lock")), `stale lock left behind: ${asdFiles}`);
  assert.ok(!asdFiles.some((f) => f.endsWith(".tmp")), `tmp file left behind: ${asdFiles}`);
});

// ---------------------------------------------------------------------------
// Area 2 — hostile Windows paths + CRLF/BOM
// ---------------------------------------------------------------------------

test("hostile: Hangul/space dir + BOM/CRLF PLAN.md -> init, plan-import, lint, pre-tool-guard all succeed", (t) => {
  const base = freshWs(t, "asd-hostile-");
  const ws = path.join(base, "ASD Test Project (한글 공백)");
  fs.mkdirSync(ws, { recursive: true });

  const init = runCli(ws, ["init", "--slug", "hostile", "--title", "Hostile Paths"]);
  assert.equal(init.status, 0, `init failed in hostile path: ${init.stderr}`);

  // UTF-8 BOM + CRLF line endings throughout.
  const crlfPlan = "\uFEFF" + VALID_PLAN.split("\n").join("\r\n");
  fs.writeFileSync(path.join(ws, ".asd", "PLAN.md"), crlfPlan, "utf8");

  const imp = runCli(ws, ["plan-import"]);
  assert.equal(imp.status, 0, `plan-import failed on BOM/CRLF plan: ${imp.stderr}`);
  const lint = runCli(ws, ["lint"]);
  assert.equal(lint.status, 0, `lint failed after import: ${lint.stderr}`);

  // pre-tool-guard inside the hostile workspace: machine-file write -> deny.
  const r = runHook("pre-tool-guard.mjs", {
    conversationId: "conv-main",
    workspacePaths: [ws],
    toolCall: { name: "write_to_file", args: { path: path.join(ws, ".asd", "TODO.md") } },
  });
  const out = JSON.parse(r.stdout);
  assert.equal(out.decision, "deny", "machine-file write must be denied in hostile path workspace");
  assert.match(out.reason, /ASD_FORMAT_GUARD/);
});

// ---------------------------------------------------------------------------
// Area 3 — malformed & adversarial hook inputs
// ---------------------------------------------------------------------------

test("fuzz: malformed/adversarial stdin -> all 5 hooks exit 0 with safe JSON, never allow", (t) => {
  const ws = freshWs(t, "asd-fuzz-");
  writeSession(ws);
  writeState(ws, state());

  const binaryGarbage = Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x7b, 0x22, 0x00, 0x9c, 0xde, 0xad]);
  const cases = /** @type {[string, string | Buffer][]} */ ([
    ["truncated-json", '{"workspacePaths":["'],
    ["binary-garbage", binaryGarbage],
    ["empty-stdin", ""],
    ["null-json", "null"],
    ["array-json", "[1,2,3]"],
    ["missing-workspacePaths", JSON.stringify({ conversationId: "conv-main" })],
    ["traversal-workspace", JSON.stringify({ conversationId: "conv-main", workspacePaths: ["../../Windows/System32"] })],
    [
      "traversal-write-target",
      JSON.stringify({
        conversationId: "conv-main",
        workspacePaths: [ws],
        toolCall: { name: "write_to_file", args: { path: "../../Windows/System32/evil.txt" } },
      }),
    ],
  ]);

  for (const h of ALL_HOOKS) {
    for (const [label, input] of cases) {
      const r = runHook(h, input);
      assert.equal(r.status, 0, `${h} [${label}] must exit 0 (stderr: ${r.stderr})`);
      const stdout = r.stdout ?? "";
      let parsed = null;
      try {
        parsed = JSON.parse(stdout);
      } catch {
        parsed = undefined;
      }
      assert.ok(
        typeof parsed === "object" && parsed !== null && !Array.isArray(parsed),
        `${h} [${label}] must emit a safe JSON object, got: ${stdout.slice(0, 120)}`,
      );
      assert.doesNotMatch(stdout, /"decision"\s*:\s*"allow"/, `${h} [${label}] must NEVER allow`);
    }
  }
});

// ---------------------------------------------------------------------------
// Area 4 — runaway stop-loop circuit breaker
// ---------------------------------------------------------------------------

test("breaker: 4 consecutive no-progress stops -> 3 continues, then paused + {}", (t) => {
  const ws = freshWs(t, "asd-breaker-");
  writeSession(ws);
  writeState(ws, state({ phase: "running" }));
  const stopInput = JSON.stringify({
    conversationId: "conv-main",
    workspacePaths: [ws],
    terminationReason: "NO_TOOL_CALL",
    fullyIdle: true,
  });

  for (let i = 1; i <= 3; i++) {
    const r = runHook("stop-guard.mjs", stopInput);
    const out = JSON.parse(r.stdout);
    assert.equal(out.decision, "continue", `call ${i} must continue`);
    assert.equal(readState(ws).counters.noProgressContinues, i);
  }
  const fourth = runHook("stop-guard.mjs", stopInput);
  assert.equal(fourth.stdout, "{}", "call 4 must hit the circuit breaker");
  assert.equal(readState(ws).phase, "paused", "breaker must flip state.phase to paused");
});

// ---------------------------------------------------------------------------
// Global invariant
// ---------------------------------------------------------------------------

test("global: no hook output in this suite ever contains decision allow", () => {
  assert.ok(hookOutputs.length >= 40, `expected recorded outputs, got ${hookOutputs.length}`);
  for (const out of hookOutputs) {
    assert.doesNotMatch(out, /"decision"\s*:\s*"allow"/, `forbidden allow decision: ${out}`);
  }
});
