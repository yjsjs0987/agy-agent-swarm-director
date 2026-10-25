// @ts-check
// allow: SIZE_OK — the plan mandates a single CLI entry point (scripts/asd.mjs);
// splitting would create files outside the approved deliverable set.
/**
 * asd — Agent Swarm Director CLI: state, Turn, and live TODO management.
 *
 * Invariants (plan Todo 8):
 * - Every mutating subcommand runs inside `withFileLock(<ws>/.asd/state.json.lock)`,
 *   validates state with `validateState` before writing, writes `.asd/state.json`
 *   and re-renders `.asd/TODO.md` via `writeFileAtomic`, then emits the updated
 *   TODO console box to stdout.
 * - Exit 0 on success; exit 1 on usage/validation errors (message on stderr,
 *   state byte-unchanged because nothing is written before validation passes).
 * - Zero external dependencies; all logic imported from ./lib/*.mjs.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

import {
  ASD_DIR_NAME,
  SCHEMA_VERSION,
  MAX_CONCURRENT_DEFAULT,
  DEFAULT_LOCALE,
  PHASE_FLAGS,
  TASK_STATUSES,
  MODEL_TIERS,
  BUDGET_PROFILES,
  TASK_CATEGORIES,
  TASK_DIFFICULTIES,
  SUPPORTED_LOCALES,
} from "./lib/constants.mjs";
import {
  ensureAsdDir,
  readJsonSafe,
  writeFileAtomic,
  withFileLock,
  appendJsonLine,
} from "./lib/fs-atomic.mjs";
import {
  validateState,
  validateTask,
  validateSession,
  validateTodoLine,
  validateInterviewMarkdown,
  PLAN_HEADINGS,
  SESSION_PHASES,
} from "./lib/schema.mjs";
import {
  renderTodoMarkdown,
  renderTodoConsoleBox,
  renderSummaryMarkdown,
  renderPlanTemplate,
  parsePlanMarkdown,
} from "./lib/render.mjs";
import {
  resolveModelPreset,
  resolveInitialTier,
  resolveNextEscalation,
  PROFILES,
} from "./lib/routing.mjs";
import { loadOrInitSession, sessionPath } from "./lib/session.mjs";
import { runPreflight } from "./lib/preflight.mjs";

/** Terminal error: message goes to stderr, process exits 1. */
class CliError extends Error {}

/** @param {string} msg @returns {never} */
function fail(msg) {
  throw new CliError(msg);
}

const USAGE = `asd — Agent Swarm Director CLI

Usage: node scripts/asd.mjs [--workspace <path>] [--json] <subcommand> [args]

Global flags:
  --workspace <path>  Workspace root (default: ASD_WORKSPACE env or cwd)
  --json              Machine-readable JSON output (status, turn next, preflight)

Subcommands:
  preflight --cmd <asd|plan|run|status> [--session <id>] [--force-takeover]
  init --slug <slug> --title <title> [--profile <eco|balanced|performance>] [--locale <ko|en>] [--session <id>]
  phase set <scouting|interviewing|planning|awaiting_approval|running|paused|done> [--approve-autonomy]
  turn next
  task start <Tturn.task> [--subagent <id>] [--tier <tier>]
  task done <Tturn.task> [--evidence <path>] [--summary <short>]
  task fail <Tturn.task> --reason <msg>
  todo add --turn <n> --flag <BUILD|TEST|DEBUG|VERIFY|FIX> --summary <text<=40> [--category <cat>] [--difficulty <diff>] [--tier <tier>] [--files <csv>] [--depends <csv>] [--acceptance <text>]
  todo update <Tturn.task> [--status <space|gt|x|bang|tilde>] [--summary <text<=40>] [--category <cat>] [--difficulty <diff>] [--tier <tier>]
  plan-init --slug <slug> --title <title> [--project-state <text>] [--understood <text>]
  lint [--file <path>]
  plan-import
  amend --reason <text> [--add-task-json <json>]
  checkpoint --turn <n>   git checkpoint for turn T<n> (needs options.gitCheckpoint; never pushes)
  rollback --turn <n>     git reset --hard to turn T<n>'s checkpoint, reset Turns > n to pending
  learn --category <build|test|debug|repo> --note <text>
  summary [--notes <text>]
  status`;

/* ---------------- arg parsing ---------------- */

/**
 * @param {string[]} argv
 * @returns {{ workspace: string | undefined, json: boolean, rest: string[] }}
 */
function parseGlobal(argv) {
  /** @type {string | undefined} */ let workspace;
  let json = false;
  let i = 0;
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") {
      json = true;
    } else if (a === "--workspace") {
      const v = argv[++i];
      if (v === undefined) fail("--workspace requires a path");
      workspace = v;
    } else if (a.startsWith("--workspace=")) {
      workspace = a.slice("--workspace=".length);
    } else {
      break;
    }
  }
  return { workspace, json, rest: argv.slice(i) };
}

/**
 * Minimal flag parser. `--name value` and `--name=value` both supported.
 * `--json` is always accepted (global flag may appear in any position).
 * @param {string[]} argv
 * @param {Set<string>} valueFlags
 * @param {Set<string>} boolFlags
 * @returns {{ positional: string[], flags: Record<string, string | boolean> }}
 */
function parseArgs(argv, valueFlags, boolFlags) {
  /** @type {Record<string, string | boolean>} */
  const flags = {};
  /** @type {string[]} */
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith("--")) {
      let name = a;
      let value;
      const eq = a.indexOf("=");
      if (eq !== -1) {
        name = a.slice(0, eq);
        value = a.slice(eq + 1);
      }
      if (name === "--json" || boolFlags.has(name)) {
        flags[name] = true;
        continue;
      }
      if (valueFlags.has(name)) {
        if (value === undefined) value = argv[++i];
        if (value === undefined) fail(`missing value for ${name}`);
        flags[name] = value;
        continue;
      }
      fail(`unknown flag: ${name}\n\n${USAGE}`);
    }
    positional.push(a);
  }
  return { positional, flags };
}

/** @param {Record<string, string | boolean>} f @param {string} name @returns {string} */
function req(f, name) {
  const v = f[name];
  if (typeof v !== "string" || v === "") fail(`missing required flag ${name}\n\n${USAGE}`);
  return v;
}

/** @param {string} v @param {readonly string[]} list @param {string} label @returns {string} */
function requireEnum(v, list, label) {
  if (!list.some((x) => x === v)) fail(`${label} must be one of ${list.join("|")}`);
  return v;
}

/** @param {string | boolean | undefined} v @returns {string[]} */
function csv(v) {
  return typeof v === "string" && v.trim() !== ""
    ? v.split(",").map((s) => s.trim()).filter((s) => s !== "")
    : [];
}

/* ---------------- paths & state helpers ---------------- */

/** @param {string} ws */
const asdDirOf = (ws) => path.join(ws, ASD_DIR_NAME);
/** @param {string} ws */
const statePathOf = (ws) => path.join(asdDirOf(ws), "state.json");
/** @param {string} ws */
const todoPathOf = (ws) => path.join(asdDirOf(ws), "TODO.md");
/** @param {string} ws */
const planPathOf = (ws) => path.join(asdDirOf(ws), "PLAN.md");
/** @param {string} ws */
const ledgerPathOf = (ws) => path.join(asdDirOf(ws), "ledger.jsonl");
/** @param {string} ws */
const stateLockOf = (ws) => path.join(asdDirOf(ws), "state.json.lock");

/** Default conversation id when --session is omitted. */
const defaultSessionId = () => process.env.ASD_SESSION_ID ?? "asd-cli";

/**
 * Loads and validates `.asd/state.json`; any problem is a terminal error.
 * @param {string} ws
 * @returns {any}
 */
function loadState(ws) {
  const raw = readJsonSafe(statePathOf(ws), null);
  if (raw === null) fail(`no .asd/state.json found under ${ws} — run "asd init" first`);
  const v = validateState(raw);
  if (!v.ok) fail(`invalid .asd/state.json: ${v.errors.join("; ")}`);
  return raw;
}

/**
 * Validates and atomically writes state + re-rendered TODO.md.
 * @param {string} ws
 * @param {any} state
 */
async function persist(ws, state) {
  state.updatedAt = new Date().toISOString();
  const v = validateState(state);
  if (!v.ok) fail(`state failed validation: ${v.errors.join("; ")}`);
  await writeFileAtomic(statePathOf(ws), JSON.stringify(state, null, 2) + "\n");
  await writeFileAtomic(todoPathOf(ws), renderTodoMarkdown(state));
}

/**
 * Patches `.asd/session.json` under its own lock (nested inside the state
 * lock is safe: no code path holds the session lock while wanting the state
 * lock).
 * @param {string} ws
 * @param {Record<string, unknown>} patch
 */
async function updateSession(ws, patch) {
  const sPath = sessionPath(ws);
  await withFileLock(`${sPath}.lock`, async () => {
    const s = readJsonSafe(sPath, null);
    if (s === null) fail(`no .asd/session.json found — run "asd init" first`);
    const next = { ...s, ...patch };
    const v = validateSession(next);
    if (!v.ok) fail(`session failed validation: ${v.errors.join("; ")}`);
    await writeFileAtomic(sPath, JSON.stringify(next, null, 2) + "\n");
  });
}

/**
 * Finds a task by `T<turn>.<task>` id; terminal error when missing.
 * @param {any} state
 * @param {string} id
 * @returns {any}
 */
function findTask(state, id) {
  if (!/^T\d+\.\d+$/.test(id)) fail(`invalid task id "${id}" — expected T<turn>.<task>`);
  const task = state.tasks.find((/** @type {{ id: string }} */ t) => t.id === id);
  if (!task) fail(`task ${id} not found`);
  return task;
}

/* ---------------- working-tree baseline & git stats ---------------- */

/** Directories never included in the Turn baseline snapshot. */
const BASELINE_EXCLUDE = new Set([".asd", ".git", ".omo", "node_modules"]);

/**
 * Recursive working-tree snapshot: relPath -> { mtimeMs, sha256 }.
 * relPath uses "/" separators so state.json stays platform-stable.
 * @param {string} ws
 * @returns {Record<string, { mtimeMs: number, sha256: string }>}
 */
function captureBaseline(ws) {
  /** @type {Record<string, { mtimeMs: number, sha256: string }>} */
  const snapshot = {};
  /** @param {string} dir @param {string} rel */
  const walk = (dir, rel) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (BASELINE_EXCLUDE.has(ent.name)) continue;
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
 * `git diff --numstat` rows excluding `.asd/**`; empty when git is absent
 * or the workspace is not a repo (bounded, read-only).
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

/* ---------------- subcommands ---------------- */

/** flag -> default subagent role for dynamically added tasks */
const ROLE_BY_FLAG = /** @type {Record<string, string>} */ ({
  SCAN: "scout",
  PLAN: "planner",
  BUILD: "worker",
  TEST: "worker",
  DEBUG: "debugger",
  VERIFY: "verifier",
  FIX: "worker",
});

/** `todo update --status` tokens -> raw status chars. */
const STATUS_TOKENS = /** @type {Record<string, string>} */ ({
  space: " ",
  gt: ">",
  x: "x",
  bang: "!",
  tilde: "~",
});

/**
 * @param {string} ws
 * @param {Record<string, string | boolean>} f
 */
async function cmdPreflight(ws, f) {
  const cmd = req(f, "--cmd");
  if (cmd !== "asd" && cmd !== "plan" && cmd !== "run" && cmd !== "status") {
    fail(`--cmd must be one of asd|plan|run|status`);
  }
  const result = await runPreflight(ws, {
    cmd,
    sessionId: typeof f["--session"] === "string" ? f["--session"] : defaultSessionId(),
    forceTakeover: f["--force-takeover"] === true,
  });
  return () => console.log(JSON.stringify(result, null, 2));
}

/**
 * Fresh state object (plan line 245 schema). Shared by `init` and `plan-init`.
 * @param {string} slug
 * @param {string} title
 * @param {string} profile
 * @param {string} locale
 */
function buildInitialState(slug, title, profile, locale) {
  return {
    schemaVersion: SCHEMA_VERSION,
    slug,
    title,
    phase: "planning",
    profile,
    options: {
      includeTests: false,
      includeDebug: false,
      gitCheckpoint: false,
      learnings: false,
      locale,
      maxConcurrent: MAX_CONCURRENT_DEFAULT,
    },
    limits: {
      maxTurns: 8,
      maxTasksTotal: 64,
      maxAttemptsPerTask: 3,
      maxNoProgressContinues: 3,
      proCap: PROFILES[profile].proCap,
    },
    counters: {
      flash_lite: 0,
      flash: 0,
      pro: 0,
      orchestrator: 0,
      noProgressContinues: 0,
    },
    currentTurn: 0,
    turns: [],
    tasks: [],
    lintErrors: [],
    updatedAt: new Date().toISOString(),
  };
}

/**
 * @param {string} ws
 * @param {Record<string, string | boolean>} f
 */
async function cmdInit(ws, f) {
  const slug = req(f, "--slug");
  const title = req(f, "--title");
  const profile = requireEnum(
    typeof f["--profile"] === "string" ? f["--profile"] : "balanced",
    BUDGET_PROFILES,
    "--profile",
  );
  const locale = requireEnum(
    typeof f["--locale"] === "string" ? f["--locale"] : DEFAULT_LOCALE,
    SUPPORTED_LOCALES,
    "--locale",
  );
  const sessionId = typeof f["--session"] === "string" ? f["--session"] : defaultSessionId();

  await ensureAsdDir(ws);
  const load = await loadOrInitSession(ws, { conversationId: sessionId });
  if ("lockConflict" in load) {
    fail(
      `session locked by "${load.holderConversationId}" (last seen ${load.lastSeenAt}); ` +
        `retry with a stale/inactive holder or run "asd preflight --force-takeover"`,
    );
  }

  const state = buildInitialState(slug, title, profile, locale);

  await withFileLock(stateLockOf(ws), async () => {
    if (readJsonSafe(statePathOf(ws), null) !== null) {
      fail(`.asd/state.json already exists under ${ws} — workspace already initialized`);
    }
    await persist(ws, state);
  });
  return () => console.log(renderTodoConsoleBox(state));
}

/**
 * @param {string} ws
 * @param {string[]} positional
 * @param {Record<string, string | boolean>} f
 */
async function cmdPhaseSet(ws, positional, f) {
  if (positional[0] !== "set" || positional.length !== 2) {
    fail(`usage: asd phase set <phase> [--approve-autonomy]\n\n${USAGE}`);
  }
  const phase = requireEnum(positional[1], SESSION_PHASES, "phase");
  const state = await withFileLock(stateLockOf(ws), async () => {
    const st = loadState(ws);
    st.phase = phase;
    await updateSession(ws, {
      phase,
      ...(f["--approve-autonomy"] === true ? { autonomyGranted: true } : {}),
    });
    await persist(ws, st);
    return st;
  });
  return () => console.log(renderTodoConsoleBox(state));
}

/**
 * @param {string} ws
 * @param {boolean} json
 */
async function cmdTurnNext(ws, json) {
  const result = await withFileLock(stateLockOf(ws), async () => {
    const st = loadState(ws);
    const turnNums = [...new Set(st.tasks.map((/** @type {any} */ t) => t.turn))].sort(
      (a, b) => a - b,
    );
    let target = null;
    for (const n of turnNums) {
      const hasOpen = st.tasks.some(
        (/** @type {any} */ t) => t.turn === n && (t.status === " " || t.status === ">"),
      );
      if (hasOpen) {
        target = n;
        break;
      }
    }
    if (target === null) {
      fail("no Turn with pending or in-progress tasks — all tasks are complete, skipped, or blocked");
    }
    let entry = st.turns.find((/** @type {any} */ t) => t.turn === target);
    if (!entry) {
      entry = {
        turn: target,
        title: `Turn ${target}`,
        status: "pending",
        checkpointCommit: null,
        baselineSnapshot: null,
      };
      st.turns.push(entry);
    }
    entry.status = "in_progress";
    entry.baselineSnapshot = captureBaseline(ws);
    st.currentTurn = target;

    const doneIds = new Set(
      st.tasks
        .filter((/** @type {any} */ t) => t.status === "x" || t.status === "~")
        .map((/** @type {any} */ t) => t.id),
    );
    const ready = st.tasks
      .filter(
        (/** @type {any} */ t) =>
          t.turn === target && (t.status === " " || t.status === ">"),
      )
      .filter((/** @type {any} */ t) =>
        t.dependsOn.every((/** @type {string} */ d) => doneIds.has(d)),
      )
      .slice(0, st.options.maxConcurrent);
    // Re-resolve untouched tasks through the 2-stage category->difficulty
    // preset router; attempted tasks keep their escalated tier.
    for (const t of ready) {
      if (t.attempts === 0 && t.subagentId === null) {
        t.tier = resolveModelPreset({
          category: t.category,
          difficulty: t.difficulty,
          profile: st.profile,
          proUsed: st.counters.pro,
        }).tier;
      }
    }
    await persist(ws, st);
    return { state: st, target, ready };
  });
  if (json) {
    return () =>
      console.log(
        JSON.stringify({
          turn: result.target,
          tasks: result.ready.map((/** @type {any} */ t) => ({
            id: t.id,
            flag: t.flag,
            summary: t.summary,
            tier: t.tier,
            status: t.status,
            files: t.files,
            category: t.category,
            difficulty: t.difficulty,
          })),
        }),
      );
  }
  return () => console.log(renderTodoConsoleBox(result.state));
}

/**
 * @param {string} ws
 * @param {string[]} positional
 * @param {Record<string, string | boolean>} f
 */
async function cmdTaskStart(ws, positional, f) {
  if (positional.length !== 1) fail(`usage: asd task start <Tturn.task> [--subagent <id>] [--tier <tier>]`);
  const tier = typeof f["--tier"] === "string" ? requireEnum(f["--tier"], MODEL_TIERS, "--tier") : undefined;
  const state = await withFileLock(stateLockOf(ws), async () => {
    const st = loadState(ws);
    const task = findTask(st, positional[0]);
    task.status = ">";
    if (typeof f["--subagent"] === "string") task.subagentId = f["--subagent"];
    if (tier !== undefined) task.tier = tier;
    await persist(ws, st);
    return st;
  });
  return () => console.log(renderTodoConsoleBox(state));
}

/**
 * @param {string} ws
 * @param {string[]} positional
 * @param {Record<string, string | boolean>} f
 */
async function cmdTaskDone(ws, positional, f) {
  if (positional.length !== 1) fail(`usage: asd task done <Tturn.task> [--evidence <path>] [--summary <short>]`);
  const state = await withFileLock(stateLockOf(ws), async () => {
    const st = loadState(ws);
    const task = findTask(st, positional[0]);
    task.status = "x";
    if (typeof f["--evidence"] === "string") task.evidencePath = f["--evidence"];
    if (typeof f["--summary"] === "string") {
      appendJsonLine(ledgerPathOf(ws), {
        ts: new Date().toISOString(),
        event: "task_done",
        taskId: task.id,
        summary: f["--summary"],
      });
    }
    await persist(ws, st);
    return st;
  });
  return () => console.log(renderTodoConsoleBox(state));
}

/**
 * @param {string} ws
 * @param {string[]} positional
 * @param {Record<string, string | boolean>} f
 */
async function cmdTaskFail(ws, positional, f) {
  if (positional.length !== 1) fail(`usage: asd task fail <Tturn.task> --reason <msg>`);
  const reason = req(f, "--reason");
  const state = await withFileLock(stateLockOf(ws), async () => {
    const st = loadState(ws);
    const task = findTask(st, positional[0]);
    task.attempts += 1;
    const esc = resolveNextEscalation({
      currentTier: task.tier,
      attempts: task.attempts,
      maxAttempts: st.limits.maxAttemptsPerTask,
      profile: st.profile,
      proUsed: st.counters.pro,
    });
    task.lastError = reason;
    if (esc.nextTier !== null) task.tier = esc.nextTier;
    const blocked =
      esc.action === "blocked" || esc.nextTier === null || esc.nextTier === "orchestrator";
    task.status = blocked ? "!" : " ";
    appendJsonLine(ledgerPathOf(ws), {
      ts: new Date().toISOString(),
      event: "task_fail",
      taskId: task.id,
      reason,
      nextTier: esc.nextTier,
      action: esc.action,
    });
    await persist(ws, st);
    return st;
  });
  return () => console.log(renderTodoConsoleBox(state));
}

/**
 * @param {string} ws
 * @param {Record<string, string | boolean>} f
 */
async function cmdTodoAdd(ws, f) {
  const turn = Number.parseInt(req(f, "--turn"), 10);
  if (!Number.isInteger(turn) || turn < 1) fail("--turn must be an integer >= 1");
  const flag = requireEnum(req(f, "--flag"), PHASE_FLAGS, "--flag");
  const summary = req(f, "--summary");
  if (summary.length > 40) fail(`--summary must be 1..40 chars (got ${summary.length})`);
  const category = requireEnum(
    typeof f["--category"] === "string" ? f["--category"] : "general",
    TASK_CATEGORIES,
    "--category",
  );
  const difficulty = requireEnum(
    typeof f["--difficulty"] === "string" ? f["--difficulty"] : "reasoning-low",
    TASK_DIFFICULTIES,
    "--difficulty",
  );
  const requestedTier =
    typeof f["--tier"] === "string" ? requireEnum(f["--tier"], MODEL_TIERS, "--tier") : undefined;
  const files = csv(f["--files"]);
  const dependsOn = csv(f["--depends"]);
  const acceptance =
    typeof f["--acceptance"] === "string" ? f["--acceptance"] : "Task completed successfully";

  const state = await withFileLock(stateLockOf(ws), async () => {
    const st = loadState(ws);
    if (st.tasks.length >= st.limits.maxTasksTotal) {
      fail(`limits.maxTasksTotal reached (${st.limits.maxTasksTotal}) — cannot add more tasks`);
    }
    const nextNum = st.tasks
      .filter((/** @type {any} */ t) => t.turn === turn)
      .reduce((/** @type {number} */ m, /** @type {any} */ t) => Math.max(m, t.task), 0) + 1;
    const tier = resolveInitialTier({
      flag,
      role: ROLE_BY_FLAG[flag],
      category,
      difficulty,
      requestedTier,
      profile: st.profile,
      proUsed: st.counters.pro,
    }).tier;
    const task = {
      id: `T${turn}.${nextNum}`,
      turn,
      task: nextNum,
      flag,
      summary,
      category,
      difficulty,
      tier,
      role: ROLE_BY_FLAG[flag],
      status: " ",
      files,
      dependsOn,
      acceptance,
      attempts: 0,
      lastError: null,
      subagentId: null,
      evidencePath: null,
    };
    const v = validateTask(task);
    if (!v.ok) fail(`task failed validation: ${v.errors.join("; ")}`);
    if (!st.turns.some((/** @type {any} */ t) => t.turn === turn)) {
      st.turns.push({
        turn,
        title: `Turn ${turn}`,
        status: "pending",
        checkpointCommit: null,
        baselineSnapshot: null,
      });
    }
    st.tasks.push(task);
    await persist(ws, st);
    return st;
  });
  return () => console.log(renderTodoConsoleBox(state));
}

/**
 * @param {string} ws
 * @param {string[]} positional
 * @param {Record<string, string | boolean>} f
 */
async function cmdTodoUpdate(ws, positional, f) {
  if (positional.length !== 1) {
    fail(`usage: asd todo update <Tturn.task> [--status <space|gt|x|bang|tilde>] [...]`);
  }
  const state = await withFileLock(stateLockOf(ws), async () => {
    const st = loadState(ws);
    const task = findTask(st, positional[0]);
    if (f["--status"] !== undefined) {
      const raw = req(f, "--status");
      const s = STATUS_TOKENS[raw] ?? (TASK_STATUSES.some((x) => x === raw) ? raw : undefined);
      if (s === undefined) fail(`--status must be one of space|gt|x|bang|tilde (got "${raw}")`);
      task.status = s;
    }
    if (f["--summary"] !== undefined) {
      const summary = req(f, "--summary");
      if (summary.length > 40) fail(`--summary must be 1..40 chars (got ${summary.length})`);
      task.summary = summary;
    }
    if (f["--category"] !== undefined) task.category = requireEnum(req(f, "--category"), TASK_CATEGORIES, "--category");
    if (f["--difficulty"] !== undefined) task.difficulty = requireEnum(req(f, "--difficulty"), TASK_DIFFICULTIES, "--difficulty");
    if (f["--tier"] !== undefined) task.tier = requireEnum(req(f, "--tier"), MODEL_TIERS, "--tier");
    const v = validateTask(task);
    if (!v.ok) fail(`task failed validation: ${v.errors.join("; ")}`);
    await persist(ws, st);
    return st;
  });
  return () => console.log(renderTodoConsoleBox(state));
}

/**
 * @param {string} ws
 * @param {Record<string, string | boolean>} f
 */
async function cmdSummary(ws, f) {
  const notes = typeof f["--notes"] === "string" ? f["--notes"] : "";
  const out = await withFileLock(stateLockOf(ws), async () => {
    const st = loadState(ws);
    const unfinished = st.tasks.filter(
      (/** @type {any} */ t) => t.status !== "x" && t.status !== "~",
    );
    if (unfinished.length > 0) {
      fail(
        `cannot summarize: ${unfinished.length} task(s) not complete: ` +
          unfinished.map((/** @type {any} */ t) => `${t.id} [${t.status}]`).join(", "),
      );
    }
    const diffStats = gitDiffStats(ws);
    st.phase = "done";
    await updateSession(ws, { phase: "done" });
    await persist(ws, st);
    const md = renderSummaryMarkdown(st, { finalNotes: notes, diffStats });
    await writeFileAtomic(path.join(asdDirOf(ws), "SUMMARY.md"), md);
    return { state: st, md };
  });
  return () => console.log(out.md + "\n" + renderTodoConsoleBox(out.state));
}

/**
 * @param {string} ws
 * @param {boolean} json
 */
async function cmdStatus(ws, json) {
  const state = loadState(ws);
  const session = readJsonSafe(sessionPath(ws), null);
  if (json) {
    return () =>
      console.log(
        JSON.stringify({
          session,
          phase: state.phase,
          profile: state.profile,
          currentTurn: state.currentTurn,
          counters: state.counters,
          todoMarkdown: renderTodoMarkdown(state),
        }),
      );
  }
  return () => {
    console.log(`Session: ${session ? session.mainConversationId : "(none)"} (phase: ${session ? session.phase : "(none)"})`);
    console.log(`State: phase=${state.phase} | profile=${state.profile} | currentTurn=T${state.currentTurn}/${state.turns.length}`);
    console.log(
      `Counters: flash_lite=${state.counters.flash_lite} · flash=${state.counters.flash} · pro=${state.counters.pro} · orchestrator=${state.counters.orchestrator} · noProgressContinues=${state.counters.noProgressContinues}`,
    );
    console.log("");
    console.log(renderTodoMarkdown(state));
  };
}

/* ---------------- plan lint / import / amend (Todo 9) ---------------- */

/** Looser section-4 row shape than TODO_LINE_RE: catches over-long summaries. */
const PLAN_ROW_LOOSE_RE =
  /^- \[([ >x!~]?)\] \[(SCAN|PLAN|BUILD|TEST|DEBUG|VERIFY|FIX)\] T(\d+)\.(\d+)\s+(.*)$/;
const PLAN_ROW_SUMMARY_RE = /^(.{1,200}?)\s+·\s+(flash_lite|flash|pro|orchestrator)$/;
const LEARNINGS_ENTRY_RE = /^- \[.+\] \[.+\] .+$/;

/**
 * Strict PLAN.md lint beyond `validatePlanMarkdown` (which `parsePlanMarkdown`
 * already merges): explicit section-3 option booleans + profile enum, and
 * per-row checks (summary length, option-forbidden flags). Never throws.
 * @param {string} md
 * @returns {string[]}
 */
function lintPlanMarkdown(md) {
  const errors = [];
  const parsed = parsePlanMarkdown(md);
  errors.push(...parsed.errors);

  const lines = md.split(/\r?\n/);
  const idx = PLAN_HEADINGS.map((h) => lines.findIndex((l) => l.trim() === h));

  if (idx[2] !== -1) {
    const end = idx[3] > idx[2] ? idx[3] : lines.length;
    const sec3 = lines.slice(idx[2] + 1, end);
    for (const key of ["includeTests", "includeDebug", "gitCheckpoint", "learnings"]) {
      const hit = sec3.find((l) => new RegExp(`^\\s*[-*]\\s+${key}:`).test(l));
      const val = hit === undefined ? undefined : hit.slice(hit.indexOf(":") + 1).trim();
      if (val !== "true" && val !== "false") {
        errors.push(`MISSING_OPTION_DECL: section 3 must declare "${key}: true|false"`);
      }
    }
    const profHit = sec3.find((l) => /^\s*[-*]\s+profile:/.test(l));
    const prof = profHit === undefined ? undefined : profHit.slice(profHit.indexOf("profile:") + "profile:".length).trim();
    if (!BUDGET_PROFILES.some((p) => p === prof)) {
      errors.push(`INVALID_PROFILE: section 3 must declare "profile: eco|balanced|performance"`);
    }
  }

  if (idx[3] !== -1) {
    const end = idx[4] > idx[3] ? idx[4] : lines.length;
    for (const line of lines.slice(idx[3] + 1, end)) {
      if (!line.startsWith("- [")) continue;
      const m = PLAN_ROW_LOOSE_RE.exec(line);
      const sm = m === null ? null : PLAN_ROW_SUMMARY_RE.exec(m[5]);
      if (m === null || sm === null) {
        errors.push(`INVALID_TASK_ROW: ${line}`);
        continue;
      }
      const id = `T${m[3]}.${m[4]}`;
      if (sm[1].length > 40) {
        errors.push(`SUMMARY_TOO_LONG: ${id} summary is ${sm[1].length} chars (max 40)`);
        continue;
      }
      const v = validateTodoLine(line);
      if (!v.ok) {
        errors.push(`INVALID_TASK_ROW: ${line}`);
        continue;
      }
      if (v.parsed.flag === "TEST" && !parsed.options.includeTests) {
        errors.push(`TEST_TASK_FORBIDDEN_BY_OPTIONS: ${id} ([TEST] task but includeTests is false)`);
      }
      if (v.parsed.flag === "DEBUG" && !parsed.options.includeDebug) {
        errors.push(`DEBUG_TASK_FORBIDDEN_BY_OPTIONS: ${id} ([DEBUG] task but includeDebug is false)`);
      }
    }
  }
  return errors;
}

/**
 * Basic `.asd/learnings.md` format check: header + `- [<date>] [<category>] <note>` rows.
 * @param {string} md
 * @returns {string[]}
 */
function lintLearningsMarkdown(md) {
  const nonEmpty = md.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (nonEmpty.length === 0 || nonEmpty[0].trim() !== "# ASD Project Learnings") {
    return ['LEARNINGS_FORMAT: first line must be "# ASD Project Learnings"'];
  }
  const errors = [];
  for (const l of nonEmpty.slice(1)) {
    if (!LEARNINGS_ENTRY_RE.test(l)) {
      errors.push(`LEARNINGS_FORMAT: entry does not match "- [<date>] [<category>] <note>": ${l}`);
    }
  }
  return errors;
}

/**
 * Full lint pass over the `.asd/` artifacts. Collects every error across
 * PLAN.md, TODO.md, state.json, session.json (+ interview.md / learnings.md
 * when present), then records/clears `state.lintErrors` when state.json exists
 * and is valid. Never crashes on missing/corrupt files.
 * @param {string} ws
 * @param {string} planPath
 * @returns {Promise<string[]>}
 */
async function runLint(ws, planPath) {
  const errors = [];
  let planMd = null;
  try {
    planMd = fs.readFileSync(planPath, "utf8");
  } catch {
    errors.push(`PLAN_NOT_FOUND: ${planPath}`);
  }
  if (planMd !== null) errors.push(...lintPlanMarkdown(planMd));

  const todoPath = todoPathOf(ws);
  if (!fs.existsSync(todoPath)) {
    errors.push(`TODO_NOT_FOUND: ${todoPath}`);
  } else {
    for (const l of fs.readFileSync(todoPath, "utf8").split(/\r?\n/)) {
      if (!l.startsWith("- [")) continue;
      const v = validateTodoLine(l);
      if (!v.ok) errors.push(`INVALID_TODO_LINE: ${l} -> ${v.errors.join("; ")}`);
    }
  }

  const rawState = readJsonSafe(statePathOf(ws), null);
  /** @type {any} */ let state = null;
  if (rawState === null) {
    errors.push(`STATE_NOT_FOUND: ${statePathOf(ws)} — run "asd init" or "asd plan-init" first`);
  } else {
    const v = validateState(rawState);
    if (!v.ok) errors.push(...v.errors.map((e) => `STATE_INVALID: ${e}`));
    else state = rawState;
  }

  const rawSession = readJsonSafe(sessionPath(ws), null);
  if (rawSession === null) {
    errors.push(`SESSION_NOT_FOUND: ${sessionPath(ws)}`);
  } else {
    const v = validateSession(rawSession);
    if (!v.ok) errors.push(...v.errors.map((e) => `SESSION_INVALID: ${e}`));
  }

  const interviewPath = path.join(asdDirOf(ws), "interview.md");
  if (fs.existsSync(interviewPath)) {
    const v = validateInterviewMarkdown(fs.readFileSync(interviewPath, "utf8"));
    if (!v.ok) errors.push(...v.errors.map((e) => `INTERVIEW_INVALID: ${e}`));
  }
  const learningsPath = path.join(asdDirOf(ws), "learnings.md");
  if (fs.existsSync(learningsPath)) {
    errors.push(...lintLearningsMarkdown(fs.readFileSync(learningsPath, "utf8")));
  }

  if (state !== null) {
    await withFileLock(stateLockOf(ws), async () => {
      const st = loadState(ws);
      st.lintErrors = errors;
      await persist(ws, st);
    });
  }
  return errors;
}

/**
 * @param {string} ws
 * @param {Record<string, string | boolean>} f
 */
async function cmdPlanInit(ws, f) {
  const slug = req(f, "--slug");
  const title = req(f, "--title");
  const projectState = typeof f["--project-state"] === "string" ? f["--project-state"] : undefined;
  const understood = typeof f["--understood"] === "string" ? f["--understood"] : undefined;

  await ensureAsdDir(ws);
  const load = await loadOrInitSession(ws, { conversationId: defaultSessionId() });
  if ("lockConflict" in load) {
    fail(
      `session locked by "${load.holderConversationId}" (last seen ${load.lastSeenAt}); ` +
        `retry with a stale/inactive holder or run "asd preflight --force-takeover"`,
    );
  }

  const state = await withFileLock(stateLockOf(ws), async () => {
    /** @type {any} */ let st = readJsonSafe(statePathOf(ws), null);
    if (st === null) {
      st = buildInitialState(slug, title, "balanced", DEFAULT_LOCALE);
      await persist(ws, st);
    } else {
      const v = validateState(st);
      if (!v.ok) fail(`invalid .asd/state.json: ${v.errors.join("; ")}`);
    }
    const md = renderPlanTemplate({
      slug: st.slug,
      title: st.title,
      ...(projectState !== undefined ? { projectState } : {}),
      ...(understood !== undefined ? { understoodCommand: understood } : {}),
      questions: [],
      options: { ...st.options, profile: st.profile },
      turns: st.turns.map((/** @type {any} */ t) => ({ turn: t.turn, title: t.title })),
      tasks: st.tasks.map((/** @type {any} */ t) => ({
        turn: t.turn,
        task: t.task,
        flag: t.flag,
        status: t.status,
        summary: t.summary,
        tier: t.tier,
        files: t.files,
        category: t.category,
        difficulty: t.difficulty,
      })),
      criteria: [],
      amendments: [],
      locale: st.options.locale,
    });
    await writeFileAtomic(planPathOf(ws), md);
    return st;
  });
  return () =>
    console.log(`PLAN.md initialized at ${planPathOf(ws)}\n\n` + renderTodoConsoleBox(state));
}

/**
 * @param {string} ws
 * @param {Record<string, string | boolean>} f
 */
async function cmdLint(ws, f) {
  const planPath = typeof f["--file"] === "string" ? path.resolve(f["--file"]) : planPathOf(ws);
  const errors = await runLint(ws, planPath);
  if (errors.length > 0) {
    throw new CliError(
      `lint failed with ${errors.length} error(s):\n${errors.map((e) => `- ${e}`).join("\n")}`,
    );
  }
  return () => console.log("lint: passed (PLAN.md, TODO.md, state.json, session.json checked)");
}

/**
 * @param {string} ws
 */
async function cmdPlanImport(ws) {
  const planPath = planPathOf(ws);
  let planMd;
  try {
    planMd = fs.readFileSync(planPath, "utf8");
  } catch {
    fail(`no .asd/PLAN.md found under ${ws} — run "asd plan-init" first`);
  }
  const planErrors = lintPlanMarkdown(planMd);
  if (planErrors.length > 0) {
    fail(
      `plan-import aborted: PLAN.md lint failed with ${planErrors.length} error(s):\n` +
        planErrors.map((e) => `- ${e}`).join("\n"),
    );
  }
  const parsed = parsePlanMarkdown(planMd);

  const state = await withFileLock(stateLockOf(ws), async () => {
    const st = loadState(ws);
    st.options.includeTests = parsed.options.includeTests;
    st.options.includeDebug = parsed.options.includeDebug;
    st.options.gitCheckpoint = parsed.options.gitCheckpoint;
    st.options.learnings = parsed.options.learnings;
    st.options.locale = parsed.options.locale;
    const prevProfile = st.profile;
    st.profile = requireEnum(parsed.options.profile, BUDGET_PROFILES, "plan profile");
    if (st.profile !== prevProfile) st.limits.proCap = PROFILES[st.profile].proCap;

    const prevTurns = new Map(st.turns.map((/** @type {any} */ t) => [t.turn, t]));
    st.turns = parsed.turns.map((pt) => {
      const prev = prevTurns.get(pt.turn);
      return prev !== undefined
        ? { ...prev, title: pt.title }
        : { turn: pt.turn, title: pt.title, status: "pending", checkpointCommit: null, baselineSnapshot: null };
    });

    const prevTasks = new Map(st.tasks.map((/** @type {any} */ t) => [t.id, t]));
    st.tasks = parsed.tasks.map((pt) => {
      /** @type {any} */ const fresh = {
        id: pt.id,
        turn: pt.turn,
        task: pt.task,
        flag: pt.flag,
        summary: pt.summary,
        category: pt.category,
        difficulty: pt.difficulty,
        tier: pt.tier,
        role: ROLE_BY_FLAG[pt.flag] ?? "worker",
        status: pt.status,
        files: pt.files,
        dependsOn: [],
        acceptance: "Imported from PLAN.md",
        attempts: 0,
        lastError: null,
        subagentId: null,
        evidencePath: null,
      };
      const prev = prevTasks.get(pt.id);
      if (prev !== undefined && prev.status === "x") {
        fresh.status = "x";
        fresh.evidencePath = prev.evidencePath;
        fresh.attempts = prev.attempts;
        fresh.lastError = prev.lastError;
        fresh.subagentId = prev.subagentId;
      }
      const v = validateTask(fresh);
      if (!v.ok) fail(`imported task ${pt.id} failed validation: ${v.errors.join("; ")}`);
      return fresh;
    });
    await persist(ws, st);
    return st;
  });
  return () => console.log(renderTodoConsoleBox(state));
}

/**
 * @param {string} ws
 * @param {Record<string, string | boolean>} f
 */
async function cmdAmend(ws, f) {
  const reason = req(f, "--reason");
  const addJson = typeof f["--add-task-json"] === "string" ? f["--add-task-json"] : null;
  if (addJson !== null) {
    let parsed;
    try {
      parsed = JSON.parse(addJson);
    } catch {
      fail("--add-task-json must be valid JSON");
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      fail("--add-task-json must be a JSON object");
    }
  }
  const planPath = planPathOf(ws);
  let planMd;
  try {
    planMd = fs.readFileSync(planPath, "utf8");
  } catch {
    fail(`no .asd/PLAN.md found under ${ws} — run "asd plan-init" first`);
  }
  const lines = planMd.split(/\r?\n/);
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const hIdx = lines.findIndex((l) => l.trim() === PLAN_HEADINGS[5]);
  if (hIdx === -1) {
    fail(`PLAN.md has no "${PLAN_HEADINGS[5]}" heading — run "asd plan-init" first`);
  }
  if (lines[hIdx + 1] !== undefined && lines[hIdx + 1].trim() === "(none)") {
    lines.splice(hIdx + 1, 1);
  }
  const entry = `- [${new Date().toISOString()}] ${reason}`;
  lines.push(entry, ...(addJson !== null ? [`  added-task: ${addJson}`] : []));
  await writeFileAtomic(planPath, lines.join("\n") + "\n");

  const errors = await runLint(ws, planPath);
  if (errors.length > 0) {
    fail(
      `amend appended, but lint now fails with ${errors.length} error(s):\n` +
        errors.map((e) => `- ${e}`).join("\n"),
    );
  }
  return () => console.log(`amended: ${entry}\nlint: passed`);
}

/* ---------------- git checkpoint / rollback / learnings (Todo 10) ---------------- */

/** Learnings-memory categories (X7). */
const LEARN_CATEGORIES = ["build", "test", "debug", "repo"];

/**
 * Runs one git command in the workspace; any failure is a terminal error.
 * Never pushes — callers only ever pass local, bounded commands.
 * @param {string} ws
 * @param {string[]} args
 * @returns {string} trimmed stdout
 */
function gitRun(ws, args) {
  try {
    return execFileSync("git", args, {
      cwd: ws,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (e) {
    const err = /** @type {{ stderr?: unknown, message: string }} */ (e);
    const detail = typeof err.stderr === "string" ? err.stderr.trim() : err.message;
    fail(`git ${args.join(" ")} failed: ${detail}`);
  }
}

/**
 * True when the workspace is inside a git work tree (bounded, read-only).
 * @param {string} ws
 * @returns {boolean}
 */
function isGitRepo(ws) {
  try {
    return (
      execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
        cwd: ws,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim() === "true"
    );
  } catch {
    return false;
  }
}

/** @param {Record<string, string | boolean>} f @returns {number} */
function parseTurnFlag(f) {
  const turn = Number.parseInt(req(f, "--turn"), 10);
  if (!Number.isInteger(turn) || turn < 1) fail("--turn must be an integer >= 1");
  return turn;
}

/**
 * `checkpoint --turn <n>`: stage everything except .asd/session.json,
 * .asd/ledger.jsonl and .omo/, commit `chore(asd): checkpoint turn T<n>
 * (<turnTitle>)`, and record the SHA on the turn entry. Zero commits and a
 * skipped notice when options.gitCheckpoint is false; never pushes.
 * @param {string} ws
 * @param {Record<string, string | boolean>} f
 */
async function cmdCheckpoint(ws, f) {
  const turn = parseTurnFlag(f);
  const probe = loadState(ws);
  if (probe.options.gitCheckpoint === false) {
    return () =>
      console.log(JSON.stringify({ skipped: true, reason: "gitCheckpoint disabled in plan options" }));
  }
  if (!isGitRepo(ws)) {
    fail(`checkpoint requires a git repository — run "git init" in ${ws} first`);
  }
  const state = await withFileLock(stateLockOf(ws), async () => {
    const st = loadState(ws);
    const entry = st.turns.find((/** @type {any} */ t) => t.turn === turn);
    if (!entry) fail(`turn T${turn} not found in state.turns — run "asd turn next" first`);
    // add -A respects .gitignore (session.json/ledger.jsonl/.omo are ignored
    // in ASD workspaces); the reset unstages them if a user ever tracked them
    // by hand. Exclude pathspecs are avoided: naming an ignored file trips
    // git's advice error.
    gitRun(ws, ["add", "-A", "--", "."]);
    gitRun(ws, ["reset", "-q", "--", ".asd/session.json", ".asd/ledger.jsonl", ".omo"]);
    gitRun(ws, ["commit", "-m", `chore(asd): checkpoint turn T${turn} (${entry.title})`]);
    entry.checkpointCommit = gitRun(ws, ["rev-parse", "HEAD"]);
    await persist(ws, st);
    return st;
  });
  return () => console.log(renderTodoConsoleBox(state));
}

/**
 * `rollback --turn <n>`: `git reset --hard` to the turn's checkpointCommit,
 * reset tasks in Turns > n back to pending, re-render TODO.md. Only runs when
 * explicitly invoked; never pushes.
 * @param {string} ws
 * @param {Record<string, string | boolean>} f
 */
async function cmdRollback(ws, f) {
  const turn = parseTurnFlag(f);
  const state = await withFileLock(stateLockOf(ws), async () => {
    const st0 = loadState(ws);
    const entry0 = st0.turns.find((/** @type {any} */ t) => t.turn === turn);
    if (!entry0 || typeof entry0.checkpointCommit !== "string" || entry0.checkpointCommit === "") {
      fail(`no checkpoint recorded for turn T${turn} — run "asd checkpoint --turn ${turn}" first`);
    }
    const sha = entry0.checkpointCommit;
    gitRun(ws, ["reset", "--hard", sha]);
    // The reset restored the checkpoint-time state.json (it was staged by the
    // checkpoint); reload it and re-attach the SHA so the record survives persist.
    const st = loadState(ws);
    const entry = st.turns.find((/** @type {any} */ t) => t.turn === turn);
    if (entry) entry.checkpointCommit = sha;
    for (const t of st.tasks) {
      if (t.turn > turn) t.status = " ";
    }
    await persist(ws, st);
    return st;
  });
  return () => console.log(renderTodoConsoleBox(state));
}

/**
 * `learn --category <build|test|debug|repo> --note <text>`: append a strictly
 * formatted `- [<ISO-date>] [<category>] <note>` entry to .asd/learnings.md
 * (creating it with the header when missing) and validate the result. No-op
 * when options.learnings is false.
 * @param {string} ws
 * @param {Record<string, string | boolean>} f
 */
async function cmdLearn(ws, f) {
  const category = requireEnum(req(f, "--category"), LEARN_CATEGORIES, "--category");
  const note = req(f, "--note");
  if (/[\r\n]/.test(note)) fail("--note must be a single line");
  const st = loadState(ws);
  if (st.options.learnings === false) {
    return () =>
      console.log(JSON.stringify({ skipped: true, reason: "learnings disabled in plan options" }));
  }
  const learningsPath = path.join(asdDirOf(ws), "learnings.md");
  const entry = `- [${new Date().toISOString().slice(0, 10)}] [${category}] ${note}`;
  const existing = fs.existsSync(learningsPath) ? fs.readFileSync(learningsPath, "utf8") : null;
  if (existing === null || existing.trim() === "") {
    await writeFileAtomic(learningsPath, `# ASD Project Learnings\n\n${entry}\n`);
  } else {
    fs.appendFileSync(learningsPath, `${entry}\n`);
  }
  const errors = lintLearningsMarkdown(fs.readFileSync(learningsPath, "utf8"));
  if (errors.length > 0) {
    fail(`learnings.md failed validation after append:\n${errors.map((e) => `- ${e}`).join("\n")}`);
  }
  return () => console.log(`learned: ${entry}`);
}

/* ---------------- dispatch ---------------- */

/**
 * @param {string[]} argv
 * @returns {Promise<() => void>} deferred stdout emitter
 */
async function main(argv) {
  const g = parseGlobal(argv);
  const ws = path.resolve(g.workspace ?? process.env.ASD_WORKSPACE ?? process.cwd());
  const [sub, ...rest] = g.rest;
  if (sub === undefined || sub === "--help" || sub === "help") {
    return () => console.log(USAGE);
  }
  const json = g.json;

  if (sub === "preflight") {
    const { flags } = parseArgs(rest, new Set(["--cmd", "--session"]), new Set(["--force-takeover"]));
    return cmdPreflight(ws, flags);
  }
  if (sub === "init") {
    const { flags } = parseArgs(rest, new Set(["--slug", "--title", "--profile", "--locale", "--session"]), new Set());
    return cmdInit(ws, flags);
  }
  if (sub === "phase") {
    const { positional, flags } = parseArgs(rest, new Set(), new Set(["--approve-autonomy"]));
    return cmdPhaseSet(ws, positional, flags);
  }
  if (sub === "turn") {
    const { positional } = parseArgs(rest, new Set(), new Set());
    if (positional[0] !== "next" || positional.length !== 1) fail(`usage: asd turn next`);
    return cmdTurnNext(ws, json);
  }
  if (sub === "task") {
    const kind = rest[0];
    if (kind === "start") {
      const { positional, flags } = parseArgs(rest.slice(1), new Set(["--subagent", "--tier"]), new Set());
      return cmdTaskStart(ws, positional, flags);
    }
    if (kind === "done") {
      const { positional, flags } = parseArgs(rest.slice(1), new Set(["--evidence", "--summary"]), new Set());
      return cmdTaskDone(ws, positional, flags);
    }
    if (kind === "fail") {
      const { positional, flags } = parseArgs(rest.slice(1), new Set(["--reason"]), new Set());
      return cmdTaskFail(ws, positional, flags);
    }
    fail(`unknown task subcommand: ${kind ?? "(none)"}\n\n${USAGE}`);
  }
  if (sub === "todo") {
    const kind = rest[0];
    if (kind === "add") {
      const { flags } = parseArgs(
        rest.slice(1),
        new Set(["--turn", "--flag", "--summary", "--category", "--difficulty", "--tier", "--files", "--depends", "--acceptance"]),
        new Set(),
      );
      return cmdTodoAdd(ws, flags);
    }
    if (kind === "update") {
      const { positional, flags } = parseArgs(
        rest.slice(1),
        new Set(["--status", "--summary", "--category", "--difficulty", "--tier"]),
        new Set(),
      );
      return cmdTodoUpdate(ws, positional, flags);
    }
    fail(`unknown todo subcommand: ${kind ?? "(none)"}\n\n${USAGE}`);
  }
  if (sub === "plan-init") {
    const { flags } = parseArgs(rest, new Set(["--slug", "--title", "--project-state", "--understood"]), new Set());
    return cmdPlanInit(ws, flags);
  }
  if (sub === "lint") {
    const { flags } = parseArgs(rest, new Set(["--file"]), new Set());
    return cmdLint(ws, flags);
  }
  if (sub === "plan-import") {
    const { positional } = parseArgs(rest, new Set(), new Set());
    if (positional.length > 0) fail(`usage: asd plan-import`);
    return cmdPlanImport(ws);
  }
  if (sub === "amend") {
    const { flags } = parseArgs(rest, new Set(["--reason", "--add-task-json"]), new Set());
    return cmdAmend(ws, flags);
  }
  if (sub === "checkpoint") {
    const { flags } = parseArgs(rest, new Set(["--turn"]), new Set());
    return cmdCheckpoint(ws, flags);
  }
  if (sub === "rollback") {
    const { flags } = parseArgs(rest, new Set(["--turn"]), new Set());
    return cmdRollback(ws, flags);
  }
  if (sub === "learn") {
    const { flags } = parseArgs(rest, new Set(["--category", "--note"]), new Set());
    return cmdLearn(ws, flags);
  }
  if (sub === "summary") {
    const { flags } = parseArgs(rest, new Set(["--notes"]), new Set());
    return cmdSummary(ws, flags);
  }
  if (sub === "status") {
    const { positional } = parseArgs(rest, new Set(), new Set());
    if (positional.length > 0) fail(`usage: asd status`);
    return cmdStatus(ws, json);
  }
  fail(`unknown subcommand: ${sub}\n\n${USAGE}`);
}

main(process.argv.slice(2)).then(
  (emit) => {
    emit();
  },
  (e) => {
    const msg = e instanceof CliError ? e.message : e instanceof Error ? (e.stack ?? e.message) : String(e);
    console.error(msg);
    process.exit(1);
  },
);
