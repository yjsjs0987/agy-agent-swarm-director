// @ts-check
/**
 * Command preflight detector for `/asd`, `/asd-plan`, `/asd-run`,
 * `/asd-status` (plan Todo 7): session-lock integration plus deterministic
 * mode detection from the `.asd/` artifacts.
 *
 * Invariants:
 * - NEVER overwrites an existing PLAN.md/TODO.md; refine snapshots go to
 *   `.asd/history/<ISO-sanitized>-PLAN.md` (-TODO.md) as byte copies.
 * - Corrupt session.json/state.json degrade to "missing" (readJsonSafe +
 *   validators); preflight never throws on corrupt artifact content.
 */
import fs from "node:fs";
import path from "node:path";
import { ASD_DIR_NAME } from "./constants.mjs";
import { normalizeText, readJsonSafe, writeFileAtomic } from "./fs-atomic.mjs";
import { validateState } from "./schema.mjs";
import { parsePlanMarkdown, renderTodoMarkdown } from "./render.mjs";
import { loadOrInitSession } from "./session.mjs";

/** @typedef {import("./session.mjs").AsdSession} AsdSession */

/**
 * @typedef {Object} PreflightOptions
 * @property {string} cmd "plan" | "asd" | "run" | "status"
 * @property {string} sessionId
 * @property {boolean} [forceTakeover]
 */

/**
 * @typedef {Object} PreflightResult
 * @property {string} mode
 * @property {AsdSession} [session]
 * @property {boolean} [lockConflict]
 * @property {string} [holderConversationId]
 * @property {string} [lastSeenAt]
 * @property {{ asdDir: boolean, session: boolean, state: boolean, plan: boolean, todo: boolean, learnings: boolean }} [artifacts]
 * @property {string} [guidance]
 * @property {number} [nextTurn]
 * @property {{ id: string, flag: string, summary: string, tier: string, status: string }[]} [readyTasks]
 * @property {string} [phase]
 * @property {{ currentTurn: number, totalTurns: number, doneTasks: number, totalTasks: number } | null} [turnProgress]
 * @property {string | null} [todoMarkdown]
 * @property {{ valid: boolean, errors: string[], turns: unknown[], tasks: { id: string, status: string, turn: number, summary: string }[] }} [plan]
 * @property {{ slug: string, title: string, phase: string, profile: string, currentTurn: number, totalTurns: number, doneTasks: number, totalTasks: number } | null} [state]
 * @property {{ plan: string, todo: string | null }} [snapshots]
 */

/** @param {string} p @returns {boolean} */
const exists = (p) => fs.existsSync(p);

/** Windows-safe history filename stamp (":" is illegal in NTFS names). */
const stamp = () => new Date().toISOString().replace(/:/g, "-");

/**
 * Compact summary of a validated state.json (corrupt input never reaches
 * here — callers gate on validateState).
 * @param {any} state
 */
function stateSummary(state) {
  return {
    slug: state.slug,
    title: state.title,
    phase: state.phase,
    profile: state.profile,
    currentTurn: state.currentTurn,
    totalTurns: state.turns.length,
    doneTasks: state.tasks.filter(
      (/** @type {Record<string, unknown>} */ t) => t.status === "x",
    ).length,
    totalTasks: state.tasks.length,
  };
}

/**
 * Runs command preflight for `cmd` in `workspaceRoot`.
 *
 * Modes: `new_plan` | `refine_plan` | `refuse_no_plan` |
 * `resume_or_start_run` | `already_done` | `status` |
 * `locked_by_other_session`.
 *
 * @param {string} workspaceRoot
 * @param {PreflightOptions} options
 * @returns {Promise<PreflightResult>}
 */
export async function runPreflight(workspaceRoot, options) {
  const cmd = options.cmd;
  if (cmd !== "plan" && cmd !== "asd" && cmd !== "run" && cmd !== "status") {
    throw new TypeError(`cmd must be one of plan|asd|run|status, got: ${cmd}`);
  }
  const load = await loadOrInitSession(workspaceRoot, {
    conversationId: options.sessionId,
    command: cmd,
    forceTakeover: options.forceTakeover,
  });
  if ("lockConflict" in load) {
    return {
      mode: "locked_by_other_session",
      lockConflict: true,
      holderConversationId: load.holderConversationId,
      lastSeenAt: load.lastSeenAt,
    };
  }
  const session = load.session;
  const asdDir = path.join(workspaceRoot, ASD_DIR_NAME);
  const planPath = path.join(asdDir, "PLAN.md");
  const todoPath = path.join(asdDir, "TODO.md");
  const statePath = path.join(asdDir, "state.json");

  const stateRaw = readJsonSafe(statePath, null);
  const state = stateRaw !== null && validateState(stateRaw).ok ? stateRaw : null;

  const artifacts = {
    asdDir: exists(asdDir),
    session: exists(path.join(asdDir, "session.json")),
    state: state !== null,
    plan: exists(planPath),
    todo: exists(todoPath),
    learnings: exists(path.join(asdDir, "learnings.md")),
  };

  if (cmd === "plan" || cmd === "asd") {
    if (!artifacts.plan) {
      // loadOrInitSession already created the .asd/ skeleton + session.
      return { mode: "new_plan", session, artifacts };
    }
    const planBytes = fs.readFileSync(planPath, "utf8");
    const parsed = parsePlanMarkdown(normalizeText(planBytes));
    const tag = stamp();
    const historyDir = path.join(asdDir, "history");
    /** @type {{ plan: string, todo: string | null }} */
    const snapshots = { plan: path.join(historyDir, `${tag}-PLAN.md`), todo: null };
    await writeFileAtomic(snapshots.plan, planBytes);
    if (artifacts.todo) {
      snapshots.todo = path.join(historyDir, `${tag}-TODO.md`);
      await writeFileAtomic(snapshots.todo, fs.readFileSync(todoPath, "utf8"));
    }
    return {
      mode: "refine_plan",
      session,
      artifacts,
      plan: {
        valid: parsed.ok,
        errors: parsed.errors,
        turns: parsed.turns,
        tasks: parsed.tasks,
      },
      state: state ? stateSummary(state) : null,
      snapshots,
    };
  }

  if (cmd === "run") {
    if (!artifacts.plan) {
      return {
        mode: "refuse_no_plan",
        session,
        artifacts,
        guidance:
          "No .asd/PLAN.md found. Run /asd-plan (or /asd) first to create a plan, then retry /asd-run.",
      };
    }
    const parsed = parsePlanMarkdown(normalizeText(fs.readFileSync(planPath, "utf8")));
    /** @type {{ id: string, turn: number, task: number, flag: string, summary: string, tier: string, status: string, dependsOn: string[] }[]} */
    const tasks = state
      ? state.tasks.map((/** @type {any} */ t) => ({
          id: t.id,
          turn: t.turn,
          task: t.task,
          flag: t.flag,
          summary: t.summary,
          tier: t.tier,
          status: t.status,
          dependsOn: Array.isArray(t.dependsOn) ? t.dependsOn : [],
        }))
      : parsed.tasks.map((t) => ({ ...t, dependsOn: [] }));
    const unfinished = tasks.filter((t) => t.status !== "x");
    if (unfinished.length === 0) {
      return { mode: "already_done", session, artifacts };
    }
    const nextTurn = Math.min(...unfinished.map((t) => t.turn));
    const doneIds = new Set(
      tasks.filter((t) => t.status === "x").map((t) => t.id),
    );
    const readyTasks = unfinished
      .filter((t) => t.turn === nextTurn && (t.status === " " || t.status === ">"))
      .filter((t) => t.dependsOn.every((d) => doneIds.has(d)))
      .map((t) => ({
        id: t.id,
        flag: t.flag,
        summary: t.summary,
        tier: t.tier,
        status: t.status,
      }));
    return { mode: "resume_or_start_run", session, artifacts, nextTurn, readyTasks };
  }

  // cmd === "status"
  return {
    mode: "status",
    session,
    phase: session.phase,
    turnProgress: state
      ? {
          currentTurn: state.currentTurn,
          totalTurns: state.turns.length,
          doneTasks: state.tasks.filter(
            (/** @type {Record<string, unknown>} */ t) => t.status === "x",
          ).length,
          totalTasks: state.tasks.length,
        }
      : null,
    todoMarkdown: state ? renderTodoMarkdown(state) : null,
    state: state ? stateSummary(state) : null,
    artifacts,
  };
}
