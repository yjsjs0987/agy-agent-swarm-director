// @ts-check
// allow: SIZE_OK — the plan mandates a single built-in MCP server file
// (scripts/mcp/asd-mcp-server.mjs); splitting would create files outside the
// approved deliverable set.
/**
 * asd-mcp — built-in zero-dependency Stdio MCP server for the ASD plugin.
 *
 * Protocol: JSON-RPC 2.0 over process.stdin/process.stdout using Node
 * built-ins only. FRAMING = line-delimited JSON (one complete JSON-RPC
 * message per line, `\n`-terminated, on both directions) — the stdio MCP
 * convention; Content-Length header framing is intentionally not used.
 *
 * Methods: `initialize`, `notifications/initialized` (no response),
 * `tools/list`, `tools/call`, `ping`. Unknown methods get -32601.
 *
 * Every workspace-bound tool takes an explicit `workspace` argument because
 * MCP_SERVER_ARGS_MODE is unresolved (the harness cwd for `args` in
 * mcp_config.json is not documented) — this server NEVER trusts process.cwd()
 * for workspace resolution and self-locates scripts/asd.mjs via
 * import.meta.url instead.
 */
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";

// ---------------------------------------------------------------------------
// STDOUT PURITY GUARD — must run BEFORE any scripts/lib module is evaluated.
// Static ESM imports are hoisted, so scripts/lib/*.mjs are imported
// dynamically (see `lib()`) after this redirect: any accidental console.log
// inside a shared library then lands on stderr and can never corrupt the
// JSON-RPC stdout framing.
// ---------------------------------------------------------------------------
console.log = (...args) => console.error(...args);

/** Server identity reported in `initialize`. */
const SERVER_INFO = { name: "asd-mcp", version: "0.1.0" };
/** Fallback protocol version when the client sends none. */
const DEFAULT_PROTOCOL_VERSION = "2024-11-05";

/** Directory containing this script (`<plugin>/scripts/mcp`). */
const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
/** The ASD CLI, resolved relative to THIS file (never process.cwd()). */
const ASD_CLI = path.resolve(SCRIPTS_DIR, "..", "asd.mjs");

/**
 * Lazily imported scripts/lib modules (dynamic import keeps their evaluation
 * after the stdout purity guard above).
 * @returns {Promise<{ routing: any, preflight: any, schema: any, render: any, fsAtomic: any }>}
 */
async function lib() {
  const [routing, preflight, schema, render, fsAtomic] = await Promise.all([
    import("../lib/routing.mjs"),
    import("../lib/preflight.mjs"),
    import("../lib/schema.mjs"),
    import("../lib/render.mjs"),
    import("../lib/fs-atomic.mjs"),
  ]);
  return { routing, preflight, schema, render, fsAtomic };
}

/* ---------------- small arg coercion helpers ---------------- */

/** @param {Record<string, unknown>} a @param {string} k @returns {string} */
function reqStr(a, k) {
  const v = a[k];
  if (typeof v !== "string" || v === "") {
    throw new Error(`tool argument "${k}" must be a non-empty string`);
  }
  return v;
}

/** @param {Record<string, unknown>} a @param {string} k @returns {string | undefined} */
function optStr(a, k) {
  const v = a[k];
  return typeof v === "string" && v !== "" ? v : undefined;
}

/** @param {Record<string, unknown>} a @param {string} k @returns {string[]} */
function optStrArray(a, k) {
  const v = a[k];
  if (Array.isArray(v)) return v.filter((x) => typeof x === "string" && x !== "");
  if (typeof v === "string" && v.trim() !== "") {
    return v.split(",").map((s) => s.trim()).filter((s) => s !== "");
  }
  return [];
}

/** @param {Record<string, unknown>} a @param {string} k @returns {number | undefined} */
function optNum(a, k) {
  const v = a[k];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** @param {Record<string, unknown>} a @param {string} k @returns {boolean} */
function optBool(a, k) {
  return a[k] === true;
}

/* ---------------- working-tree snapshot & git stats (asd.mjs semantics) ---------------- */

/** Directories never inspected by Turn verification (same set as asd.mjs). */
const TREE_EXCLUDE = new Set([".asd", ".git", ".omo", "node_modules"]);

/**
 * Recursive working-tree snapshot: relPath ("/" separators) -> { mtimeMs, sha256 }.
 * Mirrors scripts/asd.mjs captureBaseline so comparisons against a Turn's
 * recorded baselineSnapshot are exact.
 * @param {string} ws
 * @returns {Record<string, { mtimeMs: number, sha256: string }>}
 */
function captureTree(ws) {
  /** @type {Record<string, { mtimeMs: number, sha256: string }>} */
  const snapshot = {};
  /** @param {string} dir @param {string} rel */
  const walk = (dir, rel) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (TREE_EXCLUDE.has(ent.name)) continue;
      const abs = path.join(dir, ent.name);
      const r = rel === "" ? ent.name : `${rel}/${ent.name}`;
      if (ent.isDirectory()) walk(abs, r);
      else if (ent.isFile()) {
        const st = fs.statSync(abs);
        snapshot[r] = {
          mtimeMs: st.mtimeMs,
          sha256: createHash("sha256").update(fs.readFileSync(abs)).digest("hex"),
        };
      }
    }
  };
  walk(ws, "");
  return snapshot;
}

/**
 * `git diff --numstat` rows excluding `.asd/**`; empty when git is absent or
 * the workspace is not a repo (bounded, read-only). Same semantics as asd.mjs.
 * @param {string} ws
 * @returns {{ file: string, added: number, deleted: number }[]}
 */
function gitDiffStats(ws) {
  let out;
  try {
    out = execFileSync("git", ["diff", "--numstat"], {
      cwd: ws,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return [];
  }
  /** @type {{ file: string, added: number, deleted: number }[]} */
  const stats = [];
  for (const line of out.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    const file = parts.slice(2).join("\t");
    if (file === ".asd" || file.startsWith(".asd/")) continue;
    stats.push({
      file,
      added: Number.parseInt(parts[0], 10) || 0,
      deleted: Number.parseInt(parts[1], 10) || 0,
    });
  }
  return stats;
}

/* ---------------- tool implementations ---------------- */

/**
 * asd_preflight: runPreflight -> { mode, session, stateSummary, ... }.
 * @param {Record<string, unknown>} args
 */
async function toolPreflight(args) {
  const { preflight } = await lib();
  const cmd = reqStr(args, "cmd");
  const r = await preflight.runPreflight(path.resolve(reqStr(args, "workspace")), {
    cmd,
    sessionId: optStr(args, "sessionId") ?? "asd-mcp",
    forceTakeover: optBool(args, "forceTakeover"),
  });
  // The brief's response shape names the compact state summary "stateSummary";
  // preflight calls it "state" — alias it, keep the rest verbatim.
  return { ...r, stateSummary: r.state ?? null };
}

/**
 * asd_route_next: 2-stage preset router (Stage 1 category, Stage 2 difficulty
 * fallback, profile proCap guard).
 * @param {Record<string, unknown>} args
 */
async function toolRouteNext(args) {
  const { routing } = await lib();
  const r = routing.resolveModelPreset({
    ...(optStr(args, "category") !== undefined ? { category: optStr(args, "category") } : {}),
    ...(optStr(args, "difficulty") !== undefined ? { difficulty: optStr(args, "difficulty") } : {}),
    ...(optStr(args, "profile") !== undefined ? { profile: optStr(args, "profile") } : {}),
    ...(optStr(args, "harness") !== undefined ? { harness: optStr(args, "harness") } : {}),
    ...(optNum(args, "proUsed") !== undefined ? { proUsed: optNum(args, "proUsed") } : {}),
  });
  return {
    matchedBy: r.matchedBy,
    presetKey: r.presetKey,
    tier: r.tier,
    agent: r.agent,
    role: r.role,
    mcpHint: r.mcpHint,
    harnessSpec: r.harnessSpec,
    ...(r.warning !== null ? { warning: r.warning } : {}),
  };
}

/**
 * asd_todo_mutate: delegates to the ASD CLI (single source of truth for
 * locking, validation, ledger, and TODO re-render) and returns the rendered
 * TODO console block.
 * @param {Record<string, unknown>} args
 */
async function toolTodoMutate(args) {
  const ws = path.resolve(reqStr(args, "workspace"));
  const action = reqStr(args, "action");
  /** @type {string[]} */
  let cliArgs;
  if (action === "start" || action === "done" || action === "fail" || action === "update") {
    const taskId = reqStr(args, "taskId");
    if (action === "start") {
      cliArgs = ["task", "start", taskId];
    } else if (action === "done") {
      const summary = optStr(args, "summary");
      cliArgs = ["task", "done", taskId, ...(summary ? ["--summary", summary] : [])];
    } else if (action === "fail") {
      cliArgs = ["task", "fail", taskId, "--reason", optStr(args, "reason") ?? "task failed"];
    } else {
      cliArgs = ["todo", "update", taskId];
      const status = optStr(args, "status");
      if (status) cliArgs.push("--status", status);
      const summary = optStr(args, "summary");
      if (summary) cliArgs.push("--summary", summary);
      const category = optStr(args, "category");
      if (category) cliArgs.push("--category", category);
      const difficulty = optStr(args, "difficulty");
      if (difficulty) cliArgs.push("--difficulty", difficulty);
      const tier = optStr(args, "tier");
      if (tier) cliArgs.push("--tier", tier);
    }
  } else if (action === "add") {
    const turn = optNum(args, "turn");
    if (turn === undefined || !Number.isInteger(turn) || turn < 1) {
      throw new Error('asd_todo_mutate "add" requires integer "turn" >= 1');
    }
    cliArgs = [
      "todo", "add",
      "--turn", String(turn),
      "--flag", reqStr(args, "flag"),
      "--summary", reqStr(args, "summary"),
    ];
    const category = optStr(args, "category");
    if (category) cliArgs.push("--category", category);
    const difficulty = optStr(args, "difficulty");
    if (difficulty) cliArgs.push("--difficulty", difficulty);
    const tier = optStr(args, "tier");
    if (tier) cliArgs.push("--tier", tier);
    const files = optStrArray(args, "files");
    if (files.length > 0) cliArgs.push("--files", files.join(","));
  } else {
    throw new Error(`asd_todo_mutate action must be one of start|done|fail|add|update, got: ${action}`);
  }
  const r = spawnSync(process.execPath, [ASD_CLI, "--workspace", ws, ...cliArgs], {
    encoding: "utf8",
    cwd: ws,
    timeout: 30000,
  });
  if (r.error) throw new Error(`failed to spawn ASD CLI: ${String(r.error)}`);
  if (r.status !== 0) {
    return { ok: false, error: (r.stderr || r.stdout || `exit ${r.status}`).trim() };
  }
  return { ok: true, action, todoBlock: (r.stdout || "").trimEnd() };
}

/**
 * asd_plan_validate: validatePlanMarkdown + per-Turn file-collision
 * set-intersection across parallel tasks + circular dependsOn detection
 * (state.json tasks when present).
 * @param {Record<string, unknown>} args
 */
async function toolPlanValidate(args) {
  const { schema, render, fsAtomic } = await lib();
  const ws = path.resolve(reqStr(args, "workspace"));
  let markdown = optStr(args, "markdown");
  if (markdown === undefined) {
    const planPath = path.join(ws, ".asd", "PLAN.md");
    if (!fs.existsSync(planPath)) {
      return { ok: false, error: `no .asd/PLAN.md found under workspace (and no "markdown" argument given)` };
    }
    markdown = fsAtomic.normalizeText(fs.readFileSync(planPath, "utf8"));
  }
  const v = schema.validatePlanMarkdown(markdown);
  const parsed = render.parsePlanMarkdown(markdown);

  // File-collision set-intersection across parallel tasks per Turn.
  /** @type {Map<number, Map<string, string[]>>} */
  const ownersByTurn = new Map();
  for (const t of parsed.tasks) {
    let owners = ownersByTurn.get(t.turn);
    if (!owners) {
      owners = new Map();
      ownersByTurn.set(t.turn, owners);
    }
    for (const f of t.files) {
      const list = owners.get(f);
      if (list) list.push(t.id);
      else owners.set(f, [t.id]);
    }
  }
  /** @type {{ turn: number, file: string, tasks: string[] }[]} */
  const collisions = [];
  for (const [turn, owners] of ownersByTurn) {
    for (const [file, tasks] of owners) {
      if (tasks.length > 1) collisions.push({ turn, file, tasks });
    }
  }

  // Circular dependency detection over state.json tasks' dependsOn (PLAN rows
  // carry no deps; the authoritative graph lives in state.json).
  /** @type {string[]} */
  const cycles = [];
  const rawState = fsAtomic.readJsonSafe(path.join(ws, ".asd", "state.json"), null);
  if (rawState !== null && schema.validateState(rawState).ok) {
    /** @type {Map<string, string[]>} */
    const deps = new Map(
      rawState.tasks.map((/** @type {any} */ t) => [t.id, Array.isArray(t.dependsOn) ? t.dependsOn : []]),
    );
    /** @type {Map<string, number>} */
    const color = new Map(); // 0 white, 1 gray, 2 black
    /** @type {string[]} */
    const stack = [];
    /** @param {string} id */
    const visit = (id) => {
      color.set(id, 1);
      stack.push(id);
      for (const dep of deps.get(id) ?? []) {
        if (!deps.has(dep)) continue;
        const c = color.get(dep) ?? 0;
        if (c === 1) {
          const i = stack.indexOf(dep);
          cycles.push([...stack.slice(i), dep].join(" -> "));
        } else if (c === 0) {
          visit(dep);
        }
      }
      stack.pop();
      color.set(id, 2);
    };
    for (const id of deps.keys()) {
      if ((color.get(id) ?? 0) === 0) visit(id);
    }
  }

  return {
    ok: v.ok && collisions.length === 0 && cycles.length === 0,
    errors: v.errors,
    collisions,
    cycles,
  };
}

/**
 * asd_verify_turn: real fact-check on Turn n. Compares the current working
 * tree against Turn n's baselineSnapshot (recorded at `turn next`), so files
 * modified in earlier Turns or pre-existing dirty files are NEVER flagged —
 * only deltas since the Turn n baseline count. Every changed file must belong
 * to Turn n's declared files[]. `.asd/**`, `.git/**`, `.omo/**` (and
 * node_modules) are unconditionally out of inspection scope.
 * @param {Record<string, unknown>} args
 */
async function toolVerifyTurn(args) {
  const { fsAtomic } = await lib();
  const ws = path.resolve(reqStr(args, "workspace"));
  const turn = optNum(args, "turn");
  if (turn === undefined || !Number.isInteger(turn) || turn < 1) {
    throw new Error('asd_verify_turn requires integer "turn" >= 1');
  }
  const rawState = fsAtomic.readJsonSafe(path.join(ws, ".asd", "state.json"), null);
  if (rawState === null) {
    return { ok: false, error: `no .asd/state.json found under workspace — run "asd init" first` };
  }
  const entry = rawState.turns.find((/** @type {any} */ t) => t.turn === turn);
  if (!entry || !entry.baselineSnapshot || typeof entry.baselineSnapshot !== "object") {
    return {
      ok: false,
      error: `turn T${turn} has no baselineSnapshot — run "asd turn next" (or asd_todo_mutate) first`,
    };
  }
  const baseline = /** @type {Record<string, { mtimeMs: number, sha256: string }>} */ (entry.baselineSnapshot);
  const current = captureTree(ws);

  /** @type {string[]} */
  const changedFiles = [];
  for (const [rel, snap] of Object.entries(current)) {
    const base = baseline[rel];
    if (!base || base.sha256 !== snap.sha256) changedFiles.push(rel);
  }
  /** @type {string[]} */
  const deletedFiles = Object.keys(baseline).filter((rel) => current[rel] === undefined);

  // Declared scope for Turn n: union of its tasks' files[], compared
  // case/separator-stably against workspace-resolved absolute paths.
  const declared = new Set(
    rawState.tasks
      .filter((/** @type {any} */ t) => t.turn === turn)
      .flatMap((/** @type {any} */ t) => (Array.isArray(t.files) ? t.files : []))
      .map((/** @type {string} */ f) => fsAtomic.normalizePathForCompare(path.resolve(ws, f))),
  );
  const outOfScope = [...changedFiles, ...deletedFiles].filter(
    (rel) => !declared.has(fsAtomic.normalizePathForCompare(path.resolve(ws, rel))),
  );

  return {
    ok: outOfScope.length === 0,
    turn,
    changedFiles,
    deletedFiles,
    outOfScopeFiles: outOfScope,
    declaredFiles: [...declared].map((p) => path.relative(ws, p).replace(/\\/g, "/")),
    diffStats: gitDiffStats(ws),
  };
}

/**
 * asd_render_summary: delegates to `asd summary` (unfinished-task guard,
 * phase -> done, session update, SUMMARY.md write) and returns the full
 * Markdown plus the final TODO block.
 * @param {Record<string, unknown>} args
 */
async function toolRenderSummary(args) {
  const ws = path.resolve(reqStr(args, "workspace"));
  const notes = optStr(args, "notes") ?? optStr(args, "finalNotes") ?? "";
  const r = spawnSync(
    process.execPath,
    [ASD_CLI, "--workspace", ws, "summary", ...(notes ? ["--notes", notes] : [])],
    { encoding: "utf8", cwd: ws, timeout: 30000 },
  );
  if (r.error) throw new Error(`failed to spawn ASD CLI: ${String(r.error)}`);
  if (r.status !== 0) {
    return { ok: false, error: (r.stderr || r.stdout || `exit ${r.status}`).trim() };
  }
  const summaryPath = path.join(ws, ".asd", "SUMMARY.md");
  const todoPath = path.join(ws, ".asd", "TODO.md");
  return {
    ok: true,
    markdown: fs.existsSync(summaryPath) ? fs.readFileSync(summaryPath, "utf8") : "",
    todoMarkdown: fs.existsSync(todoPath) ? fs.readFileSync(todoPath, "utf8") : "",
  };
}

/* ---------------- tool catalog ---------------- */

/** @type {any[]} */
const TOOLS = [
  {
    name: "asd_preflight",
    description:
      "Run ASD command preflight (session lock + deterministic mode detection) for /asd, /asd-plan, /asd-run, or /asd-status. Returns { mode, session, stateSummary, ... }.",
    inputSchema: {
      type: "object",
      required: ["workspace", "cmd"],
      properties: {
        workspace: { type: "string", description: "Absolute workspace root path" },
        cmd: { type: "string", enum: ["asd", "plan", "run", "status"] },
        sessionId: { type: "string" },
        forceTakeover: { type: "boolean" },
      },
    },
  },
  {
    name: "asd_route_next",
    description:
      "Resolve the 2-stage cross-harness model preset for a task: Stage 1 by category, Stage 2 by difficulty fallback, capped by the budget profile's proCap. Returns { matchedBy, presetKey, tier, agent, role, mcpHint, harnessSpec }.",
    inputSchema: {
      type: "object",
      properties: {
        category: { type: "string" },
        difficulty: { type: "string" },
        profile: { type: "string", enum: ["eco", "balanced", "performance"] },
        harness: { type: "string" },
        proUsed: { type: "number" },
      },
    },
  },
  {
    name: "asd_todo_mutate",
    description:
      "Mutate .asd/state.json and .asd/TODO.md through the ASD CLI (locking + validation + ledger included). action=start|done|fail|add|update; returns the rendered TODO console block.",
    inputSchema: {
      type: "object",
      required: ["workspace", "action"],
      properties: {
        workspace: { type: "string" },
        action: { type: "string", enum: ["start", "done", "fail", "add", "update"] },
        taskId: { type: "string", description: "T<turn>.<task>, required for start|done|fail|update" },
        turn: { type: "number", description: "Required for add" },
        flag: { type: "string", enum: ["SCAN", "PLAN", "BUILD", "TEST", "DEBUG", "VERIFY", "FIX"], description: "Required for add" },
        summary: { type: "string", description: "1..40 chars; required for add" },
        status: { type: "string", enum: ["space", "gt", "x", "bang", "tilde"], description: "Optional for update" },
        category: { type: "string" },
        difficulty: { type: "string" },
        tier: { type: "string" },
        files: { type: "array", items: { type: "string" }, description: "Declared file scope (add)" },
        reason: { type: "string", description: "Failure reason (fail)" },
      },
    },
  },
  {
    name: "asd_plan_validate",
    description:
      "Validate .asd/PLAN.md (or an inline markdown argument): structural headings, correction notice, per-Turn file-collision set-intersection across parallel tasks, and circular dependsOn detection from state.json. Returns { ok, errors, collisions, cycles }.",
    inputSchema: {
      type: "object",
      required: ["workspace"],
      properties: {
        workspace: { type: "string" },
        markdown: { type: "string", description: "Inline PLAN.md content; omit to read <workspace>/.asd/PLAN.md" },
      },
    },
  },
  {
    name: "asd_verify_turn",
    description:
      "Fact-check Turn <n>: compares the working tree against Turn n's baselineSnapshot (recorded at turn next), so earlier-Turn edits and pre-existing dirty files are never false-flagged. Every file changed during Turn n must belong to its declared files[]. Excludes .asd/**, .git/**, .omo/**, node_modules. Returns { ok, changedFiles, outOfScopeFiles, diffStats, ... }.",
    inputSchema: {
      type: "object",
      required: ["workspace", "turn"],
      properties: {
        workspace: { type: "string" },
        turn: { type: "number" },
      },
    },
  },
  {
    name: "asd_render_summary",
    description:
      "Generate .asd/SUMMARY.md (Mermaid flowchart LR, git diff --numstat file table, verification badges, tier usage), transition phase to done, and return the full Markdown plus the final TODO block. Fails while any task is unfinished.",
    inputSchema: {
      type: "object",
      required: ["workspace"],
      properties: {
        workspace: { type: "string" },
        notes: { type: "string", description: "Final synthesis notes" },
      },
    },
  },
];

/** @param {string} name @returns {(args: Record<string, unknown>) => Promise<any>} */
function handlerOf(name) {
  switch (name) {
    case "asd_preflight":
      return toolPreflight;
    case "asd_route_next":
      return toolRouteNext;
    case "asd_todo_mutate":
      return toolTodoMutate;
    case "asd_plan_validate":
      return toolPlanValidate;
    case "asd_verify_turn":
      return toolVerifyTurn;
    case "asd_render_summary":
      return toolRenderSummary;
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

/* ---------------- JSON-RPC 2.0 dispatch (line-delimited stdio) ---------------- */

/** @param {unknown} msg */
function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

/**
 * @param {string} method
 * @param {Record<string, unknown> | undefined} params
 * @returns {Promise<unknown>}
 */
async function dispatch(method, params) {
  const p = params ?? {};
  if (method === "initialize") {
    const requested = typeof p.protocolVersion === "string" ? p.protocolVersion : DEFAULT_PROTOCOL_VERSION;
    return {
      protocolVersion: requested,
      capabilities: { tools: { listChanged: false } },
      serverInfo: SERVER_INFO,
    };
  }
  if (method === "ping") return {};
  if (method === "tools/list") return { tools: TOOLS };
  if (method === "tools/call") {
    const name = typeof p.name === "string" ? p.name : "";
    const args =
      p.arguments !== null && typeof p.arguments === "object" && !Array.isArray(p.arguments)
        ? /** @type {Record<string, unknown>} */ (p.arguments)
        : {};
    const payload = await handlerOf(name)(args);
    return {
      content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
      // Domain failures that carry an `error` string are tool errors;
      // ok:false domain RESULTS (e.g. verify_turn out-of-scope report) are not.
      isError: payload !== null && typeof payload === "object" &&
        payload.ok === false && typeof payload.error === "string",
    };
  }
  const err = new Error(`method not found: ${method}`);
  err.name = "MethodNotFound";
  throw err;
}

/** @param {string} line */
async function handleLine(line) {
  /** @type {any} */
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    return;
  }
  const id = msg.id;
  const method = typeof msg.method === "string" ? msg.method : "";
  if (method === "") return; // a response to a request we never sent — ignore
  if (method.startsWith("notifications/")) return; // notifications get no response
  try {
    const result = await dispatch(method, msg.params);
    send({ jsonrpc: "2.0", id, result });
  } catch (e) {
    const notFound = e instanceof Error && e.name === "MethodNotFound";
    send({
      jsonrpc: "2.0",
      id,
      error: {
        code: notFound ? -32601 : -32603,
        message: e instanceof Error ? e.message : String(e),
      },
    });
  }
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let idx = buffer.indexOf("\n");
  while (idx !== -1) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (line !== "") void handleLine(line);
    idx = buffer.indexOf("\n");
  }
});
process.stdin.on("end", () => {
  process.exit(0);
});
process.stdin.resume();
