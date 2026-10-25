// @ts-check
/**
 * ASD `Stop` hook (plan Todo 16).
 *
 * Keeps an autonomous `/asd-run` alive while ready/pending tasks remain, with
 * hard safety rails:
 * - **Subagent Shield**: a conversationId that is not
 *   `session.mainConversationId` gets `{}` IMMEDIATELY — subagents are NEVER
 *   trapped by ASD's Stop hook.
 * - Never continues on USER_CANCELED / ERROR / MAX_INVOCATIONS /
 *   MAX_FORCED_INVOCATIONS / MAX_TOKEN_BUDGET_EXCEEDED / TERMINAL_CUSTOM_HOOK,
 *   or when `fullyIdle === false` (background subagents still running).
 * - Circuit breaker: after `limits.maxNoProgressContinues` (3) consecutive
 *   continues, flips `state.phase` to "paused" and outputs `{}`.
 *
 * Contract: JSON stdin -> JSON stdout, exit 0, fail-open on any error.
 */
import fs from "node:fs";
import path from "node:path";
import { assertNoAllowDecision } from "../lib/runtime-contract.mjs";
import { sessionPath } from "../lib/session.mjs";
import {
  readJsonSafe,
  writeFileAtomic,
  withFileLock,
} from "../lib/fs-atomic.mjs";
import { validateState } from "../lib/schema.mjs";

/** Termination reasons that must NEVER be overridden with "continue". */
const BLOCKED_REASONS = new Set([
  "USER_CANCELED",
  "ERROR",
  "MAX_INVOCATIONS",
  "MAX_FORCED_INVOCATIONS",
  "MAX_TOKEN_BUDGET_EXCEEDED",
  "TERMINAL_CUSTOM_HOOK",
]);

/** Lock waits are capped: hooks run synchronously inside the agent loop. */
const LOCK_TIMEOUT_MS = 2_000;

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
      `${new Date().toISOString()} stop-guard: ${String(e instanceof Error ? e.stack : e)}\n`,
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

/** @param {unknown} v @returns {number} */
function numOr(v, fallback) {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

/**
 * Read-modify-write of a valid `.asd/state.json` under the state lock.
 * Returns true when the write happened (state existed and was valid).
 * @param {string} root
 * @param {(state: Record<string, unknown>) => void} mutate
 */
async function updateState(root, mutate) {
  const statePath = path.join(root, ".asd", "state.json");
  await withFileLock(
    `${statePath}.lock`,
    async () => {
      const state = readJsonSafe(statePath, null);
      if (state === null || !validateState(state).ok) return;
      mutate(state);
      state.updatedAt = new Date().toISOString();
      await writeFileAtomic(statePath, JSON.stringify(state, null, 2) + "\n");
    },
    { timeoutMs: LOCK_TIMEOUT_MS },
  );
}

/**
 * Stop decision for a parsed payload in an active ASD workspace.
 * @param {any} input
 * @param {string} root
 * @returns {Promise<object>}
 */
async function decide(input, root) {
  const state = readJsonSafe(path.join(root, ".asd", "state.json"), null);
  if (state === null || !validateState(state).ok) return {};
  if (state.phase !== "running") return {};

  // Ready/pending tasks only: " " (pending) or ">" (in_progress). Blocked
  // ("!") tasks cannot progress, so they never justify a continuation.
  const tasks = Array.isArray(state.tasks) ? state.tasks : [];
  const remaining = tasks.filter(
    (/** @type {any} */ t) =>
      t !== null && typeof t === "object" && (t.status === " " || t.status === ">"),
  );
  if (remaining.length === 0) return {};

  const max = Math.max(1, numOr(state.limits?.maxNoProgressContinues, 3));
  const noProgress = numOr(state.counters?.noProgressContinues, 0);

  if (noProgress >= max) {
    // Circuit breaker: pause the run instead of looping forever.
    await updateState(root, (s) => {
      s.phase = "paused";
    });
    return {};
  }

  await updateState(root, (s) => {
    const counters = s.counters;
    if (counters !== null && typeof counters === "object") {
      counters.noProgressContinues = numOr(counters.noProgressContinues, 0) + 1;
    }
  });
  return {
    decision: "continue",
    reason: `[ASD_AUTONOMOUS_RUN] Turn T${state.currentTurn} has ${remaining.length} remaining tasks. Continue /asd-run and print updated .asd/TODO.md.`,
  };
}

async function main() {
  /** @type {string | null} */
  let root = null;
  try {
    const input = JSON.parse(readStdin());
    root = workspaceRootOf(input);
    // Fast exit: no workspace or no session.json -> never continue.
    if (root === null || !fs.existsSync(sessionPath(root))) {
      emit({}, root);
      return;
    }
    const session = readJsonSafe(sessionPath(root), null);
    // Subagent Shield: without a valid session naming THIS conversation as the
    // main Orchestrator, we never continue (subagents must terminate freely).
    const conversationId =
      typeof input?.conversationId === "string" ? input.conversationId : "";
    if (
      session === null ||
      typeof session !== "object" ||
      session.mainConversationId !== conversationId
    ) {
      emit({}, root);
      return;
    }
    const reason =
      typeof input?.terminationReason === "string" ? input.terminationReason : "";
    if (BLOCKED_REASONS.has(reason) || input?.fullyIdle === false) {
      emit({}, root);
      return;
    }
    emit(await decide(input, root), root);
  } catch (e) {
    logError(root, e);
    emit({}, root);
  }
}

main().catch(() => {});
