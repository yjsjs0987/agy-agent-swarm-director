// @ts-check
/**
 * ASD `PreToolUse` hybrid guard (plan Todo 15).
 *
 * Reads the Antigravity hook payload from stdin, writes exactly one JSON
 * object to stdout, and ALWAYS exits 0 (fail-open: the user's IDE never
 * wedges on a hook crash).
 *
 * Rules, in order:
 * - Fast exit: no `workspaceRoot` or no `<root>/.asd/session.json` -> `{}`.
 * - Rule A: writes to CLI-owned `.asd/` machine files -> FORMAT_GUARD deny.
 * - Rule B: source writes during planning phases -> PLAN_GUARD deny (main
 *   session AND scout subagents); running-phase Main-Orchestrator source
 *   writes without a covering escalated orchestrator task -> DELEGATION_GUARD
 *   deny. Worker subagent sessions pass through in running phase.
 * - Rule C: `invoke_subagent` model-tier/profile enforcement via routing.mjs.
 *
 * Hard invariant: NEVER emits `"decision": "allow"` — every output passes
 * through `assertNoAllowDecision` (runtime-contract.mjs); a violation falls
 * back to the neutral output and is logged.
 */
import fs from "node:fs";
import path from "node:path";
import {
  WRITE_TOOL_MATCHER,
  SUBAGENT_TOOL_MATCHER,
  NEUTRAL_PRE_TOOL_OUTPUT,
  MODEL_ENFORCEMENT_MODE,
  assertNoAllowDecision,
} from "../lib/runtime-contract.mjs";
import { inspectSubagentCall } from "../lib/routing.mjs";
import { isMainOrchestratorSession, sessionPath } from "../lib/session.mjs";
import {
  isSubpath,
  normalizePathForCompare,
  readJsonSafe,
} from "../lib/fs-atomic.mjs";
import { validateState } from "../lib/schema.mjs";

/** CLI entry the FORMAT_GUARD reason tells the user to run instead. */
const ASD_CLI = "scripts/asd.mjs";

/**
 * CLI-owned machine files inside `.asd/` (Rule A). Compared case-insensitively
 * because Windows filesystems resolve `.asd/todo.md` to `.asd/TODO.md`.
 * PLAN.md, interview.md, and learnings.md are NOT machine files.
 */
const MACHINE_FILES = new Set([
  "todo.md",
  "summary.md",
  "state.json",
  "session.json",
  "ledger.jsonl",
]);

/** Phases where ALL source writes outside `.asd/` are blocked (Rule B). */
const PLAN_GUARD_PHASES = new Set([
  "scouting",
  "interviewing",
  "planning",
  "awaiting_approval",
]);

/** Path-arg keys observed in the live write guard (Task 1); first found wins. */
const PATH_ARG_KEYS = ["path", "PathToCurrentFile", "file_path", "fileName"];

/** @param {string} reason @returns {{ decision: "deny", reason: string }} */
const deny = (reason) => ({ decision: "deny", reason });

/** Reads the whole hook payload from stdin ("" on any read error). */
function readStdin() {
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

/**
 * Best-effort append to `<root>/.asd/hook-errors.log`.
 * @param {string | null} root
 * @param {unknown} e
 */
function logError(root, e) {
  if (typeof root !== "string" || root.length === 0) return;
  try {
    fs.appendFileSync(
      path.join(root, ".asd", "hook-errors.log"),
      `${new Date().toISOString()} pre-tool-guard: ${String(e instanceof Error ? e.stack : e)}\n`,
    );
  } catch {
    /* best-effort: never let logging break the hook */
  }
}

/**
 * Serializes `obj` to stdout after the never-allow invariant; a violation
 * falls back to the neutral output and is logged.
 * @param {object} obj
 * @param {string | null} root
 */
function emit(obj, root) {
  let out = obj;
  try {
    assertNoAllowDecision(out);
  } catch (e) {
    logError(root, e);
    out = {};
  }
  process.stdout.write(JSON.stringify(out));
}

/** First workspace path from the hook payload, or null. @param {any} input */
function workspaceRootOf(input) {
  const p = input?.workspacePaths?.[0];
  return typeof p === "string" && p.length > 0 ? p : null;
}

/**
 * Valid `.asd/state.json` or null. Absent, corrupt, or schema-invalid state
 * is treated as no-state (all state-dependent rules pass through neutrally).
 * @param {string} root
 */
function loadState(root) {
  const s = readJsonSafe(path.join(root, ".asd", "state.json"), null);
  return s !== null && validateState(s).ok ? s : null;
}

/**
 * Resolved absolute write target or null (no recognizable path arg key).
 * Relative paths resolve against `root`.
 * @param {Record<string, unknown>} args
 * @param {string} root
 */
function targetOf(args, root) {
  for (const key of PATH_ARG_KEYS) {
    const v = args[key];
    if (typeof v === "string" && v.length > 0) return path.resolve(root, v);
  }
  return null;
}

/**
 * True when an in-progress (`status ">"`) orchestrator-tier task of the
 * current turn declares `target` in its `files[]`.
 * @param {any} state
 * @param {string} root
 * @param {string} target
 */
function orchestratorTaskCovers(state, root, target) {
  const norm = normalizePathForCompare(target);
  const tasks = Array.isArray(state.tasks) ? state.tasks : [];
  return tasks.some(
    (/** @type {any} */ t) =>
      t !== null &&
      typeof t === "object" &&
      t.status === ">" &&
      t.tier === "orchestrator" &&
      t.turn === state.currentTurn &&
      Array.isArray(t.files) &&
      t.files.some(
        (/** @type {unknown} */ f) =>
          typeof f === "string" &&
          normalizePathForCompare(path.resolve(root, f)) === norm,
      ),
  );
}

/**
 * Guard decision for a parsed hook payload in an active ASD workspace.
 * @param {any} input
 * @param {string} root
 * @returns {object}
 */
function decide(input, root) {
  const name = typeof input?.toolCall?.name === "string" ? input.toolCall.name : "";
  const rawArgs = input?.toolCall?.args;
  const args =
    rawArgs !== null && typeof rawArgs === "object" && !Array.isArray(rawArgs)
      ? rawArgs
      : /** @type {Record<string, unknown>} */ ({});
  const isWrite = WRITE_TOOL_MATCHER.test(name);
  const isSubagent = SUBAGENT_TOOL_MATCHER.test(name);
  if (!isWrite && !isSubagent) return {};

  const state = loadState(root);
  const target = isWrite ? targetOf(args, root) : null;

  if (isWrite && target !== null) {
    const asdDir = path.join(root, ".asd");
    const inAsd = isSubpath(asdDir, target);
    if (inAsd && MACHINE_FILES.has(path.basename(target).toLowerCase())) {
      return deny(
        `[ASD_FORMAT_GUARD] .asd/TODO.md, SUMMARY.md, state.json, and session.json are format-enforced machine files. Update them only via: node "${ASD_CLI}" <subcommand>.`,
      );
    }
    if (state !== null && !inAsd) {
      if (PLAN_GUARD_PHASES.has(state.phase)) {
        return deny(
          "[ASD_PLAN_GUARD] Source file modifications are blocked during ASD planning phase. Write plan artifacts to .asd/PLAN.md or transition to /asd-run after user approval.",
        );
      }
      if (
        state.phase === "running" &&
        isMainOrchestratorSession(root, input?.conversationId) &&
        !orchestratorTaskCovers(state, root, target)
      ) {
        return deny(
          "[ASD_ORCHESTRATOR_DELEGATION_GUARD] During /asd-run, the Main Orchestrator must delegate source file edits to subagents via invoke_subagent (direct edits are permitted only when a task has escalated to tier: 'orchestrator').",
        );
      }
    }
  }

  if (isSubagent && state !== null) {
    const r = inspectSubagentCall({ toolArgs: args, state });
    if (r.action === "rewrite_or_deny" && MODEL_ENFORCEMENT_MODE === "deny") {
      return deny(
        `[ASD_MODEL_POLICY] Re-invoke invoke_subagent with Model: '${r.targetModel}' (active profile: ${state.profile})`,
      );
    }
    if (r.action === "deny") {
      return deny(
        `[ASD_BUDGET_GUARD] Profile '${state.profile}' pro cap reached or forbidden. Re-invoke invoke_subagent with Model: 'flash'.`,
      );
    }
    // action "allow" (valid concrete Model) -> neutral pass-through.
  }
  return {};
}

function main() {
  /** @type {string | null} */
  let root = null;
  try {
    const input = JSON.parse(readStdin());
    root = workspaceRootOf(input);
    // Fast exit: this hook runs on EVERY tool call in ANY workspace — no
    // state reads before the .asd/session.json existence check.
    if (root === null || !fs.existsSync(sessionPath(root))) {
      emit(NEUTRAL_PRE_TOOL_OUTPUT, root);
      return;
    }
    emit(decide(input, root), root);
  } catch (e) {
    logError(root, e);
    emit({}, root);
  }
}

main();
