// @ts-check
/**
 * ASD `SessionStart` hook (plan Todo 16, X1).
 *
 * When a new conversation opens in a workspace that already carries an
 * unfinished `.asd/` run, injects a resume banner (ephemeral message) with the
 * current Turn, remaining task count, the absolute ASD CLI path, and how to
 * resume. Otherwise outputs `{}`.
 *
 * Contract: JSON stdin -> JSON stdout, exit 0, fail-open on any error.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readJsonSafe } from "../lib/fs-atomic.mjs";
import { validateState } from "../lib/schema.mjs";

/** Phases that mean "there is a run worth resuming" (plan line 654). */
const RESUMABLE_PHASES = new Set(["running", "paused", "awaiting_approval"]);

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
      `${new Date().toISOString()} session-start-resume: ${String(e instanceof Error ? e.stack : e)}\n`,
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
 * Resume banner decision for a parsed payload in a workspace with `.asd/`.
 * @param {string} root
 * @returns {object}
 */
function decide(root) {
  const state = readJsonSafe(path.join(root, ".asd", "state.json"), null);
  if (state === null || !validateState(state).ok) return {};
  if (!RESUMABLE_PHASES.has(state.phase)) return {};
  const tasks = Array.isArray(state.tasks) ? state.tasks : [];
  const remaining = tasks.filter(
    (/** @type {any} */ t) => t !== null && typeof t === "object" && t.status !== "x",
  ).length;
  const msg =
    `[ASD_RESUME] Existing .asd/ state found: phase "${state.phase}", current Turn T${state.currentTurn}, ${remaining} remaining task(s).\n` +
    `ASD CLI: ${ASD_CLI}\n` +
    `Resume with /asd-run to continue execution, or check progress with /asd-status.`;
  return { injectSteps: [{ ephemeralMessage: msg }] };
}

function main() {
  /** @type {string | null} */
  let root = null;
  try {
    const input = JSON.parse(readStdin());
    root = workspaceRootOf(input);
    // Fast exit: no workspace or no .asd/state.json -> nothing to resume.
    if (root === null || !fs.existsSync(path.join(root, ".asd", "state.json"))) {
      emit({});
      return;
    }
    emit(decide(root));
  } catch (e) {
    logError(root, e);
    emit({});
  }
}

main();
