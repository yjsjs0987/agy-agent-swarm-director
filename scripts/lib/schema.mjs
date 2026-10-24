// @ts-check
// allow: SIZE_OK — the plan mandates a single canonical schema module (scripts/lib/schema.mjs);
// splitting would create files outside the approved deliverable set.
/**
 * Strict zero-dependency validators for every `.asd/` artifact.
 *
 * Contract for every exported validator:
 * - Returns `{ ok: boolean, errors: string[] }` (never throws).
 * - `null` / `undefined` / non-object input is reported as an error, never coerced.
 * - All enumerated fields are required; invalid values are rejected, never auto-fixed.
 * - Unknown extra keys are tolerated (forward compatibility); only listed fields are validated.
 *
 * PLAN.md section 4 task-row contract (consumed by the duplicate-file check and,
 * later, by render.mjs `parsePlanMarkdown`):
 * - A task row is any line matching the TODO grammar
 *   `- [<status>] [<FLAG>] T<turn>.<task> <summary 1..40> · <tier>`.
 * - Its files are declared on a following line: optional indent + optional list
 *   dash + `files:` + comma-separated paths. `files: -` / `none` / `(none)` / empty
 *   means "no files".
 */
import {
  SCHEMA_VERSION,
  PHASE_FLAGS,
  TASK_STATUSES,
  MODEL_TIERS,
  BUDGET_PROFILES,
  TASK_CATEGORIES,
  TASK_DIFFICULTIES,
  SUPPORTED_LOCALES,
} from "./constants.mjs";

/** @type {readonly string[]} */
export const SESSION_PHASES = Object.freeze([
  "idle",
  "scouting",
  "interviewing",
  "planning",
  "awaiting_approval",
  "running",
  "paused",
  "done",
]);

/** @type {readonly string[]} */
export const ACTIVE_COMMANDS = Object.freeze([
  "asd",
  "asd-plan",
  "asd-run",
  "asd-status",
]);

/** @type {readonly string[]} */
export const TURN_STATUSES = Object.freeze([
  "pending",
  "in_progress",
  "done",
  "blocked",
]);

/** @type {readonly string[]} */
export const TASK_ROLES = Object.freeze([
  "scout",
  "planner",
  "worker-light",
  "worker",
  "verifier",
  "debugger",
]);

/** @type {readonly string[]} */
export const PLAN_HEADINGS = Object.freeze([
  "## 1. Current Project State",
  "## 2. Understood User Command",
  "## 3. Interview & Options",
  "## 4. Turn & Task Execution Plan",
  "## 5. Verification & Completion Criteria",
  "## 6. Runtime Amendments",
]);

/** Enforced `.asd/TODO.md` task-line grammar (plan line 246). */
export const TODO_LINE_RE =
  /^- \[([ >x!~])\] \[(SCAN|PLAN|BUILD|TEST|DEBUG|VERIFY|FIX)\]\s+T(\d+)\.(\d+)\s+(.{1,40}?)\s+·\s+(flash_lite|flash|pro|orchestrator)$/;

const TASK_ID_RE = /^T\d+\.\d+$/;
const ISO_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const FILES_LINE_RE = /^\s*[-*]?\s*files:\s*(.*)$/;
const QUESTION_HEADING_RE = /^#{2,3}\s+.*(질문|question)/i;
const Q_LABEL_HEADING_RE = /^#{2,3}\s+Q\d+\b/i;
const NUMBERED_QUESTION_RE = /^\s*\d+[.)]\s+.+\?\s*$/;
const NO_FILES_MARKERS = new Set(["", "-", "none", "(none)"]);

/** @typedef {{ ok: boolean, errors: string[] }} ValidationResult */
/** @typedef {ValidationResult & { parsed: { status: string, flag: string, turn: number, task: number, summary: string, tier: string } }} TodoLineResult */

/** @param {string[]} errors */
const bad = (errors) => ({ ok: false, errors });
const okResult = () => ({ ok: true, errors: [] });

/** @param {unknown} v @returns {v is Record<string, unknown>} */
const isObj = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
/** @param {unknown} v @returns {v is string} */
const isStr = (v) => typeof v === "string";
/** @param {unknown} v @returns {v is string} */
const isNE = (v) => isStr(v) && v.length > 0;
/** @param {unknown} v */
const isBool = (v) => typeof v === "boolean";
/** @param {unknown} v */
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
/** @param {unknown} v @returns {v is number} */
const isInt = (v) => Number.isInteger(v);
/** @param {unknown} v */
const isISO = (v) => isStr(v) && ISO_RE.test(v) && !Number.isNaN(Date.parse(v));
/** @param {unknown} v @param {readonly string[]} list */
const inEnum = (v, list) => list.some((x) => x === v);
/** @param {unknown} v */
const isNEArray = (v) => Array.isArray(v) && v.every(isNE);
/** @param {unknown} v */
const isStrArray = (v) => Array.isArray(v) && v.every(isStr);
/** @param {unknown} v */
const isNullableStr = (v) => v === null || isStr(v);

/**
 * Validate `.asd/session.json`.
 * @param {unknown} obj
 * @returns {ValidationResult}
 */
export function validateSession(obj) {
  if (!isObj(obj)) return bad(["session must be a non-null object"]);
  const errors = [];
  if (obj.schemaVersion !== SCHEMA_VERSION) {
    errors.push(`schemaVersion must be ${SCHEMA_VERSION}`);
  }
  if (!isNE(obj.mainConversationId)) {
    errors.push("mainConversationId must be a non-empty string");
  }
  if (!isNE(obj.projectRoot)) {
    errors.push("projectRoot must be a non-empty string");
  }
  if (!(obj.activeCommand === null || inEnum(obj.activeCommand, ACTIVE_COMMANDS))) {
    errors.push(
      `activeCommand must be one of ${ACTIVE_COMMANDS.join("|")} or null`,
    );
  }
  if (!inEnum(obj.phase, SESSION_PHASES)) {
    errors.push(`phase must be one of ${SESSION_PHASES.join("|")}`);
  }
  if (!isISO(obj.startedAt)) {
    errors.push("startedAt must be an ISO-8601 string");
  }
  if (!isISO(obj.lastSeenAt)) {
    errors.push("lastSeenAt must be an ISO-8601 string");
  }
  if (!isBool(obj.autonomyGranted)) {
    errors.push("autonomyGranted must be a boolean");
  }
  if (!Array.isArray(obj.previousSessions)) {
    errors.push("previousSessions must be an array");
  } else {
    obj.previousSessions.forEach((s, i) => {
      if (!isObj(s)) {
        errors.push(`previousSessions[${i}] must be an object`);
        return;
      }
      if (!isNE(s.conversationId)) {
        errors.push(`previousSessions[${i}].conversationId must be a non-empty string`);
      }
      if (!isISO(s.endedAt)) {
        errors.push(`previousSessions[${i}].endedAt must be an ISO-8601 string`);
      }
      if (!isNE(s.reason)) {
        errors.push(`previousSessions[${i}].reason must be a non-empty string`);
      }
    });
  }
  return errors.length ? bad(errors) : okResult();
}

/**
 * Validate one task object from `.asd/state.json` `tasks[]`.
 * @param {unknown} task
 * @returns {ValidationResult}
 */
export function validateTask(task) {
  if (!isObj(task)) return bad(["task must be a non-null object"]);
  const errors = [];
  if (!isStr(task.id) || !TASK_ID_RE.test(task.id)) {
    errors.push("id must match T<turn>.<task> (digits only, e.g. T1.2)");
  }
  if (!isInt(task.turn) || task.turn < 1) {
    errors.push("turn must be an integer >= 1");
  }
  if (!isInt(task.task) || task.task < 1) {
    errors.push("task must be an integer >= 1");
  }
  if (
    isStr(task.id) && isInt(task.turn) && isInt(task.task) &&
    task.id !== `T${task.turn}.${task.task}`
  ) {
    errors.push(`id "${task.id}" is inconsistent with turn ${task.turn} / task ${task.task}`);
  }
  if (!inEnum(task.flag, PHASE_FLAGS)) {
    errors.push(`flag must be one of ${PHASE_FLAGS.join("|")}`);
  }
  if (!isStr(task.summary) || task.summary.length < 1 || task.summary.length > 40) {
    errors.push("summary must be a string of 1..40 chars");
  }
  if (!inEnum(task.category, TASK_CATEGORIES)) {
    errors.push(`category must be one of ${TASK_CATEGORIES.join("|")}`);
  }
  if (!inEnum(task.difficulty, TASK_DIFFICULTIES)) {
    errors.push(`difficulty must be one of ${TASK_DIFFICULTIES.join("|")}`);
  }
  if (!inEnum(task.tier, MODEL_TIERS)) {
    errors.push(`tier must be one of ${MODEL_TIERS.join("|")}`);
  }
  if (!inEnum(task.role, TASK_ROLES)) {
    errors.push(`role must be one of ${TASK_ROLES.join("|")}`);
  }
  if (!inEnum(task.status, TASK_STATUSES)) {
    errors.push(`status must be one of ${JSON.stringify(TASK_STATUSES)}`);
  }
  if (!isNEArray(task.files)) {
    errors.push("files must be an array of non-empty strings");
  }
  if (!isNEArray(task.dependsOn)) {
    errors.push("dependsOn must be an array of non-empty strings");
  }
  if (!isNE(task.acceptance)) {
    errors.push("acceptance must be a non-empty string");
  }
  if (!isNum(task.attempts) || task.attempts < 0) {
    errors.push("attempts must be a number >= 0");
  }
  if (!isNullableStr(task.lastError)) {
    errors.push("lastError must be a string or null");
  }
  if (!isNullableStr(task.subagentId)) {
    errors.push("subagentId must be a string or null");
  }
  if (!isNullableStr(task.evidencePath)) {
    errors.push("evidencePath must be a string or null");
  }
  return errors.length ? bad(errors) : okResult();
}

/**
 * Validate `.asd/state.json` (full schema, plan line 245).
 * @param {unknown} obj
 * @returns {ValidationResult}
 */
export function validateState(obj) {
  if (!isObj(obj)) return bad(["state must be a non-null object"]);
  const errors = [];
  if (obj.schemaVersion !== SCHEMA_VERSION) {
    errors.push(`schemaVersion must be ${SCHEMA_VERSION}`);
  }
  if (!isNE(obj.slug)) errors.push("slug must be a non-empty string");
  if (!isNE(obj.title)) errors.push("title must be a non-empty string");
  if (!isNE(obj.phase)) errors.push("phase must be a non-empty string");
  if (!inEnum(obj.profile, BUDGET_PROFILES)) {
    errors.push(`profile must be one of ${BUDGET_PROFILES.join("|")}`);
  }

  const o = obj.options;
  if (!isObj(o)) errors.push("options must be an object");
  else {
    for (const k of ["includeTests", "includeDebug", "gitCheckpoint", "learnings"]) {
      if (!isBool(o[k])) errors.push(`options.${k} must be a boolean`);
    }
    if (!inEnum(o.locale, SUPPORTED_LOCALES)) {
      errors.push(`options.locale must be one of ${SUPPORTED_LOCALES.join("|")}`);
    }
    if (!isInt(o.maxConcurrent) || o.maxConcurrent < 1 || o.maxConcurrent > 8) {
      errors.push("options.maxConcurrent must be an integer in 1..8");
    }
  }

  const lim = obj.limits;
  if (!isObj(lim)) errors.push("limits must be an object");
  else {
    for (const k of ["maxTurns", "maxTasksTotal", "maxAttemptsPerTask", "maxNoProgressContinues", "proCap"]) {
      if (!isNum(lim[k]) || lim[k] < 0) errors.push(`limits.${k} must be a number >= 0`);
    }
  }

  const c = obj.counters;
  if (!isObj(c)) errors.push("counters must be an object");
  else {
    for (const k of ["flash_lite", "flash", "pro", "orchestrator", "noProgressContinues"]) {
      if (!isNum(c[k]) || c[k] < 0) errors.push(`counters.${k} must be a number >= 0`);
    }
  }

  if (!isInt(obj.currentTurn) || obj.currentTurn < 0) {
    errors.push("currentTurn must be an integer >= 0");
  }

  if (!Array.isArray(obj.turns)) errors.push("turns must be an array");
  else {
    obj.turns.forEach((t, i) => {
      const p = `turns[${i}]`;
      if (!isObj(t)) {
        errors.push(`${p} must be an object`);
        return;
      }
      if (!isInt(t.turn) || t.turn < 1) errors.push(`${p}.turn must be an integer >= 1`);
      if (!isNE(t.title)) errors.push(`${p}.title must be a non-empty string`);
      if (!inEnum(t.status, TURN_STATUSES)) {
        errors.push(`${p}.status must be one of ${TURN_STATUSES.join("|")}`);
      }
      if (!isNullableStr(t.checkpointCommit)) {
        errors.push(`${p}.checkpointCommit must be a string or null`);
      }
      if (t.baselineSnapshot !== null) {
        if (!isObj(t.baselineSnapshot)) {
          errors.push(`${p}.baselineSnapshot must be an object or null`);
        } else {
          for (const [path, snap] of Object.entries(t.baselineSnapshot)) {
            const q = `${p}.baselineSnapshot["${path}"]`;
            if (!isObj(snap)) {
              errors.push(`${q} must be an object`);
              continue;
            }
            if (!isNum(snap.mtimeMs)) errors.push(`${q}.mtimeMs must be a number`);
            if (!isNE(snap.sha256)) errors.push(`${q}.sha256 must be a non-empty string`);
          }
        }
      }
    });
  }

  if (!Array.isArray(obj.tasks)) errors.push("tasks must be an array");
  else {
    obj.tasks.forEach((t, i) => {
      const r = validateTask(t);
      if (!r.ok) errors.push(...r.errors.map((e) => `tasks[${i}]: ${e}`));
    });
  }

  if (!isStrArray(obj.lintErrors)) {
    errors.push("lintErrors must be an array of strings");
  }
  if (!isISO(obj.updatedAt)) errors.push("updatedAt must be an ISO-8601 string");
  return errors.length ? bad(errors) : okResult();
}

/**
 * Validate one `.asd/TODO.md` task line against the enforced grammar.
 * On success also returns the parsed fields.
 * @param {unknown} line
 * @returns {TodoLineResult}
 */
export function validateTodoLine(line) {
  if (!isStr(line)) return bad(["todo line must be a string"]);
  const m = TODO_LINE_RE.exec(line.replace(/\r$/, ""));
  if (!m) {
    return bad([
      "todo line does not match grammar: - [<status>] [<FLAG>] T<turn>.<task> <summary 1..40 chars> · <tier>",
    ]);
  }
  return {
    ok: true,
    errors: [],
    parsed: {
      status: m[1],
      flag: m[2],
      turn: Number(m[3]),
      task: Number(m[4]),
      summary: m[5],
      tier: m[6],
    },
  };
}

/**
 * Validate `.asd/PLAN.md` structure: exact headings in order, the section 2
 * user-correction notice, and no file shared by two tasks of the same Turn.
 * @param {unknown} md
 * @returns {ValidationResult}
 */
export function validatePlanMarkdown(md) {
  if (!isStr(md) || md.trim().length === 0) {
    return bad(["plan markdown must be a non-empty string"]);
  }
  const errors = [];
  const lines = md.split(/\r?\n/);
  const idx = PLAN_HEADINGS.map((h) => lines.findIndex((l) => l.trim() === h));
  let prev = -1;
  PLAN_HEADINGS.forEach((h, i) => {
    if (idx[i] === -1) errors.push(`MISSING_HEADING: ${h}`);
    else if (idx[i] <= prev) errors.push(`HEADING_ORDER: "${h}" appears out of order`);
    else prev = idx[i];
  });

  const h2 = idx[1];
  const h3 = idx[2];
  if (h2 !== -1) {
    const end = h3 !== -1 && h3 > h2 ? h3 : lines.length;
    const hasNotice = lines
      .slice(h2 + 1, end)
      .some((l) => l.includes("위 이해 내용이 의도와 다르거나") || l.includes("⚠️"));
    if (!hasNotice) {
      errors.push(
        'MISSING_CORRECTION_NOTICE: "## 2. Understood User Command" must include the user-correction callout',
      );
    }
  }

  const h4 = idx[3];
  const h5 = idx[4];
  if (h4 !== -1) {
    const end = h5 !== -1 && h5 > h4 ? h5 : lines.length;
    /** @type {{ turn: number, files: Set<string> }[]} */
    const tasks = [];
    let cur = null;
    for (const line of lines.slice(h4 + 1, end)) {
      const m = TODO_LINE_RE.exec(line);
      if (m) {
        cur = { turn: Number(m[3]), files: new Set() };
        tasks.push(cur);
        continue;
      }
      const f = FILES_LINE_RE.exec(line);
      if (f && cur) {
        const val = f[1].trim();
        if (!NO_FILES_MARKERS.has(val)) {
          for (const p of val.split(",")) {
            const t = p.trim();
            if (t) cur.files.add(t);
          }
        }
      }
    }
    /** @type {Map<number, Map<string, number>>} */
    const ownersByTurn = new Map();
    for (const t of tasks) {
      if (!ownersByTurn.has(t.turn)) ownersByTurn.set(t.turn, new Map());
      const owners = ownersByTurn.get(t.turn);
      for (const file of t.files) owners.set(file, (owners.get(file) ?? 0) + 1);
    }
    for (const [turn, owners] of ownersByTurn) {
      for (const [file, n] of owners) {
        if (n > 1) errors.push(`DUPLICATE_FILE_IN_TURN: Turn ${turn} -> ${file}`);
      }
    }
  }
  return errors.length ? bad(errors) : okResult();
}

/**
 * Structural check for `.asd/interview.md`: non-empty and containing at least
 * one question section heading (## / ### with "질문" or "Question", a "Q<n>"
 * heading, or a numbered question line).
 * @param {unknown} md
 * @returns {ValidationResult}
 */
export function validateInterviewMarkdown(md) {
  if (!isStr(md) || md.trim().length === 0) {
    return bad(["interview markdown must be a non-empty string"]);
  }
  const hasQuestion = md
    .split(/\r?\n/)
    .some(
      (l) =>
        QUESTION_HEADING_RE.test(l) ||
        Q_LABEL_HEADING_RE.test(l) ||
        NUMBERED_QUESTION_RE.test(l),
    );
  if (!hasQuestion) {
    return bad([
      "interview markdown must contain at least one question section heading (질문/Question) or numbered question",
    ]);
  }
  return okResult();
}
