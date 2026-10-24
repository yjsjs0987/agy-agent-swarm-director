// @ts-check
/**
 * ASD runtime contract — empirically locked Antigravity hook/subagent bindings.
 *
 * Every constant here is the single source of truth for later hooks
 * (`scripts/hooks/*.mjs`) and MCP wiring (`mcp_config.json`). Provenance and
 * probe evidence for each value: see `docs/runtime-contract.md` (R1–R6).
 *
 * @typedef {"overwrite" | "deny"} ModelEnforcementMode
 * @typedef {"plugin_root" | "workspace_root" | "unresolved_safe_default"} McpServerArgsMode
 * @typedef {true | false | "unverified"} AgentsMdDiscovery
 */

/**
 * R1 — Matches Antigravity file-write tool names (exact, anchored).
 * Evidenced names: `write_to_file`, `replace_file_content`,
 * `multi_replace_file_content` (live production matcher in
 * `~/.gemini/config/hooks.json`, "omo-write-guard"). Defensive baseline names
 * kept from the plan: `write_file`, `edit_file` (exact-anchored, so they can
 * never false-positive on a differently-named tool).
 *
 * @type {RegExp}
 */
export const WRITE_TOOL_MATCHER =
  /^(?:write_to_file|replace_file_content|multi_replace_file_content|write_file|edit_file)$/;

/**
 * R1 — Matches subagent-invocation tool names (exact, anchored).
 * Names locked from the plan baseline + live planning-session observation
 * (subagents were dispatched and returned with distinct conversationIds).
 * No doc/CLI listing exists; exact anchoring avoids over-matching read-only
 * hypothetical tools (e.g. a `subagent_status` inspector).
 *
 * @type {RegExp}
 */
export const SUBAGENT_TOOL_MATCHER =
  /^(?:invoke_subagent|subagent|launch_subagent)$/;

/**
 * R3 — Neutral PreToolUse output. Print `JSON.stringify(NEUTRAL_PRE_TOOL_OUTPUT)`
 * to stdout and exit 0 to pass a tool call through without deciding.
 * Frozen: hooks must never mutate the shared neutral object.
 *
 * @type {Readonly<Record<string, never>>}
 */
export const NEUTRAL_PRE_TOOL_OUTPUT = Object.freeze(
  /** @type {Record<string, never>} */ ({}),
);

/**
 * R4 — How `pre-tool-guard.mjs` enforces the model tier on `invoke_subagent`
 * when `Model` is missing or `"inherit"`.
 *
 * Locked to `"deny"` (safe fallback): hooks.md documents `overwrite` only in an
 * example that pairs it with `"decision": "allow"` (which ASD forbids), and
 * never states whether `overwrite` alone (without a decision) is honored.
 * Deny output shape:
 * `{"decision":"deny","reason":"[ASD_MODEL_POLICY] Re-invoke invoke_subagent with Model: '<tier>' (active profile: <profile>)"}`
 *
 * @type {ModelEnforcementMode}
 */
export const MODEL_ENFORCEMENT_MODE = /** @type {ModelEnforcementMode} */ ("deny");

/**
 * R6 — Working directory Antigravity uses when launching a plugin Stdio MCP
 * server from `mcp_config.json` `args`.
 *
 * Locked to `"unresolved_safe_default"`: mcp_servers.md documents
 * `command`/`args`/`env` but never the server process cwd. MANDATORY safe
 * design regardless of resolution: `scripts/mcp/asd-mcp-server.mjs` must
 * resolve its own directory via `import.meta.url` and NEVER trust
 * `process.cwd()`; `mcp_config.json` must not rely on cwd-relative paths.
 *
 * @type {McpServerArgsMode}
 */
export const MCP_SERVER_ARGS_MODE =
  /** @type {McpServerArgsMode} */ ("unresolved_safe_default");

/**
 * R5 — Whether plugin-bundled `agents/*.md` files are discovered as agents.
 *
 * Locked to `"unverified"`: plugins.md's directory structure (lines 15–25)
 * lists only `plugin.json`, `mcp_config.json`, `hooks.json`, `rules/`,
 * `skills/` — no `agents/`. `model: flash` frontmatter IS proven for
 * config-root agents (`~/.gemini/config/agents/explore.md`), but not for
 * plugins. Fallback: rely on the explicit `Model` parameter of
 * `invoke_subagent` (see docs/runtime-contract.md R5).
 *
 * @type {AgentsMdDiscovery}
 */
export const AGENTS_MD_DISCOVERY = /** @type {AgentsMdDiscovery} */ ("unverified");

/**
 * R2 — Subagent conversations receive a `conversationId` DISTINCT from the
 * parent main conversation, and global `Stop` hooks fire on subagents too.
 * Therefore every Orchestrator-only hook (Stop continuation, planning-mode
 * guards) MUST filter on `conversationId === session.mainConversationId`.
 * Proven live during planning (Metis subagent discovery).
 *
 * @type {true}
 */
export const SUBAGENT_CONVERSATION_ISOLATION = /** @type {true} */ (true);

/**
 * Safety invariant: no ASD hook may ever emit `"decision": "allow"` — it
 * bypasses Antigravity's user permission policies. Throws on violation.
 *
 * @param {unknown} obj Hook output object about to be serialized to stdout.
 * @returns {void}
 * @throws {Error} When `obj.decision === "allow"` (message: FORBIDDEN_ALLOW_DECISION).
 */
export function assertNoAllowDecision(obj) {
  if (
    obj !== null &&
    typeof obj === "object" &&
    "decision" in obj &&
    obj.decision === "allow"
  ) {
    throw new Error("FORBIDDEN_ALLOW_DECISION");
  }
}
