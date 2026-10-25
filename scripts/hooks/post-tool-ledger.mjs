// @ts-check
/**
 * ASD `PostToolUse` hook (plan Todo 16).
 *
 * ALWAYS outputs `{}` on stdout (Antigravity PostToolUse contract) and never
 * crashes. Side effects, all best-effort, in an active ASD workspace:
 * - `invoke_subagent`-family tools: increment `state.counters[tier]` and
 *   append a `subagent_dispatch` row to `.asd/ledger.jsonl`.
 * - Write tools targeting `.asd/PLAN.md` / `.asd/interview.md`: run the
 *   markdown validators and store violations in `state.lintErrors` so the
 *   next PreInvocation forces the agent to fix them (Requirement #10).
 *
 * Contract: JSON stdin -> `{}` stdout, exit 0, fail-open on any error.
 */
import fs from "node:fs";
import path from "node:path";
import {
  SUBAGENT_TOOL_MATCHER,
  WRITE_TOOL_MATCHER,
} from "../lib/runtime-contract.mjs";
import { inspectSubagentCall } from "../lib/routing.mjs";
import { MODEL_TIERS } from "../lib/constants.mjs";
import { sessionPath } from "../lib/session.mjs";
import {
  appendJsonLine,
  normalizePathForCompare,
  readJsonSafe,
  writeFileAtomic,
  withFileLock,
} from "../lib/fs-atomic.mjs";
import {
  validateInterviewMarkdown,
  validatePlanMarkdown,
  validateState,
} from "../lib/schema.mjs";

/** Lock waits are capped: hooks run synchronously inside the agent loop. */
const LOCK_TIMEOUT_MS = 2_000;

/** Path-arg keys observed in the live write guard (Task 1); first found wins. */
const PATH_ARG_KEYS = ["path", "PathToCurrentFile", "file_path", "fileName"];

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
      `${new Date().toISOString()} post-tool-ledger: ${String(e instanceof Error ? e.stack : e)}\n`,
    );
  } catch {
    /* best-effort: never let logging break the hook */
  }
}

/** PostToolUse ALWAYS answers `{}`. */
function emit() {
  process.stdout.write("{}");
}

/** First workspace path from the hook payload, or null. @param {any} input */
function workspaceRootOf(input) {
  const p = input?.workspacePaths?.[0];
  return typeof p === "string" && p.length > 0 ? p : null;
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
 * Tier for a subagent dispatch: the Model arg when it is a known tier,
 * otherwise the routing-resolved tier (needs valid state), else null.
 * @param {Record<string, unknown>} args
 * @param {any} state
 * @returns {string | null}
 */
function tierOf(args, state) {
  const model = typeof args.Model === "string" ? args.Model : typeof args.model === "string" ? args.model : "";
  if (MODEL_TIERS.some((t) => t === model)) return model;
  if (state !== null) {
    const r = inspectSubagentCall({ toolArgs: args, state });
    if (typeof r.targetModel === "string" && MODEL_TIERS.some((t) => t === r.targetModel)) {
      return r.targetModel;
    }
  }
  return null;
}

/**
 * Read-modify-write of a valid `.asd/state.json` under the state lock.
 * Returns the fresh state (or null when absent/invalid/lock-timeout).
 * @param {string} root
 * @param {(state: Record<string, unknown>) => void} mutate
 * @returns {Promise<Record<string, unknown> | null>}
 */
async function updateState(root, mutate) {
  const statePath = path.join(root, ".asd", "state.json");
  return withFileLock(
    `${statePath}.lock`,
    async () => {
      const state = readJsonSafe(statePath, null);
      if (state === null || !validateState(state).ok) return null;
      mutate(state);
      state.updatedAt = new Date().toISOString();
      await writeFileAtomic(statePath, JSON.stringify(state, null, 2) + "\n");
      return state;
    },
    { timeoutMs: LOCK_TIMEOUT_MS },
  );
}

/**
 * Subagent dispatch: ledger row + tier counter increment (both best-effort).
 * @param {string} root
 * @param {string} tool
 * @param {Record<string, unknown>} args
 */
async function recordSubagent(root, tool, args) {
  try {
    const state = readJsonSafe(path.join(root, ".asd", "state.json"), null);
    const validState = state !== null && validateState(state).ok ? state : null;
    const tier = tierOf(args, validState);
    appendJsonLine(path.join(root, ".asd", "ledger.jsonl"), {
      ts: new Date().toISOString(),
      event: "subagent_dispatch",
      tool,
      tier: tier ?? "unknown",
    });
    if (tier !== null && validState !== null) {
      await updateState(root, (s) => {
        const counters = s.counters;
        if (counters !== null && typeof counters === "object") {
          const cur = counters[tier];
          counters[tier] = (typeof cur === "number" && Number.isFinite(cur) ? cur : 0) + 1;
        }
      });
    }
  } catch (e) {
    logError(root, e);
  }
}

/**
 * Lint a just-written PLAN.md / interview.md and store violations in
 * `state.lintErrors` (best-effort; a valid write clears that file's errors).
 * @param {string} root
 * @param {string} target absolute path of the written file
 */
async function lintWrittenPlan(root, target) {
  try {
    const norm = normalizePathForCompare(target);
    const planPath = path.join(root, ".asd", "PLAN.md");
    const interviewPath = path.join(root, ".asd", "interview.md");
    /** @type {((md: unknown) => { ok: boolean, errors: string[] }) | null} */
    let validate = null;
    /** @type {string} */
    let label = "";
    if (norm === normalizePathForCompare(planPath)) {
      validate = validatePlanMarkdown;
      label = "PLAN.md";
    } else if (norm === normalizePathForCompare(interviewPath)) {
      validate = validateInterviewMarkdown;
      label = "interview.md";
    }
    if (validate === null) return;
    let md = "";
    try {
      md = fs.readFileSync(target, "utf8");
    } catch {
      return; // file unreadable -> nothing to lint
    }
    const v = validate(md);
    const lintErrors = v.errors.map((e) => `${label}: ${e}`);
    await updateState(root, (s) => {
      s.lintErrors = lintErrors;
    });
  } catch (e) {
    logError(root, e);
  }
}

async function main() {
  /** @type {string | null} */
  let root = null;
  try {
    const input = JSON.parse(readStdin());
    root = workspaceRootOf(input);
    // Fast exit: this hook runs after EVERY tool call in ANY workspace.
    if (root === null || !fs.existsSync(sessionPath(root))) {
      emit();
      return;
    }
    const name = typeof input?.toolCall?.name === "string" ? input.toolCall.name : "";
    const rawArgs = input?.toolCall?.args;
    const args =
      rawArgs !== null && typeof rawArgs === "object" && !Array.isArray(rawArgs)
        ? /** @type {Record<string, unknown>} */ (rawArgs)
        : /** @type {Record<string, unknown>} */ ({});

    if (SUBAGENT_TOOL_MATCHER.test(name)) {
      await recordSubagent(root, name, args);
    } else if (WRITE_TOOL_MATCHER.test(name)) {
      const target = targetOf(args, root);
      if (target !== null) await lintWrittenPlan(root, target);
    }
  } catch (e) {
    logError(root, e);
  }
  emit();
}

main().catch(() => emit());
