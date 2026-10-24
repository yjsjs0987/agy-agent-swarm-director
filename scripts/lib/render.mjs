// @ts-check
// allow: SIZE_OK — the plan mandates a single canonical render module (scripts/lib/render.mjs);
// splitting would create files outside the approved deliverable set.
/**
 * Deterministic markdown renderers and parsers for every `.asd/` artifact.
 *
 * Contract:
 * - Pure string processing: no filesystem, no clock, no randomness.
 * - Renderers never throw on malformed input; unknown shapes coerce to safe defaults.
 * - `parsePlanMarkdown` never throws: malformed/truncated input yields
 *   `{ ok: false, errors, ... }` with defaults for every missing field.
 * - No timestamps are emitted unless explicitly present in the input state
 *   (golden tests are byte-stable).
 */
import {
  PHASE_FLAGS,
  TASK_STATUSES,
  MODEL_TIERS,
  DEFAULT_LOCALE,
  SUPPORTED_LOCALES,
} from "./constants.mjs";
import {
  PLAN_HEADINGS,
  validateTodoLine,
  validatePlanMarkdown,
} from "./schema.mjs";

/**
 * @typedef {{ includeTests: boolean, includeDebug: boolean, gitCheckpoint: boolean, learnings: boolean, profile: string, locale: string }} PlanOptions
 * @typedef {{ turn: number, title: string }} PlanTurn
 * @typedef {{ id: string, turn: number, task: number, flag: string, summary: string, tier: string, status: string, files: string[], category: string, difficulty: string }} PlanTask
 * @typedef {{ ok: boolean, errors: string[], options: PlanOptions, turns: PlanTurn[], tasks: PlanTask[] }} ParsedPlan
 */

/* ---------------- safe coercion helpers (renderers never throw) ---------------- */

/** @param {unknown} v @param {string} [d] @returns {string} */
const str = (v, d = "") => (typeof v === "string" ? v : d);
/** @param {unknown} v @param {number} [d] @returns {number} */
const num = (v, d = 0) => (typeof v === "number" && Number.isFinite(v) ? v : d);
/** @param {unknown} v @param {boolean} [d] @returns {boolean} */
const bool = (v, d = false) => (typeof v === "boolean" ? v : d);
/** @param {unknown} v @returns {unknown[]} */
const arr = (v) => (Array.isArray(v) ? v : []);
/** @param {unknown} v @returns {Record<string, unknown>} */
const obj = (v) =>
  typeof v === "object" && v !== null && !Array.isArray(v)
    ? /** @type {Record<string, unknown>} */ (v)
    : {};
/** @param {unknown} v @returns {string[]} */
const strArr = (v) =>
  Array.isArray(v)
    ? v.filter((x) => typeof x === "string" && x.length > 0)
    : [];
/** @param {unknown} v @returns {string} */
const localeOf = (v) =>
  SUPPORTED_LOCALES.some((l) => l === v) ? /** @type {string} */ (v) : DEFAULT_LOCALE;

/* ---------------- localized legend tables ---------------- */

/** @type {Record<string, string>} */
const FLAG_DESC_KO = {
  SCAN: "스캔", PLAN: "계획", BUILD: "빌드", TEST: "테스트",
  DEBUG: "디버그", VERIFY: "검증", FIX: "수정",
};
/** @type {Record<string, string>} */
const FLAG_DESC_EN = {
  SCAN: "scan", PLAN: "plan", BUILD: "build", TEST: "test",
  DEBUG: "debug", VERIFY: "verify", FIX: "fix",
};
/** @type {Record<string, string>} */
const STATUS_DESC_KO = {
  " ": "대기", ">": "진행 중", "x": "완료", "!": "실패", "~": "건너뜀",
};
/** @type {Record<string, string>} */
const STATUS_DESC_EN = {
  " ": "pending", ">": "in progress", "x": "done", "!": "failed", "~": "skipped",
};

/* ---------------- shared TODO.md fragments ---------------- */

/** @param {Record<string, unknown>} o */
function todoHeaderBar(o) {
  const tasks = arr(o.tasks);
  const done = tasks.filter((t) => obj(t).status === "x").length;
  return `# ASD TODO — ${str(o.title, "Untitled")} [Phase: ${str(o.phase, "idle")} | Turn: T${num(o.currentTurn, 0)}/${arr(o.turns).length} | Profile: ${str(o.profile, "balanced")} | Done: ${done}/${tasks.length}]`;
}

/** @param {Record<string, unknown>} t */
function todoTaskLine(t) {
  return `- [${str(t.status, " ")}] [${str(t.flag, "BUILD")}] T${num(t.turn, 1)}.${num(t.task, 1)} ${str(t.summary, "task")} · ${str(t.tier, "flash")}`;
}

/** @param {unknown[]} turns @returns {Map<number, string>} */
function turnTitles(turns) {
  /** @type {Map<number, string>} */
  const map = new Map();
  for (const t of turns) {
    const o = obj(t);
    map.set(num(o.turn, 1), str(o.title, ""));
  }
  return map;
}

/** @param {unknown[]} tasks @returns {Map<number, Record<string, unknown>[]>} */
function groupTasksByTurn(tasks) {
  /** @type {Map<number, Record<string, unknown>[]>} */
  const map = new Map();
  for (const t of tasks) {
    const o = obj(t);
    const turn = num(o.turn, 1);
    let list = map.get(turn);
    if (!list) {
      list = [];
      map.set(turn, list);
    }
    list.push(o);
  }
  return map;
}

/** @param {Map<number, string>} titles @param {Map<number, Record<string, unknown>[]>} groups @returns {number[]} */
const sortedTurnNums = (titles, groups) =>
  [...new Set([...titles.keys(), ...groups.keys()])].sort((a, b) => a - b);

/** @param {string} locale @returns {string[]} */
function legendLines(locale) {
  const flags = locale === "en" ? FLAG_DESC_EN : FLAG_DESC_KO;
  const statuses = locale === "en" ? STATUS_DESC_EN : STATUS_DESC_KO;
  return [
    "---",
    "## Legend",
    `- Flags: ${PHASE_FLAGS.map((f) => `${f}=${flags[f]}`).join(" · ")}`,
    `- Status: ${TASK_STATUSES.map((s) => `[${s}] ${statuses[s]}`).join(" · ")}`,
  ];
}

/* ---------------- TODO.md ---------------- */

/**
 * Render the enforced `.asd/TODO.md` content (machine header, summary bar,
 * per-Turn grouped task lines, localized legend footer).
 * @param {unknown} state `.asd/state.json`-shaped:
 *   `{ title, phase, profile, currentTurn, options: { locale }, turns: [{ turn, title }], tasks: [{ turn, task, flag, status, summary, tier }] }`
 * @returns {string}
 */
export function renderTodoMarkdown(state) {
  const o = obj(state);
  const locale = localeOf(obj(o.options).locale);
  const titles = turnTitles(arr(o.turns));
  const groups = groupTasksByTurn(arr(o.tasks));
  const lines = [
    "<!-- ASD-GENERATED: DO NOT EDIT MANUALLY. Managed by scripts/asd.mjs -->",
    todoHeaderBar(o),
    "",
  ];
  for (const turn of sortedTurnNums(titles, groups)) {
    lines.push(`## Turn ${turn}: ${titles.get(turn) ?? ""}`);
    for (const t of groups.get(turn) ?? []) lines.push(todoTaskLine(t));
    lines.push("");
  }
  lines.push(...legendLines(locale));
  return lines.join("\n") + "\n";
}

/**
 * Render the clean markdown block the Orchestrator prints to the user at the
 * end of every Turn. Never emits timestamps (deterministic goldens).
 * @param {unknown} state Same shape as `renderTodoMarkdown`.
 * @returns {string}
 */
export function renderTodoConsoleBox(state) {
  const o = obj(state);
  const titles = turnTitles(arr(o.turns));
  const groups = groupTasksByTurn(arr(o.tasks));
  const lines = [todoHeaderBar(o), ""];
  for (const turn of sortedTurnNums(titles, groups)) {
    lines.push(`## Turn ${turn}: ${titles.get(turn) ?? ""}`);
    for (const t of groups.get(turn) ?? []) lines.push(todoTaskLine(t));
    lines.push("");
  }
  return lines.join("\n").trimEnd() + "\n";
}

/* ---------------- PLAN.md ---------------- */

/**
 * Render a strictly formatted `.asd/PLAN.md`: the 6 invariant English headings
 * (PLAN_HEADINGS), the X8 3-part frame, the mandatory Korean correction
 * callout in section 2, explicit option booleans in section 3, and the
 * section-4 Turn/task table (TODO-grammar line + `files:` CSV + `meta:` line
 * per task, per the schema contract).
 * @param {unknown} input `{ slug, title, projectState, understoodCommand, questions: string[], options: { includeTests, includeDebug, gitCheckpoint, learnings, profile }, turns: [{ turn, title }], tasks: [{ turn, task, flag, status?, summary, tier, files: string[], category, difficulty }], criteria: string[], amendments: string[], locale }`
 * @returns {string}
 */
export function renderPlanTemplate(input) {
  const o = obj(input);
  const locale = localeOf(
    o.locale !== undefined ? o.locale : obj(o.options).locale,
  );
  const opts = obj(o.options);
  const lines = [
    "<!-- ASD-PLAN-V1: managed by scripts/asd.mjs -->",
    `# ASD PLAN — ${str(o.title, "Untitled")} (${str(o.slug, "untitled")})`,
    "",
    PLAN_HEADINGS[0],
    str(o.projectState, "(none)"),
    "",
    PLAN_HEADINGS[1],
    str(o.understoodCommand, "(none)"),
    "",
    "> ⚠️ 위 이해 내용이 의도와 다르거나 누락된 부분이 있다면 지적해 주세요. 수정 후 진행합니다.",
  ];
  if (locale === "en") {
    lines.push(
      "> ⚠️ If anything above misstates your intent, point it out — the plan is corrected before execution.",
    );
  }
  lines.push(
    "",
    PLAN_HEADINGS[2],
    locale === "en" ? "### Questions" : "### 질문 (Questions)",
  );
  const questions = strArr(o.questions);
  if (questions.length === 0) lines.push("(none)");
  questions.forEach((q, i) => lines.push(`${i + 1}. ${q}`));
  lines.push(
    "",
    locale === "en" ? "### Options" : "### 옵션 (Options)",
    `- includeTests: ${bool(opts.includeTests, true)}`,
    `- includeDebug: ${bool(opts.includeDebug, false)}`,
    `- gitCheckpoint: ${bool(opts.gitCheckpoint, true)}`,
    `- learnings: ${bool(opts.learnings, true)}`,
    `- profile: ${str(opts.profile, "balanced")}`,
    `- locale: ${locale}`,
    "",
    PLAN_HEADINGS[3],
  );
  const titles = turnTitles(arr(o.turns));
  const groups = groupTasksByTurn(arr(o.tasks));
  for (const turn of sortedTurnNums(titles, groups)) {
    lines.push(`### Turn ${turn}: ${titles.get(turn) ?? ""}`);
    for (const t of groups.get(turn) ?? []) {
      lines.push(
        `- [${str(t.status, " ")}] [${str(t.flag, "BUILD")}] T${turn}.${num(t.task, 1)} ${str(t.summary, "task")} · ${str(t.tier, "flash")}`,
      );
      const files = strArr(t.files);
      lines.push(`  files: ${files.length > 0 ? files.join(", ") : "-"}`);
      lines.push(
        `  meta: category=${str(t.category, "general")} · difficulty=${str(t.difficulty, "reasoning-low")}`,
      );
    }
    lines.push("");
  }
  lines.push(PLAN_HEADINGS[4]);
  const criteria = strArr(o.criteria);
  if (criteria.length === 0) lines.push("(none)");
  for (const c of criteria) lines.push(`- ${c}`);
  lines.push("", PLAN_HEADINGS[5]);
  const amendments = strArr(o.amendments);
  if (amendments.length === 0) lines.push("(none)");
  for (const a of amendments) lines.push(`- ${a}`);
  return lines.join("\n") + "\n";
}

/* ---------------- PLAN.md parsing ---------------- */

/** `files:` values meaning "no files" (schema contract, schema.mjs keeps its own copy). */
const NO_FILES_MARKERS = new Set(["", "-", "none", "(none)"]);
const PLAN_TURN_RE = /^###\s+Turn\s+(\d+)\s*:\s*(.*)$/;
const PLAN_FILES_RE = /^\s*[-*]?\s*files:\s*(.*)$/;
const PLAN_META_RE =
  /^\s*[-*]?\s*meta:\s*category=([\w-]+)\s*·\s*difficulty=([\w-]+)\s*$/;
const PLAN_OPTION_RE =
  /^\s*[-*]\s+(includeTests|includeDebug|gitCheckpoint|learnings|profile|locale):\s*(.+?)\s*$/;

/** @returns {PlanOptions} */
function defaultPlanOptions() {
  return {
    includeTests: false,
    includeDebug: false,
    gitCheckpoint: false,
    learnings: false,
    profile: "balanced",
    locale: DEFAULT_LOCALE,
  };
}

/**
 * Parse `.asd/PLAN.md` sections 3 (options) and 4 (turns/tasks) into
 * structured objects for `asd.mjs plan-import`. Merges `validatePlanMarkdown`
 * errors (missing headings, correction notice, `DUPLICATE_FILE_IN_TURN`).
 * Never throws on any input.
 * @param {unknown} markdown
 * @returns {ParsedPlan}
 */
export function parsePlanMarkdown(markdown) {
  /** @type {ParsedPlan} */
  const result = {
    ok: false,
    errors: [],
    options: defaultPlanOptions(),
    turns: [],
    tasks: [],
  };
  if (typeof markdown !== "string" || markdown.trim().length === 0) {
    result.errors = ["plan markdown must be a non-empty string"];
    return result;
  }
  const structural = validatePlanMarkdown(markdown);
  result.errors.push(...structural.errors);

  const lines = markdown.split(/\r?\n/);
  const idx = PLAN_HEADINGS.map((h) => lines.findIndex((l) => l.trim() === h));

  if (idx[2] !== -1) {
    const end = idx[3] > idx[2] ? idx[3] : lines.length;
    for (const line of lines.slice(idx[2] + 1, end)) {
      const m = PLAN_OPTION_RE.exec(line);
      if (!m) continue;
      const key = m[1];
      const raw = m[2];
      if (
        key === "includeTests" || key === "includeDebug" ||
        key === "gitCheckpoint" || key === "learnings"
      ) {
        result.options[key] = raw === "true";
      } else if (key === "profile") {
        result.options.profile = raw;
      } else if (key === "locale") {
        result.options.locale = localeOf(raw);
      }
    }
  }

  if (idx[3] !== -1) {
    const end = idx[4] > idx[3] ? idx[4] : lines.length;
    /** @type {PlanTask | null} */
    let cur = null;
    for (const line of lines.slice(idx[3] + 1, end)) {
      const tm = PLAN_TURN_RE.exec(line);
      if (tm) {
        result.turns.push({ turn: Number(tm[1]), title: tm[2].trim() });
        cur = null;
        continue;
      }
      const tl = validateTodoLine(line);
      if (tl.ok) {
        cur = {
          id: `T${tl.parsed.turn}.${tl.parsed.task}`,
          turn: tl.parsed.turn,
          task: tl.parsed.task,
          flag: tl.parsed.flag,
          summary: tl.parsed.summary,
          tier: tl.parsed.tier,
          status: tl.parsed.status,
          files: [],
          category: "general",
          difficulty: "reasoning-low",
        };
        result.tasks.push(cur);
        continue;
      }
      const fm = PLAN_FILES_RE.exec(line);
      if (fm && cur) {
        const val = fm[1].trim();
        if (!NO_FILES_MARKERS.has(val)) {
          cur.files = val
            .split(",")
            .map((p) => p.trim())
            .filter((p) => p.length > 0);
        }
        continue;
      }
      const mm = PLAN_META_RE.exec(line);
      if (mm && cur) {
        cur.category = mm[1];
        cur.difficulty = mm[2];
      }
    }
  }

  result.ok = result.errors.length === 0;
  return result;
}

/* ---------------- interview.md / learnings.md / SUMMARY.md ---------------- */

/**
 * Render `.asd/interview.md`: one `## Q<n>.` section per question
 * (passes `validateInterviewMarkdown`).
 * @param {unknown} interviewState `{ title, questions: (string | { question: string, options?: string[] })[] }`
 * @returns {string}
 */
export function renderInterviewMarkdown(interviewState) {
  const o = obj(interviewState);
  const lines = [`# ASD Interview — ${str(o.title, "Interview")}`, ""];
  arr(o.questions).forEach((q, i) => {
    const text = typeof q === "string" ? q : str(obj(q).question, "(question)");
    lines.push(`## Q${i + 1}. ${text}`);
    if (typeof q !== "string") {
      strArr(obj(q).options).forEach((opt, j) => lines.push(`${j + 1}. ${opt}`));
    }
    lines.push("");
  });
  return lines.join("\n").trimEnd() + "\n";
}

/**
 * Render `.asd/learnings.md` entries under the `# ASD Project Learnings` header.
 * @param {unknown} entries `Array<{ date: string (ISO date), category: string, note: string }>`
 * @returns {string}
 */
export function renderLearningsMarkdown(entries) {
  const lines = ["# ASD Project Learnings", ""];
  for (const e of arr(entries)) {
    const o = obj(e);
    lines.push(
      `- [${str(o.date, "")}] [${str(o.category, "general")}] ${str(o.note, "")}`,
    );
  }
  return lines.join("\n").trimEnd() + "\n";
}

/**
 * Render `.asd/SUMMARY.md`: machine header `<!-- ASD-SUMMARY-V1 -->`,
 * Turn/Task completion overview table, Mermaid `flowchart LR` execution
 * diagram, modified/created files table with `+added/-deleted` counts,
 * verification pass/fail badges, subagent tier usage counts, and the final
 * work synthesis.
 * @param {unknown} state `.asd/state.json`-shaped (title, turns, tasks, counters).
 * @param {unknown} extras `{ finalNotes: string, diffStats: Array<{ file: string, added: number, deleted: number }> }`
 * @returns {string}
 */
export function renderSummaryMarkdown(state, extras) {
  const o = obj(state);
  const x = obj(extras);
  const titles = turnTitles(arr(o.turns));
  const groups = groupTasksByTurn(arr(o.tasks));
  const turnNums = sortedTurnNums(titles, groups);
  /** @type {Map<number, string>} */
  const turnStatus = new Map();
  for (const t of arr(o.turns)) {
    const to = obj(t);
    turnStatus.set(num(to.turn, 1), str(to.status, "pending"));
  }
  const lines = [
    "<!-- ASD-SUMMARY-V1 -->",
    `# ASD SUMMARY — ${str(o.title, "Untitled")}`,
    "",
    "## Turn & Task Completion Overview",
    "| Turn | Title | Status | Tasks (done/total) |",
    "|---|---|---|---|",
  ];
  for (const turn of turnNums) {
    const ts = groups.get(turn) ?? [];
    const done = ts.filter((t) => t.status === "x").length;
    lines.push(
      `| ${turn} | ${titles.get(turn) ?? ""} | ${turnStatus.get(turn) ?? "pending"} | ${done}/${ts.length} |`,
    );
  }
  lines.push("", "## Execution Flow", "```mermaid", "flowchart LR");
  for (const turn of turnNums) {
    lines.push(
      `  T${turn}["Turn ${turn} (${(groups.get(turn) ?? []).length} tasks)"]`,
    );
  }
  for (let i = 1; i < turnNums.length; i++) {
    lines.push(`  T${turnNums[i - 1]} --> T${turnNums[i]}`);
  }
  lines.push(
    "```",
    "",
    "## Modified & Created Files",
    "| File | +Added | -Deleted |",
    "|---|---|---|",
  );
  for (const d of arr(x.diffStats)) {
    const dd = obj(d);
    lines.push(
      `| ${str(dd.file, "(unknown)")} | +${num(dd.added, 0)} | -${num(dd.deleted, 0)} |`,
    );
  }
  lines.push("", "## Verification");
  const tasks = arr(o.tasks).map((t) => obj(t));
  const verifyTasks = tasks.filter((t) => t.flag === "VERIFY");
  if (verifyTasks.length === 0) lines.push("- (no verification tasks)");
  for (const t of verifyTasks) {
    lines.push(`- ${t.status === "x" ? "✅" : "❌"} ${str(t.id, "")} ${str(t.summary, "")}`);
  }
  const incomplete = tasks.filter((t) => t.status !== "x").length;
  lines.push(
    incomplete === 0
      ? "- ✅ All tasks complete"
      : `- ❌ ${incomplete} task(s) incomplete`,
  );
  lines.push("", "## Subagent Tier Usage");
  const counters = obj(o.counters);
  for (const tier of MODEL_TIERS) lines.push(`- ${tier}: ${num(counters[tier], 0)}`);
  lines.push("", "## Final Notes", str(x.finalNotes, "(none)"));
  return lines.join("\n") + "\n";
}
