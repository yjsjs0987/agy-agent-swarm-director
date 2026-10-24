// @ts-check
/**
 * Tests for scripts/lib/runtime-contract.mjs — the locked Antigravity runtime
 * contract (R1–R6). Matcher behavior is verified by explicit hits/misses,
 * not just module load.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  WRITE_TOOL_MATCHER,
  SUBAGENT_TOOL_MATCHER,
  NEUTRAL_PRE_TOOL_OUTPUT,
  MODEL_ENFORCEMENT_MODE,
  MCP_SERVER_ARGS_MODE,
  AGENTS_MD_DISCOVERY,
  SUBAGENT_CONVERSATION_ISOLATION,
  assertNoAllowDecision,
} from "../scripts/lib/runtime-contract.mjs";

test("module imports and exports every contract constant", () => {
  assert.ok(WRITE_TOOL_MATCHER instanceof RegExp);
  assert.ok(SUBAGENT_TOOL_MATCHER instanceof RegExp);
  assert.ok(NEUTRAL_PRE_TOOL_OUTPUT !== null && typeof NEUTRAL_PRE_TOOL_OUTPUT === "object");
  assert.equal(typeof assertNoAllowDecision, "function");
});

test("R1: WRITE_TOOL_MATCHER hits every locked file-write tool name", () => {
  for (const name of [
    "write_to_file",
    "replace_file_content",
    "multi_replace_file_content",
    "write_file",
    "edit_file",
  ]) {
    assert.equal(WRITE_TOOL_MATCHER.test(name), true, `expected hit: ${name}`);
  }
});

test("R1: WRITE_TOOL_MATCHER misses non-write tools, prefixes, and case variants", () => {
  for (const name of [
    "read_file",
    "view_file",
    "run_command",
    "grep_search",
    "find_by_name",
    "list_dir",
    "write_to_files", // suffix must not match (anchored)
    "my_write_to_file", // prefix must not match (anchored)
    "WRITE_TO_FILE", // tool names are lowercased by the runtime; case-sensitive
    "write to file",
    "",
  ]) {
    assert.equal(WRITE_TOOL_MATCHER.test(name), false, `expected miss: ${name}`);
  }
});

test("R1: SUBAGENT_TOOL_MATCHER hits every locked subagent tool name", () => {
  for (const name of ["invoke_subagent", "subagent", "launch_subagent"]) {
    assert.equal(SUBAGENT_TOOL_MATCHER.test(name), true, `expected hit: ${name}`);
  }
});

test("R1: SUBAGENT_TOOL_MATCHER misses non-subagent and unanchored variants", () => {
  for (const name of [
    "invoke_subagents",
    "subagents",
    "subagent_status",
    "list_subagents",
    "run_command",
    "invoke_subagent_extra",
    "",
  ]) {
    assert.equal(SUBAGENT_TOOL_MATCHER.test(name), false, `expected miss: ${name}`);
  }
});

test("R3: NEUTRAL_PRE_TOOL_OUTPUT deep-equals {} and is frozen", () => {
  assert.deepEqual(NEUTRAL_PRE_TOOL_OUTPUT, {});
  assert.equal(Object.isFrozen(NEUTRAL_PRE_TOOL_OUTPUT), true);
  assert.throws(() => {
    /** @type {Record<string, unknown>} */ (NEUTRAL_PRE_TOOL_OUTPUT).key = "x";
  }, TypeError);
});

test("R4: MODEL_ENFORCEMENT_MODE is one of the allowed modes", () => {
  assert.ok(
    MODEL_ENFORCEMENT_MODE === "overwrite" || MODEL_ENFORCEMENT_MODE === "deny",
    `unexpected mode: ${String(MODEL_ENFORCEMENT_MODE)}`,
  );
});

test("R6: MCP_SERVER_ARGS_MODE is one of the allowed modes", () => {
  assert.ok(
    MCP_SERVER_ARGS_MODE === "plugin_root" ||
      MCP_SERVER_ARGS_MODE === "workspace_root" ||
      MCP_SERVER_ARGS_MODE === "unresolved_safe_default",
    `unexpected mode: ${String(MCP_SERVER_ARGS_MODE)}`,
  );
});

test("R5: AGENTS_MD_DISCOVERY is one of the allowed values", () => {
  assert.ok(
    AGENTS_MD_DISCOVERY === true ||
      AGENTS_MD_DISCOVERY === false ||
      AGENTS_MD_DISCOVERY === "unverified",
    `unexpected value: ${String(AGENTS_MD_DISCOVERY)}`,
  );
});

test("R2: SUBAGENT_CONVERSATION_ISOLATION is locked true", () => {
  assert.equal(SUBAGENT_CONVERSATION_ISOLATION, true);
});

test("safety: assertNoAllowDecision throws FORBIDDEN_ALLOW_DECISION on allow", () => {
  assert.throws(
    () => assertNoAllowDecision({ decision: "allow" }),
    (err) => err instanceof Error && err.message === "FORBIDDEN_ALLOW_DECISION",
  );
  assert.throws(
    () => assertNoAllowDecision({ decision: "allow", reason: "sneaky" }),
    (err) => err instanceof Error && err.message === "FORBIDDEN_ALLOW_DECISION",
  );
});

test("safety: assertNoAllowDecision passes on deny, ask, empty, and non-objects", () => {
  assert.doesNotThrow(() => assertNoAllowDecision({ decision: "deny", reason: "blocked" }));
  assert.doesNotThrow(() => assertNoAllowDecision({ decision: "ask" }));
  assert.doesNotThrow(() => assertNoAllowDecision({}));
  assert.doesNotThrow(() => assertNoAllowDecision(null));
  assert.doesNotThrow(() => assertNoAllowDecision(undefined));
  assert.doesNotThrow(() => assertNoAllowDecision("allow")); // not a decision object
});
