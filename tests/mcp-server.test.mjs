// @ts-check
/**
 * Tests for scripts/mcp/asd-mcp-server.mjs — the built-in asd-mcp Stdio MCP
 * server (JSON-RPC 2.0, line-delimited framing).
 *
 * The real server is spawned once over stdio pipes and shared by all tests
 * (node:test runs a file's tests sequentially). Every workspace-bound test
 * uses a fresh os.tmpdir() workspace cleaned up in t.after. The real
 * ~/.gemini config is never touched.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVER_MJS = path.join(REPO_ROOT, "scripts", "mcp", "asd-mcp-server.mjs");
const ASD_CLI = path.join(REPO_ROOT, "scripts", "asd.mjs");

const EXPECTED_TOOLS = [
  "asd_preflight",
  "asd_route_next",
  "asd_todo_mutate",
  "asd_plan_validate",
  "asd_verify_turn",
  "asd_render_summary",
];

/* ---------------- stdio MCP client ---------------- */

class McpClient {
  constructor() {
    this.proc = spawn(process.execPath, [SERVER_MJS], { stdio: ["pipe", "pipe", "pipe"] });
    /** @type {string} */
    this.buf = "";
    /** @type {string} */
    this.stderr = "";
    /** @type {Map<number, (msg: any) => void>} */
    this.pending = new Map();
    this.nextId = 1;
    this.proc.stdout.setEncoding("utf8");
    this.proc.stdout.on("data", (chunk) => {
      this.buf += chunk;
      let idx = this.buf.indexOf("\n");
      while (idx !== -1) {
        const line = this.buf.slice(0, idx).trim();
        this.buf = this.buf.slice(idx + 1);
        if (line !== "") {
          // Throws (and fails the awaiting test) if the server ever writes
          // non-JSON to stdout — the stdout purity guard under test.
          const msg = JSON.parse(line);
          const resolve = this.pending.get(msg.id);
          if (resolve) {
            this.pending.delete(msg.id);
            resolve(msg);
          }
        }
        idx = this.buf.indexOf("\n");
      }
    });
    this.proc.stderr.on("data", (c) => {
      this.stderr += String(c);
    });
  }

  /**
   * @param {string} method
   * @param {Record<string, unknown>} [params]
   * @returns {Promise<any>}
   */
  request(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`timeout waiting for ${method} (id=${id}); stderr: ${this.stderr}`)),
        30000,
      );
      this.pending.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  /** @param {string} method @param {Record<string, unknown>} [params] */
  notify(method, params = {}) {
    this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  /** @returns {Promise<void>} */
  close() {
    return new Promise((resolve) => {
      this.proc.stdin.end();
      this.proc.kill();
      this.proc.on("exit", () => resolve());
    });
  }
}

/** @type {McpClient | null} */
let sharedClient = null;

/** @returns {McpClient} */
function client() {
  if (sharedClient === null) sharedClient = new McpClient();
  return sharedClient;
}

test.after(async () => {
  if (sharedClient !== null) {
    await sharedClient.close();
    sharedClient = null;
  }
});

/* ---------------- workspace helpers ---------------- */

/**
 * @param {import("node:test").TestContext} t
 * @returns {string}
 */
function makeWorkspace(t) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "asd-mcp-test-"));
  t.after(() => fs.rmSync(ws, { recursive: true, force: true }));
  return ws;
}

/**
 * @param {string} ws
 * @param {string[]} args
 * @returns {import("node:child_process").SpawnSyncReturns<string>}
 */
function runCli(ws, args) {
  const r = spawnSync(process.execPath, [ASD_CLI, "--workspace", ws, ...args], {
    encoding: "utf8",
    cwd: ws,
  });
  assert.equal(r.status, 0, `asd ${args.join(" ")} failed: ${r.stderr}`);
  return r;
}

/**
 * @param {string} ws
 * @param {string[]} args
 * @returns {string} stdout
 */
function git(ws, args) {
  const r = spawnSync("git", args, { encoding: "utf8", cwd: ws });
  assert.equal(r.status, 0, `git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
}

/** @param {string} ws */
function setupGitRepo(ws) {
  git(ws, ["init"]);
  git(ws, ["config", "user.name", "asd-test"]);
  git(ws, ["config", "user.email", "asd-test@example.invalid"]);
  git(ws, ["config", "core.autocrlf", "false"]);
  git(ws, ["commit", "--allow-empty", "-m", "init"]);
}

/**
 * Extracts the `result` payload of a successful tools/call response.
 * @param {any} msg
 * @returns {any}
 */
function toolResult(msg) {
  assert.ok(msg.result, `tools/call returned an error response: ${JSON.stringify(msg)}`);
  assert.equal(msg.result.isError, false, `tool reported isError: ${msg.result.content?.[0]?.text}`);
  return JSON.parse(msg.result.content[0].text);
}

/* ---------------- protocol tests ---------------- */

test("initialize returns protocol version, capabilities, and server info", async () => {
  const c = client();
  const res = await c.request("initialize", { protocolVersion: "2024-11-05" });
  assert.equal(res.jsonrpc, "2.0");
  assert.equal(res.result.protocolVersion, "2024-11-05");
  assert.equal(res.result.serverInfo.name, "asd-mcp");
  assert.ok(res.result.capabilities.tools);
  // notifications/initialized must be accepted silently; ping proves liveness.
  c.notify("notifications/initialized");
  const ping = await c.request("ping");
  assert.deepEqual(ping.result, {});
});

test("tools/list returns exactly the 6 asd_* tools with input schemas", async () => {
  const res = await client().request("tools/list");
  const names = res.result.tools.map((/** @type {any} */ t) => t.name);
  assert.deepEqual(names.sort(), [...EXPECTED_TOOLS].sort());
  for (const tool of res.result.tools) {
    assert.equal(tool.inputSchema.type, "object", `${tool.name} inputSchema`);
    assert.equal(typeof tool.description, "string");
  }
});

test("unknown method returns JSON-RPC error -32601", async () => {
  const res = await client().request("no/such/method");
  assert.equal(res.error.code, -32601);
});

/* ---------------- asd_route_next ---------------- */

test("asd_route_next Stage 1 matches by category with mcpHint", async () => {
  const res = await client().request("tools/call", {
    name: "asd_route_next",
    arguments: { category: "external-research" },
  });
  const r = toolResult(res);
  assert.equal(r.matchedBy, "category");
  assert.equal(r.presetKey, "external-research");
  assert.equal(r.tier, "flash_lite");
  assert.equal(r.agent, "asd-scout");
  assert.equal(r.role, "scout");
  assert.deepEqual(r.mcpHint, ["context7", "grep_app", "websearch"]);
  assert.equal(r.harnessSpec.tier, "flash_lite");
});

test("asd_route_next Stage 2 falls back to difficulty and honors the profile proCap", async () => {
  const c = client();
  const deep = toolResult(
    await c.request("tools/call", {
      name: "asd_route_next",
      arguments: { difficulty: "reasoning-deep", profile: "balanced", proUsed: 0 },
    }),
  );
  assert.equal(deep.matchedBy, "difficulty");
  assert.equal(deep.presetKey, "reasoning-deep");
  assert.equal(deep.tier, "pro");

  const eco = toolResult(
    await c.request("tools/call", {
      name: "asd_route_next",
      arguments: { difficulty: "reasoning-deep", profile: "eco" },
    }),
  );
  assert.equal(eco.tier, "flash");
  assert.match(eco.warning, /pro tier downgraded/);
});

/* ---------------- asd_todo_mutate ---------------- */

test("asd_todo_mutate add/start/done updates state and returns the TODO console block", async (t) => {
  const ws = makeWorkspace(t);
  runCli(ws, ["init", "--slug", "mcp-test", "--title", "MCP Test"]);
  const c = client();

  const added = toolResult(
    await c.request("tools/call", {
      name: "asd_todo_mutate",
      arguments: {
        workspace: ws,
        action: "add",
        turn: 1,
        flag: "BUILD",
        summary: "mcp mutation test",
        files: ["src/a.js"],
      },
    }),
  );
  assert.equal(added.ok, true);
  assert.match(added.todoBlock, /T1\.1 mcp mutation test · flash/);
  assert.match(added.todoBlock, /\[BUILD\]/);

  const started = toolResult(
    await c.request("tools/call", {
      name: "asd_todo_mutate",
      arguments: { workspace: ws, action: "start", taskId: "T1.1" },
    }),
  );
  assert.match(started.todoBlock, /\[>\] \[BUILD\] T1\.1/);

  const done = toolResult(
    await c.request("tools/call", {
      name: "asd_todo_mutate",
      arguments: { workspace: ws, action: "done", taskId: "T1.1", summary: "finished" },
    }),
  );
  assert.match(done.todoBlock, /\[x\] \[BUILD\] T1\.1/);

  // Failure path: unknown task id -> ok:false with an error string (isError).
  const bad = await c.request("tools/call", {
    name: "asd_todo_mutate",
    arguments: { workspace: ws, action: "start", taskId: "T9.9" },
  });
  assert.equal(bad.result.isError, true);
  const badPayload = JSON.parse(bad.result.content[0].text);
  assert.equal(badPayload.ok, false);
  assert.match(badPayload.error, /task T9\.9 not found/);
});

/* ---------------- asd_plan_validate ---------------- */

test("asd_plan_validate reports per-Turn file collisions across parallel tasks", async (t) => {
  const ws = makeWorkspace(t);
  const markdown = [
    "<!-- ASD-PLAN-V1 -->",
    "# ASD PLAN — Collisions (collisions)",
    "",
    "## 1. Current Project State",
    "(none)",
    "",
    "## 2. Understood User Command",
    "(none)",
    "",
    "> ⚠️ 위 이해 내용이 의도와 다르거나 누락된 부분이 있다면 지적해 주세요. 수정 후 진행합니다.",
    "",
    "## 3. Interview & Options",
    "### 질문 (Questions)",
    "(none)",
    "### 옵션 (Options)",
    "- includeTests: false",
    "- includeDebug: false",
    "- gitCheckpoint: false",
    "- learnings: false",
    "- profile: balanced",
    "- locale: ko",
    "",
    "## 4. Turn & Task Execution Plan",
    "### Turn 1: First",
    "- [ ] [BUILD] T1.1 build alpha module · flash",
    "  files: src/shared.js, src/a.js",
    "  meta: category=general · difficulty=reasoning-low",
    "- [ ] [BUILD] T1.2 build beta module · flash",
    "  files: src/shared.js, src/b.js",
    "  meta: category=general · difficulty=reasoning-low",
    "",
    "## 5. Verification & Completion Criteria",
    "- all tests pass",
    "",
    "## 6. Runtime Amendments",
    "(none)",
    "",
  ].join("\n");
  const r = toolResult(
    await client().request("tools/call", {
      name: "asd_plan_validate",
      arguments: { workspace: ws, markdown },
    }),
  );
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((/** @type {string} */ e) => e.includes("DUPLICATE_FILE_IN_TURN: Turn 1 -> src/shared.js")));
  assert.deepEqual(r.collisions, [{ turn: 1, file: "src/shared.js", tasks: ["T1.1", "T1.2"] }]);
  assert.deepEqual(r.cycles, []);
});

test("asd_plan_validate detects circular dependsOn from state.json", async (t) => {
  const ws = makeWorkspace(t);
  runCli(ws, ["init", "--slug", "cycle-test", "--title", "Cycle Test"]);
  runCli(ws, ["todo", "add", "--turn", "1", "--flag", "BUILD", "--summary", "first task"]);
  runCli(ws, ["todo", "add", "--turn", "1", "--flag", "TEST", "--summary", "second task", "--depends", "T1.1"]);
  // Minimal valid PLAN.md so the structural leg of the tool passes and the
  // cycle leg is what the test observes.
  fs.mkdirSync(path.join(ws, ".asd"), { recursive: true });
  fs.writeFileSync(
    path.join(ws, ".asd", "PLAN.md"),
    [
      "<!-- ASD-PLAN-V1 -->",
      "# ASD PLAN — Cycle (cycle)",
      "",
      "## 1. Current Project State",
      "(none)",
      "",
      "## 2. Understood User Command",
      "(none)",
      "",
      "> ⚠️ 위 이해 내용이 의도와 다르거나 누락된 부분이 있다면 지적해 주세요. 수정 후 진행합니다.",
      "",
      "## 3. Interview & Options",
      "### 질문 (Questions)",
      "(none)",
      "### 옵션 (Options)",
      "- includeTests: false",
      "- includeDebug: false",
      "- gitCheckpoint: false",
      "- learnings: false",
      "- profile: balanced",
      "- locale: ko",
      "",
      "## 4. Turn & Task Execution Plan",
      "### Turn 1: First",
      "- [ ] [BUILD] T1.1 first task here · flash",
      "  files: -",
      "  meta: category=general · difficulty=reasoning-low",
      "",
      "## 5. Verification & Completion Criteria",
      "- all tests pass",
      "",
      "## 6. Runtime Amendments",
      "(none)",
      "",
    ].join("\n"),
  );
  // Introduce the cycle by hand: T1.1 now depends on T1.2 which depends on T1.1.
  const statePath = path.join(ws, ".asd", "state.json");
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  state.tasks.find((/** @type {{ id: string }} */ x) => x.id === "T1.1").dependsOn = ["T1.2"];
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n");

  const r = toolResult(
    await client().request("tools/call", {
      name: "asd_plan_validate",
      arguments: { workspace: ws },
    }),
  );
  assert.equal(r.ok, false);
  assert.equal(r.cycles.length, 1);
  assert.match(r.cycles[0], /T1\.1 -> T1\.2 -> T1\.1/);
});

/* ---------------- asd_verify_turn ---------------- */

test("asd_verify_turn flags out-of-scope edits and never false-flags earlier-Turn files", async (t) => {
  const ws = makeWorkspace(t);
  setupGitRepo(ws);
  runCli(ws, ["init", "--slug", "verify-test", "--title", "Verify Test"]);
  const c = client();

  // Turn 1: declared scope is src/a.js only.
  fs.mkdirSync(path.join(ws, "src"));
  fs.writeFileSync(path.join(ws, "src", "a.js"), "export const a = 1;\n");
  git(ws, ["add", "-A", "--", "."]);
  git(ws, ["commit", "-m", "seed src/a.js"]);
  runCli(ws, ["todo", "add", "--turn", "1", "--flag", "BUILD", "--summary", "turn one work", "--files", "src/a.js"]);
  runCli(ws, ["turn", "next"]); // records Turn 1 baselineSnapshot (gitCheckpoint defaults to false)
  fs.writeFileSync(path.join(ws, "src", "a.js"), "export const a = 1;\nexport const a1 = 1;\n");

  const turn1 = toolResult(
    await c.request("tools/call", {
      name: "asd_verify_turn",
      arguments: { workspace: ws, turn: 1 },
    }),
  );
  assert.equal(turn1.ok, true, `unexpected out-of-scope: ${JSON.stringify(turn1.outOfScopeFiles)}`);
  assert.deepEqual(turn1.changedFiles, ["src/a.js"]);
  assert.deepEqual(turn1.outOfScopeFiles, []);

  // Failure scenario: an undeclared file appears during Turn 1.
  fs.writeFileSync(path.join(ws, "src", "unauthorised.js"), "export const bad = true;\n");
  const flagged = toolResult(
    await c.request("tools/call", {
      name: "asd_verify_turn",
      arguments: { workspace: ws, turn: 1 },
    }),
  );
  assert.equal(flagged.ok, false);
  assert.deepEqual(flagged.outOfScopeFiles, ["src/unauthorised.js"]);
  fs.rmSync(path.join(ws, "src", "unauthorised.js"));

  // Close Turn 1 so `turn next` targets Turn 2 and records ITS baseline.
  runCli(ws, ["task", "done", "T1.1"]);
  // Turn 2 (gitCheckpoint:false): src/a.js is dirty vs git HEAD from Turn 1's
  // uncommitted edit, but Turn 2's baseline was recorded AFTER Turn 1 — so a
  // Turn 2 that touches only its own declared file must see ZERO false
  // positives on the earlier-Turn file.
  runCli(ws, ["todo", "add", "--turn", "2", "--flag", "BUILD", "--summary", "turn two work", "--files", "src/b.js"]);
  runCli(ws, ["turn", "next"]); // records Turn 2 baselineSnapshot
  fs.writeFileSync(path.join(ws, "src", "b.js"), "export const b = 1;\n");

  const turn2 = toolResult(
    await c.request("tools/call", {
      name: "asd_verify_turn",
      arguments: { workspace: ws, turn: 2 },
    }),
  );
  assert.equal(turn2.ok, true, `false positives: ${JSON.stringify(turn2.outOfScopeFiles)}`);
  assert.deepEqual(turn2.changedFiles, ["src/b.js"]);
  assert.deepEqual(turn2.outOfScopeFiles, []);
  // Prove the earlier-Turn file really is dirty vs git (the false-positive
  // hazard exists) yet was not flagged because the baseline absorbed it.
  const numstat = git(ws, ["diff", "--numstat"]).trim();
  assert.match(numstat, /src\/a\.js/);
});

test("asd_verify_turn refuses a Turn without a baselineSnapshot", async (t) => {
  const ws = makeWorkspace(t);
  runCli(ws, ["init", "--slug", "no-baseline", "--title", "No Baseline"]);
  runCli(ws, ["todo", "add", "--turn", "1", "--flag", "BUILD", "--summary", "never started"]);
  const r = await client().request("tools/call", {
    name: "asd_verify_turn",
    arguments: { workspace: ws, turn: 1 },
  });
  assert.equal(r.result.isError, true);
  const payload = JSON.parse(r.result.content[0].text);
  assert.equal(payload.ok, false);
  assert.match(payload.error, /baselineSnapshot/);
});

/* ---------------- asd_render_summary ---------------- */

test("asd_render_summary writes SUMMARY.md with Mermaid flowchart and real git numstat counts", async (t) => {
  const ws = makeWorkspace(t);
  setupGitRepo(ws);
  // Track src/a.js at HEAD so the Turn's edit produces a real `git diff --numstat` row.
  fs.mkdirSync(path.join(ws, "src"));
  fs.writeFileSync(path.join(ws, "src", "a.js"), "export const a = 1;\n");
  git(ws, ["add", "-A", "--", "."]);
  git(ws, ["commit", "-m", "seed src/a.js"]);

  runCli(ws, ["init", "--slug", "summary-test", "--title", "Summary Test"]);
  runCli(ws, ["todo", "add", "--turn", "1", "--flag", "BUILD", "--summary", "summary work", "--files", "src/a.js"]);
  runCli(ws, ["turn", "next"]);
  fs.writeFileSync(path.join(ws, "src", "a.js"), "export const a = 1;\nexport const a2 = 2;\n");
  runCli(ws, ["task", "done", "T1.1"]);

  const r = toolResult(
    await client().request("tools/call", {
      name: "asd_render_summary",
      arguments: { workspace: ws, notes: "all green" },
    }),
  );
  assert.equal(r.ok, true);
  assert.match(r.markdown, /flowchart LR/);
  assert.match(r.markdown, /\| src\/a\.js \| \+1 \| -0 \|/);
  assert.match(r.markdown, /all green/);
  assert.match(r.todoMarkdown, /Done: 1\/1/);

  const summaryOnDisk = fs.readFileSync(path.join(ws, ".asd", "SUMMARY.md"), "utf8");
  assert.match(summaryOnDisk, /flowchart LR/);
  const state = JSON.parse(fs.readFileSync(path.join(ws, ".asd", "state.json"), "utf8"));
  assert.equal(state.phase, "done");
});

test("asd_render_summary refuses while tasks are unfinished", async (t) => {
  const ws = makeWorkspace(t);
  runCli(ws, ["init", "--slug", "summary-guard", "--title", "Summary Guard"]);
  runCli(ws, ["todo", "add", "--turn", "1", "--flag", "BUILD", "--summary", "still open"]);
  const r = await client().request("tools/call", {
    name: "asd_render_summary",
    arguments: { workspace: ws },
  });
  assert.equal(r.result.isError, true);
  const payload = JSON.parse(r.result.content[0].text);
  assert.equal(payload.ok, false);
  assert.match(payload.error, /cannot summarize/);
});

/* ---------------- asd_preflight ---------------- */

test("asd_preflight returns mode, session, and stateSummary", async (t) => {
  const ws = makeWorkspace(t);
  runCli(ws, ["init", "--slug", "preflight-test", "--title", "Preflight Test"]);
  runCli(ws, ["todo", "add", "--turn", "1", "--flag", "BUILD", "--summary", "preflight task"]);
  const r = toolResult(
    await client().request("tools/call", {
      name: "asd_preflight",
      arguments: { workspace: ws, cmd: "status" },
    }),
  );
  assert.equal(r.mode, "status");
  assert.ok(r.session);
  assert.equal(r.session.mainConversationId, "asd-mcp");
  assert.ok(r.stateSummary);
  assert.equal(r.stateSummary.slug, "preflight-test");
  assert.equal(r.stateSummary.totalTasks, 1);
});
