// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PRESETS,
  PROFILES,
  resolveModelPreset,
  resolveInitialTier,
  resolveNextEscalation,
  inspectSubagentCall,
} from "../scripts/lib/routing.mjs";

test("preset catalog: 6 categories and 4 difficulties, each with all 4 harness specs", () => {
  assert.deepEqual(Object.keys(PRESETS.categories).sort(), [
    "external-research",
    "frontend-ui",
    "multimodal",
    "repo-explore",
    "verification",
    "writing",
  ]);
  assert.deepEqual(Object.keys(PRESETS.difficulties), [
    "reasoning-none",
    "reasoning-low",
    "reasoning-medium",
    "reasoning-deep",
  ]);
  const all = [...Object.values(PRESETS.categories), ...Object.values(PRESETS.difficulties)];
  for (const preset of all) {
    assert.ok(preset.defaultRole, "defaultRole present");
    for (const h of ["antigravity", "opencode", "claude-code", "codex"]) {
      assert.ok(preset[h], `${h} spec present`);
    }
  }
});

test("PROFILES: exact per-plan budget tables", () => {
  assert.deepEqual(PROFILES.eco, {
    scout: "flash_lite",
    "worker-light": "flash_lite",
    worker: "flash_lite",
    debugger: "flash",
    verifier: "flash_lite",
    heavyAllowed: false,
    proCap: 0,
    maxEscalationTier: "flash",
  });
  assert.deepEqual(PROFILES.balanced, {
    scout: "flash_lite",
    "worker-light": "flash_lite",
    worker: "flash",
    debugger: "flash",
    verifier: "flash_lite",
    heavyAllowed: true,
    proCap: 2,
    maxEscalationTier: "pro",
  });
  assert.deepEqual(PROFILES.performance, {
    scout: "flash",
    "worker-light": "flash_lite",
    worker: "flash",
    debugger: "flash",
    verifier: "flash",
    heavyAllowed: true,
    proCap: 6,
    maxEscalationTier: "pro",
  });
});

test("stage 1: category presets match first", () => {
  const mm = resolveModelPreset({ category: "multimodal" });
  assert.equal(mm.matchedBy, "category");
  assert.equal(mm.presetKey, "multimodal");
  assert.equal(mm.tier, "flash");
  assert.equal(mm.agent, "multimodal-looker");
  assert.equal(mm.role, "worker");
  assert.equal(mm.mcpHint, null);

  const writing = resolveModelPreset({ category: "writing" });
  assert.equal(writing.matchedBy, "category");
  assert.equal(writing.tier, "flash");
  assert.equal(writing.agent, "asd-worker");
  assert.equal(writing.role, "worker");

  const repo = resolveModelPreset({ category: "repo-explore" });
  assert.equal(repo.matchedBy, "category");
  assert.equal(repo.tier, "flash_lite");
  assert.equal(repo.agent, "asd-scout");
  assert.equal(repo.role, "scout");

  const ext = resolveModelPreset({ category: "external-research" });
  assert.equal(ext.matchedBy, "category");
  assert.deepEqual(ext.mcpHint, ["context7", "grep_app", "websearch"]);
  assert.equal(ext.tier, "flash_lite");

  const fe = resolveModelPreset({ category: "frontend-ui" });
  assert.equal(fe.tier, "flash");
  assert.equal(fe.role, "worker");

  const ver = resolveModelPreset({ category: "verification" });
  assert.equal(ver.role, "verifier");
  assert.deepEqual(ver.mcpHint, ["asd"]);
  assert.equal(ver.tier, "flash_lite");
});

test("stage 2: general category falls back to each difficulty preset", () => {
  const none = resolveModelPreset({ category: "general", difficulty: "reasoning-none" });
  assert.equal(none.matchedBy, "difficulty");
  assert.equal(none.presetKey, "reasoning-none");
  assert.equal(none.tier, "flash_lite");
  assert.equal(none.role, "worker-light");

  const low = resolveModelPreset({ category: "general", difficulty: "reasoning-low" });
  assert.equal(low.matchedBy, "difficulty");
  assert.equal(low.presetKey, "reasoning-low");
  assert.equal(low.tier, "flash");
  assert.equal(low.role, "worker");

  const med = resolveModelPreset({ category: "general", difficulty: "reasoning-medium" });
  assert.equal(med.presetKey, "reasoning-medium");
  assert.equal(med.tier, "flash");
  assert.equal(med.role, "debugger");
  assert.equal(med.harnessSpec.performanceTier, "pro");

  const deep = resolveModelPreset({ category: "general", difficulty: "reasoning-deep" });
  assert.equal(deep.presetKey, "reasoning-deep");
  assert.equal(deep.tier, "pro");
  assert.equal(deep.role, "debugger");
  assert.equal(deep.warning, null);
});

test("cross-harness: opencode, claude-code, codex specs returned per harness", () => {
  assert.deepEqual(resolveModelPreset({ category: "multimodal", harness: "opencode" }).harnessSpec, {
    category: "visual-engineering",
    reasoningEffort: "low",
  });
  assert.deepEqual(
    resolveModelPreset({ difficulty: "reasoning-deep", harness: "claude-code" }).harnessSpec,
    { model: "opus", thinkingBudget: 24576 },
  );
  assert.deepEqual(resolveModelPreset({ category: "repo-explore", harness: "codex" }).harnessSpec, {
    model: "codex-mini",
    reasoningEffort: "low",
  });
  assert.deepEqual(
    resolveModelPreset({ difficulty: "reasoning-none", harness: "opencode" }).harnessSpec,
    { reasoningEffort: "none", thinkingBudget: 0 },
  );
  // Unknown harness falls back to the antigravity spec.
  const bogus = resolveModelPreset({ difficulty: "reasoning-low", harness: "bogus" });
  assert.deepEqual(bogus.harnessSpec, PRESETS.difficulties["reasoning-low"].antigravity);
});

test("proCap: pro blocked in eco and when proUsed >= cap", () => {
  const ecoDeep = resolveModelPreset({ difficulty: "reasoning-deep", profile: "eco" });
  assert.equal(ecoDeep.tier, "flash");
  assert.ok(ecoDeep.warning);

  const balExhausted = resolveModelPreset({
    difficulty: "reasoning-deep",
    profile: "balanced",
    proUsed: 2,
  });
  assert.equal(balExhausted.tier, "flash");
  assert.ok(balExhausted.warning);

  const balOk = resolveModelPreset({ difficulty: "reasoning-deep", profile: "balanced", proUsed: 1 });
  assert.equal(balOk.tier, "pro");
  assert.equal(balOk.warning, null);

  const perfOk = resolveModelPreset({
    difficulty: "reasoning-deep",
    profile: "performance",
    proUsed: 5,
  });
  assert.equal(perfOk.tier, "pro");
  const perfExhausted = resolveModelPreset({
    difficulty: "reasoning-deep",
    profile: "performance",
    proUsed: 6,
  });
  assert.equal(perfExhausted.tier, "flash");
  assert.ok(perfExhausted.warning);
});

test("resolveInitialTier: requested pro allowed only within budget", () => {
  assert.equal(resolveInitialTier({ requestedTier: "pro", profile: "balanced", proUsed: 0 }).tier, "pro");

  const eco = resolveInitialTier({ requestedTier: "pro", profile: "eco", proUsed: 0 });
  assert.equal(eco.tier, "flash");
  assert.ok(eco.warning);

  const overCap = resolveInitialTier({ requestedTier: "pro", profile: "balanced", proUsed: 2 });
  assert.equal(overCap.tier, "flash");
  assert.ok(overCap.warning);

  // reasoning-deep earns pro without an explicit request (balanced, budget free).
  assert.equal(resolveInitialTier({ difficulty: "reasoning-deep", profile: "balanced", proUsed: 0 }).tier, "pro");
  // reasoning-low alone never implicitly earns pro.
  assert.equal(resolveInitialTier({ difficulty: "reasoning-low", profile: "balanced" }).tier, "flash");
});

test("resolveInitialTier: role-based profile defaults", () => {
  assert.equal(resolveInitialTier({ role: "scout", profile: "performance" }).tier, "flash");
  assert.equal(resolveInitialTier({ role: "verifier", profile: "eco" }).tier, "flash_lite");
  assert.equal(resolveInitialTier({ role: "worker", profile: "eco" }).tier, "flash_lite");
  assert.equal(resolveInitialTier({ role: "worker", profile: "balanced" }).tier, "flash");
  assert.equal(resolveInitialTier({ role: "worker-light", profile: "performance" }).tier, "flash_lite");
  // Bare defaults: general category + reasoning-low -> flash.
  assert.equal(resolveInitialTier({}).tier, "flash");
});

test("escalation ladder: flash_lite -> flash -> pro -> orchestrator -> blocked", () => {
  const up = resolveNextEscalation({ currentTier: "flash_lite", attempts: 1, profile: "balanced", proUsed: 0 });
  assert.equal(up.action, "escalate");
  assert.equal(up.nextTier, "flash");

  const toPro = resolveNextEscalation({ currentTier: "flash", attempts: 1, profile: "balanced", proUsed: 0 });
  assert.equal(toPro.action, "escalate");
  assert.equal(toPro.nextTier, "pro");

  const toOrch = resolveNextEscalation({ currentTier: "pro", attempts: 2, profile: "balanced", proUsed: 1 });
  assert.equal(toOrch.action, "escalate");
  assert.equal(toOrch.nextTier, "orchestrator");

  const blocked = resolveNextEscalation({ currentTier: "orchestrator", attempts: 3, profile: "balanced", proUsed: 2 });
  assert.equal(blocked.action, "blocked");
  assert.equal(blocked.nextTier, null);
});

test("escalation: pro unavailable retries flash, then escalates to orchestrator", () => {
  const ecoRetry = resolveNextEscalation({
    currentTier: "flash",
    attempts: 1,
    maxAttempts: 2,
    profile: "eco",
    proUsed: 0,
  });
  assert.equal(ecoRetry.action, "retry");
  assert.equal(ecoRetry.nextTier, "flash");
  assert.ok(/diagnostic context/.test(ecoRetry.reason));

  const ecoOrch = resolveNextEscalation({
    currentTier: "flash",
    attempts: 2,
    maxAttempts: 2,
    profile: "eco",
    proUsed: 0,
  });
  assert.equal(ecoOrch.action, "escalate");
  assert.equal(ecoOrch.nextTier, "orchestrator");

  const overCap = resolveNextEscalation({
    currentTier: "flash",
    attempts: 1,
    maxAttempts: 2,
    profile: "balanced",
    proUsed: 2,
  });
  assert.equal(overCap.action, "retry");
  assert.equal(overCap.nextTier, "flash");
});

test("inspectSubagentCall: missing Model -> rewrite_or_deny with resolved tier", () => {
  const r = inspectSubagentCall({
    toolArgs: { Prompt: "analyze images [ASD_CATEGORY: multimodal]" },
    state: { profile: "balanced", counters: { pro: 0 } },
  });
  assert.equal(r.action, "rewrite_or_deny");
  assert.equal(r.targetModel, "flash");
  assert.equal(r.tags.category, "multimodal");
  assert.ok(r.reason);
});

test("inspectSubagentCall: Model 'inherit' -> rewrite_or_deny", () => {
  const r = inspectSubagentCall({
    toolArgs: { Model: "inherit", Prompt: "do work" },
    state: { profile: "balanced", counters: { pro: 0 } },
  });
  assert.equal(r.action, "rewrite_or_deny");
  assert.equal(r.targetModel, "flash");
  assert.ok(/inherit/.test(r.reason ?? ""));
});

test("inspectSubagentCall: pro denied in eco and over cap, allowed within budget", () => {
  const eco = inspectSubagentCall({
    toolArgs: { Model: "pro", Prompt: "x" },
    state: { profile: "eco", counters: { pro: 0 } },
  });
  assert.equal(eco.action, "deny");
  assert.equal(eco.targetModel, "flash");

  const over = inspectSubagentCall({
    toolArgs: { Model: "pro", Prompt: "x" },
    state: { profile: "balanced", counters: { pro: 2 } },
  });
  assert.equal(over.action, "deny");
  assert.equal(over.targetModel, "flash");

  const ok = inspectSubagentCall({
    toolArgs: { Model: "pro", Prompt: "x" },
    state: { profile: "balanced", counters: { pro: 1 } },
  });
  assert.equal(ok.action, "allow");
  assert.equal(ok.targetModel, "pro");
});

test("inspectSubagentCall: tag extraction from Prompt and Role", () => {
  const r = inspectSubagentCall({
    toolArgs: {
      Model: "flash",
      Prompt: "[ASD_TASK: T2.3] research this [ASD_CATEGORY: external-research]",
      Role: "[ASD_ROLE: scout] [ASD_DIFFICULTY: reasoning-low]",
    },
    state: { profile: "balanced", counters: { pro: 0 } },
  });
  assert.deepEqual(r.tags, {
    role: "scout",
    category: "external-research",
    difficulty: "reasoning-low",
    task: "T2.3",
  });
  assert.equal(r.action, "allow");
});

test("inspectSubagentCall: missing state and missing fields fall back safely", () => {
  const r = inspectSubagentCall({ toolArgs: {}, state: undefined });
  assert.equal(r.action, "rewrite_or_deny");
  assert.equal(r.targetModel, "flash");

  const noArgs = inspectSubagentCall({});
  assert.equal(noArgs.action, "rewrite_or_deny");
  assert.equal(noArgs.targetModel, "flash");
});

test("malformed inputs: unknown category/difficulty/harness/profile fall back safely", () => {
  const r = resolveModelPreset({
    category: "bogus",
    difficulty: "bogus",
    harness: "bogus",
    profile: "bogus",
  });
  assert.equal(r.matchedBy, "difficulty");
  assert.equal(r.presetKey, "reasoning-low");
  assert.equal(r.tier, "flash");
  assert.deepEqual(r.harnessSpec, PRESETS.difficulties["reasoning-low"].antigravity);

  const dflt = resolveModelPreset();
  assert.equal(dflt.matchedBy, "difficulty");
  assert.equal(dflt.presetKey, "reasoning-low");
  assert.equal(dflt.tier, "flash");
});

test("hard rule: no branch permits pro in eco", () => {
  assert.equal(resolveModelPreset({ difficulty: "reasoning-deep", profile: "eco", proUsed: 0 }).tier, "flash");
  assert.equal(resolveInitialTier({ requestedTier: "pro", profile: "eco", proUsed: 0 }).tier, "flash");
  assert.equal(resolveInitialTier({ difficulty: "reasoning-deep", profile: "eco", proUsed: 0 }).tier, "flash");
  const esc = resolveNextEscalation({ currentTier: "flash", attempts: 1, maxAttempts: 5, profile: "eco", proUsed: 0 });
  assert.notEqual(esc.nextTier, "pro");
  assert.equal(
    inspectSubagentCall({ toolArgs: { Model: "pro" }, state: { profile: "eco", counters: { pro: 0 } } }).action,
    "deny",
  );
});
