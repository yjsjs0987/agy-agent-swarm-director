// @ts-check
/**
 * ASD `PreInvocation` hook (plan Todo 16).
 *
 * For the MAIN Orchestrator session only (conversationId ===
 * session.mainConversationId): injects a compact `[ASD_STATE]` ephemeral
 * message (CLI path, phase, profile, turn, task counts, lint errors, TODO.md
 * reminder) and best-effort updates `session.lastSeenAt` +
 * `state.counters.orchestrator`, throttled to at most one write every 30s.
 * Subagent sessions and non-ASD workspaces get `{}` immediately.
 *
 * Contract: JSON stdin -> JSON stdout, exit 0, fail-open on any error.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  readJsonSafe,
  writeFileAtomic,
  withFileLock,
} from "../lib/fs-atomic.mjs";
import { isMainOrchestratorSession, sessionPath } from "../lib/session.mjs";
import { validateState } from "../lib/schema.mjs";

/** Minimum interval between session/state writes (plan line 657). */
const THROTTLE_MS = 30_000;

/** Lock waits are capped: hooks run synchronously inside the agent loop. */
const LOCK_TIMEOUT_MS = 2_000;

/** Absolute ASD CLI entry, resolved from this file's location (cwd-independent). */
const ASD_CLI = fileURLToPath(new URL("../asd.mjs", import.meta.url));

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
      `${new Date().toISOString()} pre-invocation-status: ${String(e instanceof Error ? e.stack : e)}\n`,
    );
  } catch {
    /* best-effort: never let logging break the hook */
  }
}

/** @param {object} obj */
function emit(obj) {
  process.stdout.write(JSON.stringify(obj));
}

/** First workspace path from the hook payload, or null. @param {any} input */
function workspaceRootOf(input) {
  const p = input?.workspacePaths?.[0];
  return typeof p === "string" && p.length > 0 ? p : null;
}

/**
 * Task counts by TODO status: " " pending, ">" in_progress, "x" done,
 * "!" blocked.
 * @param {any} state
 */
function taskCounts(state) {
  const tasks = Array.isArray(state.tasks) ? state.tasks : [];
  const counts = { pending: 0, in_progress: 0, done: 0, blocked: 0 };
  for (const t of tasks) {
    if (t === null || typeof t !== "object") continue;
    if (t.status === " ") counts.pending++;
    else if (t.status === ">") counts.in_progress++;
    else if (t.status === "x") counts.done++;
    else if (t.status === "!") counts.blocked++;
  }
  return counts;
}

/**
 * Compact status message, <= 6 lines (plan line 658-660).
 * @param {any} state
 * @param {string} conversationId
 */
function statusMessage(state, conversationId) {
  const c = taskCounts(state);
  const lines = [
    `[ASD_STATE] cli="${ASD_CLI}" session="${conversationId}" phase="${state.phase}" profile="${state.profile}" turn="T${state.currentTurn}" pending=${c.pending} in_progress=${c.in_progress} done=${c.done} blocked=${c.blocked}`,
  ];
  const lint = Array.isArray(state.lintErrors) ? state.lintErrors : [];
  for (const e of lint.slice(0, 3)) lines.push(`LINT: ${e}`);
  if (lint.length > 3) lines.push(`LINT: ...and ${lint.length - 3} more`);
  lines.push("Remember: update and print .asd/TODO.md to the user every Turn.");
  return lines.join("\n");
}

/**
 * Throttled best-effort writes: session.lastSeenAt + counters.orchestrator.
 * Never throws; a lock timeout or write failure just skips the heartbeat.
 * @param {string} root
 */
async function throttledWrites(root) {
  try {
    const cachePath = path.join(root, ".asd", ".preinvocation-cache.json");
    const cache = readJsonSafe(cachePath, null);
    const last =
      cache !== null && typeof cache === "object" && typeof cache.lastWriteAt === "string"
        ? Date.parse(cache.lastWriteAt)
        : NaN;
    if (Number.isFinite(last) && Date.now() - last < THROTTLE_MS) return;

    const now = new Date().toISOString();
    const sPath = sessionPath(root);
    await withFileLock(
      `${sPath}.lock`,
      async () => {
        const session = readJsonSafe(sPath, null);
        if (session !== null && typeof session === "object") {
          session.lastSeenAt = now;
          await writeFileAtomic(sPath, JSON.stringify(session, null, 2) + "\n");
        }
      },
      { timeoutMs: LOCK_TIMEOUT_MS },
    );

    const statePath = path.join(root, ".asd", "state.json");
    await withFileLock(
      `${statePath}.lock`,
      async () => {
        const state = readJsonSafe(statePath, null);
        if (state !== null && validateState(state).ok) {
          const counters = state.counters;
          if (counters !== null && typeof counters === "object") {
            counters.orchestrator =
              (typeof counters.orchestrator === "number" && Number.isFinite(counters.orchestrator)
                ? counters.orchestrator
                : 0) + 1;
          }
          state.updatedAt = now;
          await writeFileAtomic(statePath, JSON.stringify(state, null, 2) + "\n");
        }
      },
      { timeoutMs: LOCK_TIMEOUT_MS },
    );

    await writeFileAtomic(cachePath, JSON.stringify({ lastWriteAt: now }) + "\n");
  } catch {
    /* best-effort: heartbeat failures never break the injection */
  }
}

async function main() {
  /** @type {string | null} */
  let root = null;
  try {
    const input = JSON.parse(readStdin());
    root = workspaceRootOf(input);
    // Fast exit: non-ASD workspace or no session.json -> {} immediately.
    if (root === null || !fs.existsSync(sessionPath(root))) {
      emit({});
      return;
    }
    const conversationId =
      typeof input?.conversationId === "string" ? input.conversationId : "";
    // Subagent shield: only the main Orchestrator gets the status injection.
    if (!isMainOrchestratorSession(root, conversationId)) {
      emit({});
      return;
    }
    const state = readJsonSafe(path.join(root, ".asd", "state.json"), null);
    if (state === null || !validateState(state).ok) {
      emit({});
      return;
    }
    await throttledWrites(root);
    emit({ injectSteps: [{ ephemeralMessage: statusMessage(state, conversationId) }] });
  } catch (e) {
    logError(root, e);
    emit({});
  }
}

main().catch(() => {});
