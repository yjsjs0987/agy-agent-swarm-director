// @ts-check
import { strict as assert } from "node:assert";
import { test } from "node:test";
import fs from "node:fs";
import * as constants from "../scripts/lib/constants.mjs";

const ARRAY_EXPORTS = [
  "SUPPORTED_LOCALES",
  "PHASE_FLAGS",
  "TASK_STATUSES",
  "MODEL_TIERS",
  "BUDGET_PROFILES",
  "TASK_CATEGORIES",
  "TASK_DIFFICULTIES",
  "SUPPORTED_HARNESSES",
];

test("constants export exact values", (t) => {
  assert.strictEqual(constants.PLUGIN_NAME, "asd");
  assert.strictEqual(
    constants.PROJECT_TITLE,
    "ASD (Agent Swarm Director)",
  );
  assert.strictEqual(constants.ASD_DIR_NAME, ".asd");
  assert.strictEqual(constants.SCHEMA_VERSION, 1);
  assert.strictEqual(constants.DEFAULT_LOCALE, "ko");
  assert.strictEqual(constants.MAX_CONCURRENT_DEFAULT, 8);
  assert.strictEqual(constants.STALE_SESSION_MS, 30 * 60 * 1000);
  assert.deepStrictEqual(constants.SUPPORTED_LOCALES, ["ko", "en"]);
  assert.deepStrictEqual(constants.PHASE_FLAGS, [
    "SCAN",
    "PLAN",
    "BUILD",
    "TEST",
    "DEBUG",
    "VERIFY",
    "FIX",
  ]);
  assert.deepStrictEqual(constants.TASK_STATUSES, [" ", ">", "x", "!", "~"]);
  assert.deepStrictEqual(constants.MODEL_TIERS, [
    "flash_lite",
    "flash",
    "pro",
    "orchestrator",
  ]);
  assert.deepStrictEqual(constants.BUDGET_PROFILES, [
    "eco",
    "balanced",
    "performance",
  ]);
  assert.deepStrictEqual(constants.TASK_CATEGORIES, [
    "repo-explore",
    "external-research",
    "multimodal",
    "writing",
    "frontend-ui",
    "verification",
    "general",
  ]);
  assert.deepStrictEqual(constants.TASK_DIFFICULTIES, [
    "reasoning-none",
    "reasoning-low",
    "reasoning-medium",
    "reasoning-deep",
  ]);
  assert.deepStrictEqual(constants.SUPPORTED_HARNESSES, [
    "antigravity",
    "opencode",
    "claude-code",
    "codex",
  ]);
});

test("every array export is frozen", (t) => {
  for (const name of ARRAY_EXPORTS) {
    assert.ok(Object.isFrozen(constants[name]), `${name} is frozen`);
  }
});

test("mutation of frozen array throws TypeError", () => {
  assert.throws(() => constants.PHASE_FLAGS.push("HACK"), TypeError);
});

test("jsconfig.json has checkJs and strict", () => {
  const jsconfig = JSON.parse(
    fs.readFileSync(new URL("../jsconfig.json", import.meta.url), "utf8"),
  );
  assert.strictEqual(jsconfig.compilerOptions.checkJs, true);
  assert.strictEqual(jsconfig.compilerOptions.strict, true);
});

test("package.json has no dependencies or devDependencies", () => {
  const pkg = JSON.parse(
    fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  );
  assert.ok(!("dependencies" in pkg));
  assert.ok(!("devDependencies" in pkg));
});
