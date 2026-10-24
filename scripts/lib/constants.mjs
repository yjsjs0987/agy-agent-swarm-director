// @ts-check
/**
 * Centralized naming constants for the ASD (Agent Swarm Director) plugin.
 *
 * This module is the dependency root: it must not import from any sibling
 * lib module. Every array export is Object.freeze'd so mutation throws a
 * TypeError at runtime.
 */

/** @type {string} */
export const PLUGIN_NAME = "asd";

/** @type {string} */
export const PROJECT_TITLE = "ASD (Agent Swarm Director)";

/** @type {string} */
export const ASD_DIR_NAME = ".asd";

/** @type {number} */
export const SCHEMA_VERSION = 1;

/** @type {readonly string[]} */
export const SUPPORTED_LOCALES = Object.freeze(["ko", "en"]);

/** @type {string} */
export const DEFAULT_LOCALE = "ko";

/** @type {readonly string[]} */
export const PHASE_FLAGS = Object.freeze([
  "SCAN",
  "PLAN",
  "BUILD",
  "TEST",
  "DEBUG",
  "VERIFY",
  "FIX",
]);

/** @type {readonly string[]} */
export const TASK_STATUSES = Object.freeze([" ", ">", "x", "!", "~"]);

/** @type {readonly string[]} */
export const MODEL_TIERS = Object.freeze([
  "flash_lite",
  "flash",
  "pro",
  "orchestrator",
]);

/** @type {readonly string[]} */
export const BUDGET_PROFILES = Object.freeze([
  "eco",
  "balanced",
  "performance",
]);

/** @type {readonly string[]} */
export const TASK_CATEGORIES = Object.freeze([
  "repo-explore",
  "external-research",
  "multimodal",
  "writing",
  "frontend-ui",
  "verification",
  "general",
]);

/** @type {readonly string[]} */
export const TASK_DIFFICULTIES = Object.freeze([
  "reasoning-none",
  "reasoning-low",
  "reasoning-medium",
  "reasoning-deep",
]);

/** @type {readonly string[]} */
export const SUPPORTED_HARNESSES = Object.freeze([
  "antigravity",
  "opencode",
  "claude-code",
  "codex",
]);

/** @type {number} */
export const MAX_CONCURRENT_DEFAULT = 8;

/** @type {number} */
export const STALE_SESSION_MS = 30 * 60 * 1000;
