// @ts-check
/**
 * 2-stage cross-harness model preset router, budget profiles, and X2 escalation
 * engine for the ASD (Agent Swarm Director) plugin.
 *
 * Stage 1 matches a task-content category preset (when `category` is known and
 * not "general"); Stage 2 falls back to a reasoning-difficulty preset. The
 * active budget profile (eco|balanced|performance) enforces the pro-tier cap.
 * Pure ESM, zero dependencies beyond node: built-ins and ./constants.mjs.
 */

import { readFileSync } from "node:fs";
import { BUDGET_PROFILES } from "./constants.mjs";

/** Logical model tier: "flash_lite" | "flash" | "pro" | "orchestrator". @typedef {string} Tier */

/** Per-harness spec object from config/model-presets.json. @typedef {Record<string, any>} HarnessSpec */

/** A preset entry from config/model-presets.json. @typedef {Record<string, any>} Preset */

/** ASD routing tags extracted from a subagent Prompt/Role string. @typedef {{ role: string | null, category: string | null, difficulty: string | null, task: string | null }} AsdTags */

/** Result of resolveModelPreset / resolveInitialTier. @typedef {{ matchedBy: string, presetKey: string, harnessSpec: HarnessSpec, tier: string, agent: string, role: string, mcpHint: string[] | null, warning: string | null }} RoutingResult */

/** Default difficulty preset when the requested one is unknown or omitted. */
const DEFAULT_DIFFICULTY = "reasoning-low";

/**
 * The portable cross-harness preset catalog, loaded from config/model-presets.json
 * relative to THIS module (never process.cwd()).
 * @type {{ categories: Record<string, Preset>, difficulties: Record<string, Preset> }}
 */
export const PRESETS = JSON.parse(
  readFileSync(new URL("../../config/model-presets.json", import.meta.url), "utf8"),
);

/**
 * Budget profile table: per-role tier floors, heavy-model permission, pro cap,
 * and the highest tier the X2 escalation ladder may reach.
 * @type {Record<string, { scout: string, "worker-light": string, worker: string, debugger: string, verifier: string, heavyAllowed: boolean, proCap: number, maxEscalationTier: string }>}
 */
export const PROFILES = Object.freeze({
  eco: Object.freeze({
    scout: "flash_lite",
    "worker-light": "flash_lite",
    worker: "flash_lite",
    debugger: "flash",
    verifier: "flash_lite",
    heavyAllowed: false,
    proCap: 0,
    maxEscalationTier: "flash",
  }),
  balanced: Object.freeze({
    scout: "flash_lite",
    "worker-light": "flash_lite",
    worker: "flash",
    debugger: "flash",
    verifier: "flash_lite",
    heavyAllowed: true,
    proCap: 2,
    maxEscalationTier: "pro",
  }),
  performance: Object.freeze({
    scout: "flash",
    "worker-light": "flash_lite",
    worker: "flash",
    debugger: "flash",
    verifier: "flash",
    heavyAllowed: true,
    proCap: 6,
    maxEscalationTier: "pro",
  }),
});

/**
 * Returns `value` when it is a member of `allowed`, else `fallback`.
 * @param {unknown} value
 * @param {readonly string[]} allowed
 * @param {string} fallback
 * @returns {string}
 */
function pickEnum(value, allowed, fallback) {
  return allowed.some((x) => x === value) ? String(value) : fallback;
}

/**
 * Coerces an unknown counter to a finite non-negative-ish number (defaults 0).
 * @param {unknown} value
 * @returns {number}
 */
function toCount(value) {
  return Number.isFinite(value) ? Number(value) : 0;
}

/**
 * Resolve the 2-stage cross-harness model preset for a subagent task.
 *
 * Stage 1 (task content): a known `category` other than "general" selects that
 * category preset. Stage 2 (difficulty fallback): otherwise the `difficulty`
 * preset is selected (unknown difficulty defaults to "reasoning-low"). The
 * active budget profile's proCap guard then downgrades a "pro" antigravity
 * tier to "flash" when the profile is "eco" or the pro budget is exhausted.
 *
 * @param {{ category?: string, difficulty?: string, harness?: string, profile?: string, proUsed?: number }} [opts]
 * @returns {RoutingResult}
 */
export function resolveModelPreset(opts = {}) {
  const category = opts.category ?? "general";
  const difficulty = opts.difficulty ?? DEFAULT_DIFFICULTY;
  const harness = opts.harness ?? "antigravity";
  const profile = pickEnum(opts.profile, BUDGET_PROFILES, "balanced");
  const proUsed = toCount(opts.proUsed);
  const prof = PROFILES[profile];

  /** @type {Preset} */ let preset;
  /** @type {string} */ let presetKey;
  /** @type {string} */ let matchedBy;
  if (category !== "general" && PRESETS.categories[category]) {
    preset = PRESETS.categories[category];
    presetKey = category;
    matchedBy = "category";
  } else {
    presetKey = PRESETS.difficulties[difficulty] ? difficulty : DEFAULT_DIFFICULTY;
    preset = PRESETS.difficulties[presetKey];
    matchedBy = "difficulty";
  }

  const harnessSpec = /** @type {HarnessSpec} */ (preset[harness] ?? preset.antigravity);
  /** @type {string} */ let tier = String(preset.antigravity.tier);
  /** @type {string | null} */ let warning = null;
  if (tier === "pro" && (profile === "eco" || proUsed >= prof.proCap)) {
    tier = "flash";
    warning = `pro tier downgraded to flash: profile "${profile}" proCap ${prof.proCap}, proUsed ${proUsed}`;
  }

  return {
    matchedBy,
    presetKey,
    harnessSpec,
    tier,
    agent: String(preset.antigravity.agent),
    role: String(preset.defaultRole),
    mcpHint: Array.isArray(preset.mcpHint) ? preset.mcpHint : null,
    warning,
  };
}

/**
 * Resolve the initial tier for a subagent launch, layering explicit
 * requestedTier / role-based profile defaults over the 2-stage preset and
 * enforcing the pro budget.
 *
 * `pro` is allowed ONLY when (requestedTier === "pro" OR difficulty ===
 * "reasoning-deep") AND profile !== "eco" AND proUsed < proCap; otherwise it is
 * downgraded to "flash" with a warning reason. `flag` (phase flag) is accepted
 * for pre-tool-guard signature compatibility and does not override resolution.
 *
 * @param {{ flag?: string, role?: string, category?: string, difficulty?: string, requestedTier?: string, profile?: string, proUsed?: number }} [opts]
 * @returns {RoutingResult}
 */
export function resolveInitialTier(opts = {}) {
  const profile = pickEnum(opts.profile, BUDGET_PROFILES, "balanced");
  const prof = PROFILES[profile];
  const proUsed = toCount(opts.proUsed);
  const difficulty = opts.difficulty ?? DEFAULT_DIFFICULTY;
  const preset = resolveModelPreset({
    category: opts.category,
    difficulty,
    harness: "antigravity",
    profile,
    proUsed,
  });

  /** @type {string} */ let tier;
  const roleTier = typeof opts.role === "string" ? prof[opts.role] : undefined;
  if (typeof opts.requestedTier === "string" && opts.requestedTier !== "") {
    tier = opts.requestedTier;
  } else if (typeof roleTier === "string") {
    tier = roleTier;
  } else {
    tier = preset.tier;
  }

  /** @type {string | null} */ let warning = preset.warning;
  if (tier === "pro") {
    const proAllowed =
      (opts.requestedTier === "pro" || difficulty === "reasoning-deep") &&
      profile !== "eco" &&
      proUsed < prof.proCap;
    if (!proAllowed) {
      tier = "flash";
      warning = `pro denied: requires requestedTier "pro" or difficulty "reasoning-deep", profile != "eco", and proUsed ${proUsed} < proCap ${prof.proCap}; downgraded to flash`;
    }
  }

  return { ...preset, tier, warning };
}

/**
 * X2 escalation ladder: flash_lite -> flash -> pro -> orchestrator -> blocked.
 *
 * A failed flash_lite attempt escalates to flash. A failed flash attempt
 * escalates to pro when the profile permits it and the pro budget has room;
 * otherwise it retries flash with diagnostic context while attempts remain,
 * and finally escalates to orchestrator (blocked marker [!]).
 *
 * @param {{ currentTier?: string, attempts?: number, maxAttempts?: number, profile?: string, proUsed?: number }} [opts]
 * @returns {{ action: "escalate" | "retry" | "blocked", nextTier: string | null, reason: string }}
 */
export function resolveNextEscalation(opts = {}) {
  const currentTier = opts.currentTier ?? "flash_lite";
  const attempts = toCount(opts.attempts) || 1;
  const maxAttempts = toCount(opts.maxAttempts) || 2;
  const profile = pickEnum(opts.profile, BUDGET_PROFILES, "balanced");
  const proUsed = toCount(opts.proUsed);
  const prof = PROFILES[profile];
  const proAvailable = profile !== "eco" && proUsed < prof.proCap;

  if (currentTier === "flash_lite") {
    return {
      action: "escalate",
      nextTier: "flash",
      reason: "flash_lite attempt failed; escalating to flash (X2 ladder)",
    };
  }
  if (currentTier === "flash") {
    if (proAvailable) {
      return {
        action: "escalate",
        nextTier: "pro",
        reason: `flash attempt ${attempts} failed; escalating to pro (profile "${profile}", proUsed ${proUsed}/${prof.proCap})`,
      };
    }
    if (attempts < maxAttempts) {
      return {
        action: "retry",
        nextTier: "flash",
        reason: `flash attempt ${attempts} failed but pro unavailable (profile "${profile}", proUsed ${proUsed}/${prof.proCap}); retry flash with diagnostic context appended`,
      };
    }
    return {
      action: "escalate",
      nextTier: "orchestrator",
      reason: `flash exhausted (attempts ${attempts}/${maxAttempts}) and pro unavailable; escalate to orchestrator / mark blocked [!]`,
    };
  }
  if (currentTier === "pro") {
    return {
      action: "escalate",
      nextTier: "orchestrator",
      reason: "pro attempt failed; escalate to orchestrator / mark blocked [!]",
    };
  }
  if (currentTier === "orchestrator") {
    return {
      action: "blocked",
      nextTier: null,
      reason: "orchestrator attempt failed; task marked blocked [!]",
    };
  }
  return {
    action: "blocked",
    nextTier: null,
    reason: `unknown currentTier "${currentTier}"; cannot escalate`,
  };
}

/** @type {{ role: RegExp, category: RegExp, difficulty: RegExp, task: RegExp }} */
const TAG_PATTERNS = Object.freeze({
  role: /\[ASD_ROLE:\s*([^\]]+?)\s*\]/,
  category: /\[ASD_CATEGORY:\s*([^\]]+?)\s*\]/,
  difficulty: /\[ASD_DIFFICULTY:\s*([^\]]+?)\s*\]/,
  task: /\[ASD_TASK:\s*(T\d+\.\d+)\s*\]/,
});

/**
 * Extracts ASD routing tags from a Prompt/Role text blob.
 * @param {string} text
 * @returns {AsdTags}
 */
function extractTags(text) {
  const role = TAG_PATTERNS.role.exec(text);
  const category = TAG_PATTERNS.category.exec(text);
  const difficulty = TAG_PATTERNS.difficulty.exec(text);
  const task = TAG_PATTERNS.task.exec(text);
  return {
    role: role ? role[1] : null,
    category: category ? category[1] : null,
    difficulty: difficulty ? difficulty[1] : null,
    task: task ? task[1] : null,
  };
}

/**
 * Inspect an invoke_subagent call for the pre-tool guard: extract ASD routing
 * tags from Prompt/Role, rewrite-or-deny a missing or "inherit" Model, and deny
 * a "pro" Model when the profile is eco or the pro budget is exhausted.
 *
 * `state.profile` / `state.counters.pro` are read defensively (missing values
 * fall back to "balanced" / 0).
 *
 * @param {{ toolArgs?: Record<string, unknown>, state?: { profile?: unknown, counters?: { pro?: unknown } } }} [opts]
 * @returns {{ action: "allow" | "rewrite_or_deny" | "deny", targetModel: string | null, reason: string | null, tags: AsdTags, resolved?: RoutingResult }}
 */
export function inspectSubagentCall(opts = {}) {
  const args = opts.toolArgs ?? {};
  const prompt =
    typeof args.Prompt === "string" ? args.Prompt : typeof args.prompt === "string" ? args.prompt : "";
  const roleStr = typeof args.Role === "string" ? args.Role : typeof args.role === "string" ? args.role : "";
  const model =
    typeof args.Model === "string" && args.Model !== ""
      ? args.Model
      : typeof args.model === "string" && args.model !== ""
        ? args.model
        : null;

  const profile = pickEnum(opts.state?.profile, BUDGET_PROFILES, "balanced");
  const proUsed = toCount(opts.state?.counters?.pro);
  const prof = PROFILES[profile];
  const tags = extractTags(`${prompt}\n${roleStr}`);

  if (model === null || model === "inherit") {
    const resolved = resolveInitialTier({
      role: tags.role ?? undefined,
      category: tags.category ?? undefined,
      difficulty: tags.difficulty ?? undefined,
      profile,
      proUsed,
    });
    return {
      action: "rewrite_or_deny",
      targetModel: resolved.tier,
      reason:
        model === null
          ? "Model missing on invoke_subagent; rewrite to the resolved tier"
          : 'Model "inherit" is not a concrete subagent model; rewrite to the resolved tier',
      tags,
      resolved,
    };
  }
  if (model === "pro" && (profile === "eco" || proUsed >= prof.proCap)) {
    return {
      action: "deny",
      targetModel: "flash",
      reason: `pro model denied: profile "${profile}" proCap ${prof.proCap}, proUsed ${proUsed}; fallback to flash`,
      tags,
    };
  }
  return { action: "allow", targetModel: model, reason: null, tags };
}
