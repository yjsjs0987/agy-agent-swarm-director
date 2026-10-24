# ASD Runtime Contract (Antigravity hooks & subagents) — LOCKED

> Single source of truth: `scripts/lib/runtime-contract.mjs`. Every hook
> (`scripts/hooks/*.mjs`) and MCP wiring (`mcp_config.json`) MUST consume these
> constants instead of re-deriving behavior. Probed 2026-10-25, agy v1.4.7.
> Probe evidence: `.omo/evidence/task-1-asd-plugin.txt`.

## Summary table

| ID | Contract point | Locked value | Confidence |
|----|-----------------|--------------|-----------|
| R1 | File-write tool matcher | `^(?:write_to_file\|replace_file_content\|multi_replace_file_content\|write_file\|edit_file)$` | 3 names production-evidenced, 2 defensive |
| R1 | Subagent tool matcher | `^(?:invoke_subagent\|subagent\|launch_subagent)$` | plan baseline + live planning observation |
| R2 | Subagent conversationId isolation | `true` | proven live during planning |
| R3 | Neutral PreToolUse output | `{}` (frozen), exit 0 | doc-ambiguous, safe default |
| R4 | Model enforcement mode | `"deny"` | doc-ambiguous → safe fallback |
| R5 | Plugin `agents/*.md` discovery | `"unverified"` | not documented in plugins.md |
| R6 | MCP server args cwd mode | `"unresolved_safe_default"` | not documented in mcp_servers.md |

---

## R1 — Tool name matchers

Tool names are derived by the runtime by lowercasing the step type and
stripping the `CORTEX_STEP_TYPE_` prefix (hooks.md:118–119). Matchers are
exact-anchored regexes; the runtime lowercases before matching, so the
matchers are case-sensitive lowercase.

### File-write tools — `WRITE_TOOL_MATCHER`

| Name | Source |
|------|--------|
| `write_to_file` | Live production matcher, `~/.gemini/config/hooks.json` line 5 (`"omo-write-guard"` PreToolUse matcher) |
| `replace_file_content` | Same live matcher, line 5 |
| `multi_replace_file_content` | Same live matcher, line 5 |
| `write_file` | Plan baseline (defensive; exact-anchored so it can never false-positive) |
| `edit_file` | Plan baseline (defensive; exact-anchored) |

Additional live evidence: `~/.gemini/config/omo-handlers/write-guard.mjs`
reads path args from keys `path`, `PathToCurrentFile`, `file_path`,
`fileName` (line 27) — useful for later hooks extracting the target path.
hooks.md examples confirm sibling tool names `run_command`, `view_file`,
`browser_.*` (lines 114–116), which the matcher must NOT hit.

### Subagent-invocation tools — `SUBAGENT_TOOL_MATCHER`

| Name | Source |
|------|--------|
| `invoke_subagent` | Plan baseline; observed live during planning (subagents dispatched and returned) |
| `subagent` | Plan baseline (defensive) |
| `launch_subagent` | Plan baseline (defensive) |

No agy doc or CLI output lists subagent tool names (grep over
`agy-customizations/docs/` for `subagent|invoke_subagent|launch_subagent`
returned only an unrelated budget mention in rules.md:36). Exact anchoring is
deliberate: a broad `.*subagent.*` would risk matching read-only inspector
tools; the anchored list only matches invocation-shaped names.

---

## R2 — Subagent conversationId isolation: `SUBAGENT_CONVERSATION_ISOLATION = true`

Proven live during planning (Metis subagent discovery): subagent conversations
receive a `conversationId` DISTINCT from the parent main conversation, and
global `Stop` hooks fire on subagent conversations too. Consequence (binding
on Todos 15/16):

- `stop-guard.mjs` MUST verify `input.conversationId ===
  session.mainConversationId` before returning `{"decision":"continue"}` —
  otherwise subagent workers are trapped in the Orchestrator's continuation
  loop.
- Planning-mode `PreToolUse` guards MUST apply the same filter so worker
  file edits are not blocked by planning-phase restrictions.

Doc support: hooks.md:142–158 — every hook payload carries `conversationId`
(camelCase, protojson).

---

## R3 — Neutral PreToolUse output: `NEUTRAL_PRE_TOOL_OUTPUT = {}` (frozen)

Locked value: print `{}` to stdout, exit 0.

Evidence and reasoning:

- hooks.md:189–226 documents the PreToolUse output with `decision`
  (required in the example), `reason`, `permissionOverrides`, `overwrite`.
- hooks.md:250: `PostToolUse` output "Expects an empty JSON object `{}`" —
  the runtime understands `{}` as a no-op for at least one event type.
- Live production evidence that hooks may print NOTHING and exit 0 as a
  neutral pass-through: `~/.gemini/config/omo-handlers/stop-continuation.mjs`
  (Stop event) prints nothing when not continuing.
- No doc line states what PreToolUse does with a decision-less `{}`.

Because docs do not prove any other neutral shape, the plan-mandated safe
default `{}` is locked. **Flip condition**: a live probe or doc update showing
PreToolUse `{}` is rejected/ignored would flip the neutral output to empty
stdout (the stop-continuation pattern). Risk is low: `{}` is the documented
no-op shape for PostToolUse and cannot bypass permissions (it contains no
`decision`).

---

## R4 — Model enforcement mode: `MODEL_ENFORCEMENT_MODE = "deny"`

Question: when `invoke_subagent` is called with `Model` missing or
`"inherit"`, can a PreToolUse hook return
`{"overwrite": {"Model": "<tier>"}}` WITHOUT `"decision": "allow"`, or is
deny-with-retry required?

Evidence:

- hooks.md:208–226: `overwrite` is an optional output field — "Key-value
  pairs merged into the tool call's arguments before it runs", shallow
  top-level merge; the modified call is what executes.
- The ONLY documented `overwrite` example (hooks.md:216–221) pairs it with
  `"decision": "allow"` — which ASD forbids as a matter of policy (it
  bypasses user permission settings).
- No doc line states whether `overwrite` is honored when `decision` is
  absent.

Docs are ambiguous → locked to the safe fallback `"deny"` per plan.
Deny output shape (binding on Todo 15):

```json
{"decision":"deny","reason":"[ASD_MODEL_POLICY] Re-invoke invoke_subagent with Model: '<tier>' (active profile: <profile>)"}
```

**Flip condition**: a live probe observing `{"overwrite": {"Model": "flash"}}`
(without `decision`) actually rewriting the dispatched subagent's model, or a
doc update confirming decision-less `overwrite` is honored. Flip would change
`MODEL_ENFORCEMENT_MODE` to `"overwrite"` and simplify the guard (no retry
round-trip).

---

## R5 — Plugin `agents/*.md` discovery: `AGENTS_MD_DISCOVERY = "unverified"`

Evidence:

- plugins.md:15–25 — the plugin directory structure lists ONLY:
  `plugin.json`, `mcp_config.json`, `hooks.json`, `rules/`, `skills/`.
  There is NO `agents/` entry.
- Grep across all agy-customizations docs found no `agents/` or
  `agents.json` plugin mechanism.
- `agy agents` (probed, 2.6s) listed only `sisyphus` — it did not enumerate
  `~/.gemini/config/agents/explore.md`, so it is not a reliable discovery
  probe either.
- `model: flash` frontmatter IS proven for config-root agents:
  `~/.gemini/config/agents/explore.md` (line 12: `model: flash`, plus
  `subagent: true`, `mainAgent: false`, `tools:` allowlist).

Locked `"unverified"`. Binding consequence (Todo 11): ship `agents/*.md`
role templates as documentation + optional manual install into
`~/.gemini/config/agents/`, but the RELIABLE path for model enforcement is
the explicit `Model` parameter on `invoke_subagent` (guarded per R4). Do not
assume plugin-bundled `agents/*.md` are loaded.

**Flip condition**: `agy plugin validate` reporting an `agents/` directory as
loaded, or a live session where a plugin-bundled agent name is invocable.

---

## R6 — MCP server args cwd mode: `MCP_SERVER_ARGS_MODE = "unresolved_safe_default"`

Evidence:

- mcp_servers.md:48–57 documents Stdio transport fields `command`, `args`,
  `env` — the server process working directory is NEVER mentioned.
- Contrast: hooks.md:131 explicitly sets hook command cwd to "the directory
  containing `hooks.json`" (plugin root for plugin hooks). No equivalent
  statement exists for MCP servers.

Locked `"unresolved_safe_default"`. MANDATORY safe design (binding on
Todo 22), regardless of the true cwd:

1. `scripts/mcp/asd-mcp-server.mjs` MUST resolve its own directory via
   `import.meta.url` (`new URL(".", import.meta.url).pathname` /
   `fileURLToPath`) and locate every sibling file (state schemas, presets)
   relative to THAT — never `process.cwd()`.
2. `mcp_config.json` must pass the server entry as an absolute-safe
   invocation; any data paths the server needs are resolved from
   `import.meta.url` or from explicit workspace paths passed by the caller —
   never from cwd-relative assumptions.
3. `scripts/install.mjs` must not emit cwd-dependent `args`.

**Flip condition**: a live probe (or doc update) showing the spawned server's
`process.cwd()`, which would allow tightening to `plugin_root` or
`workspace_root` — though the import.meta.url design stays mandatory anyway.

---

## Hook I/O quick reference (for Todos 15/16)

From hooks.md:137–226 and :342–384:

- Input: JSON on **stdin**, camelCase keys (`conversationId`, `stepIdx`,
  `toolCall.name`, `toolCall.args`, `workspacePaths`, `transcriptPath`,
  `modelName`, `lastUserInput`).
- Output: JSON on **stdout**. PreToolUse `decision` ∈ `allow|deny|ask|force_ask`
  (ASD only ever emits `deny`; neutral = `{}`). Stop `decision: "continue"`
  blocks stop; anything else allows it.
- Handler: `type: "command"`, run via `cmd /c` on Windows, cwd = directory
  containing `hooks.json`, `timeout` seconds (default 30).
- `matcher` is a regex; `"*"` or `""` matches all tools.
- ASD policy: NEVER emit `"decision": "allow"` — enforced by
  `assertNoAllowDecision()` in `scripts/lib/runtime-contract.mjs`.
