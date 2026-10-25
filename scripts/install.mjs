// @ts-check
// allow: SIZE_OK — the plan mandates a single installer file (scripts/install.mjs);
// splitting would create files outside the approved deliverable set.
/**
 * ASD plugin installer/verifier for Antigravity customization roots.
 *
 * Registers (link mode) or copies (copy mode) this plugin into a target
 * config directory (`<cwd>/.agents` by default, `~/.gemini/config` with
 * `--scope global`, or an explicit `--target-dir`). Link mode follows the
 * `plugins.json` schema from agy-customizations docs: an `entries` array
 * whose `path` points at the plugin's PARENT directory (scanned one level
 * deep) with `include_only: ["asd"]` so sibling directories are not loaded.
 *
 * MCP dedupe: when installing, the user's global `~/.gemini/config/mcp_config.json`
 * is checked (read-only) for `context7` / `grep_app` / `websearch`; entries that
 * already exist there are reported as globally active and never overwritten.
 *
 * Zero dependencies: node: built-ins + ./lib/fs-atomic.mjs only.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  writeFileAtomic,
  readJsonSafe,
  normalizePathForCompare,
} from "./lib/fs-atomic.mjs";

/** Directory containing this script (`<plugin>/scripts`). */
const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
/** This plugin's root directory (parent of `scripts/`, holds plugin.json). */
export const PLUGIN_DIR = path.resolve(SCRIPTS_DIR, "..");
/** Plugin directory basename, e.g. "asd". */
export const PLUGIN_BASENAME = path.basename(PLUGIN_DIR);
/** Parent of the plugin dir — the directory registered in plugins.json. */
const PARENT_DIR = path.dirname(PLUGIN_DIR);

/** Items copy mode copies into `<target>/plugins/asd/` (missing ones skipped). */
const COPY_ITEMS = ["plugin.json", "hooks.json", "rules", "agents", "skills", "scripts"];

/**
 * External MCP servers this plugin's root mcp_config.json also declares.
 * When the user's global config already defines one, it is reported as
 * "already globally active" and NEVER overwritten — the global entry wins.
 */
const MCP_GLOBAL_SERVERS = Object.freeze(["context7", "grep_app", "websearch"]);

/** @returns {string} */
function globalMcpConfigPath() {
  return path.join(os.homedir(), ".gemini", "config", "mcp_config.json");
}

/**
 * Reads the server names defined in an mcp_config.json (the documented shape
 * wraps entries in "mcpServers"; a flat top-level map is tolerated).
 * @param {string} cfgPath
 * @returns {string[] | null} defined server names, or null when absent/corrupt
 */
function readMcpServerNames(cfgPath) {
  const cfg = readJsonSafe(cfgPath, null);
  if (cfg === null || typeof cfg !== "object" || Array.isArray(cfg)) return null;
  const servers = cfg.mcpServers && typeof cfg.mcpServers === "object" && !Array.isArray(cfg.mcpServers)
    ? cfg.mcpServers
    : cfg;
  return Object.keys(servers);
}

/**
 * Which of the plugin's external MCP servers are already defined in the
 * user's global `~/.gemini/config/mcp_config.json`.
 * @returns {{ globalConfigPath: string, globallyActive: string[], notGloballyActive: string[] }}
 */
function mcpGlobalsReport() {
  const globalConfigPath = globalMcpConfigPath();
  const names = readMcpServerNames(globalConfigPath);
  /** @type {string[]} */ const globallyActive = [];
  /** @type {string[]} */ const notGloballyActive = [];
  for (const name of MCP_GLOBAL_SERVERS) {
    (names !== null && names.includes(name) ? globallyActive : notGloballyActive).push(name);
  }
  return { globalConfigPath, globallyActive, notGloballyActive };
}

/**
 * Logs the MCP dedupe verdict for install commands. Read-only: the user's
 * global mcp_config.json is never written or overwritten by this installer.
 * @returns {void}
 */
function reportMcpGlobals() {
  const r = mcpGlobalsReport();
  if (r.globallyActive.length > 0) {
    console.log(`mcp: already globally active (kept, never overwritten): ${r.globallyActive.join(", ")}`);
  }
  if (r.notGloballyActive.length > 0) {
    console.log(`mcp: not globally active (plugin root mcp_config.json covers them): ${r.notGloballyActive.join(", ")}`);
  }
}

/**
 * @typedef {"status" | "install" | "uninstall"} Command
 * @typedef {"workspace" | "global"} Scope
 * @typedef {"link" | "copy"} Mode
 * @typedef {{ error: string }} ParseError
 * @typedef {{ cmd: Command, targetDir: string | null, scope: Scope, mode: Mode }} ParseOk
 */

/** @returns {string} */
function usage() {
  return [
    "Usage: node scripts/install.mjs <command> [options]",
    "",
    "Commands:",
    "  status                          Print JSON registration/install report",
    "  install [--mode link|copy]      Register (link) or copy the plugin",
    "  uninstall [--mode link|copy]    Remove the registration or the copy",
    "",
    "Options:",
    "  --scope workspace|global       Default target dir when --target-dir omitted:",
    "                                  workspace -> <cwd>/.agents, global -> ~/.gemini/config",
    "  --target-dir <dir>              Explicit target config directory (overrides --scope)",
    "  --mode link|copy                Install mode (default: link)",
  ].join("\n");
}

/**
 * Resolves an entry `path` field the way agy json_configs.md does:
 * `~/` expands to the home directory, then path.resolve.
 * @param {unknown} p
 * @returns {string | null}
 */
function resolveEntryPath(p) {
  if (typeof p !== "string" || p === "") return null;
  const expanded = p === "~" || p.startsWith("~/")
    ? path.join(os.homedir(), p.slice(1))
    : p;
  return path.resolve(expanded);
}

/**
 * True when a plugins.json entry object points at this plugin's parent dir.
 * @param {unknown} entry
 * @returns {boolean}
 */
function isThisPluginsEntry(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
  const resolved = resolveEntryPath(/** @type {any} */ (entry).path);
  return resolved !== null &&
    normalizePathForCompare(resolved) === normalizePathForCompare(PARENT_DIR);
}

/**
 * @param {string} targetDir
 * @returns {string}
 */
function pluginsJsonPathOf(targetDir) {
  return path.join(targetDir, "plugins.json");
}

/**
 * Reads plugins.json from targetDir. Malformed/missing -> `{}`.
 * @param {string} targetDir
 * @returns {Record<string, any>}
 */
function readPluginsConfig(targetDir) {
  const cfg = readJsonSafe(pluginsJsonPathOf(targetDir), {});
  return cfg && typeof cfg === "object" && !Array.isArray(cfg)
    ? cfg
    : {};
}

/** @param {string} p @returns {"present" | "missing"} */
function fileState(p) {
  return fs.existsSync(p) ? "present" : "missing";
}

/**
 * Counts SKILL.md docs in skills subdirectories (0 when skills/ is
 * missing or has no skill docs).
 * @returns {number}
 */
function countSkillDocs() {
  const skillsDir = path.join(PLUGIN_DIR, "skills");
  let count = 0;
  try {
    for (const name of fs.readdirSync(skillsDir)) {
      const skillDoc = path.join(skillsDir, name, "SKILL.md");
      try {
        if (fs.statSync(path.join(skillsDir, name)).isDirectory() &&
            fs.statSync(skillDoc).isFile()) count++;
      } catch {
        /* broken entry: not a skill doc */
      }
    }
  } catch {
    /* skills/ missing entirely */
  }
  return count;
}

/**
 * `status`: prints a JSON report to stdout. Missing files are reported,
 * never fatal. Always exits 0 (usage errors exit 1 before this runs).
 * @param {string} targetDir
 * @returns {void}
 */
function statusCmd(targetDir) {
  const cfg = readPluginsConfig(targetDir);
  const entries = Array.isArray(cfg.entries) ? cfg.entries : [];
  const skillCount = countSkillDocs();
  const report = {
    pluginDir: PLUGIN_DIR,
    pluginBasename: PLUGIN_BASENAME,
    targetDir,
    registered: entries.some(isThisPluginsEntry),
    installed: fs.existsSync(path.join(targetDir, "plugins", PLUGIN_BASENAME)),
    mcp: mcpGlobalsReport(),
    files: {
      "plugin.json": fileState(path.join(PLUGIN_DIR, "plugin.json")),
      "hooks.json": fileState(path.join(PLUGIN_DIR, "hooks.json")),
      "rules/AGENTS.md": fileState(path.join(PLUGIN_DIR, "rules", "AGENTS.md")),
      "scripts/asd.mjs": fileState(path.join(PLUGIN_DIR, "scripts", "asd.mjs")),
      "skills/*/SKILL.md": skillCount > 0 ? "present" : "missing",
    },
  };
  console.log(JSON.stringify(report, null, 2));
}

/**
 * `install --mode link`: registers PARENT_DIR in `<targetDir>/plugins.json`
 * with `include_only: ["asd"]`. Idempotent; malformed JSON treated as `{}`;
 * other entries and top-level fields preserved.
 * @param {string} targetDir
 * @returns {Promise<void>}
 */
async function installLink(targetDir) {
  fs.mkdirSync(targetDir, { recursive: true });
  const cfg = readPluginsConfig(targetDir);
  const entries = Array.isArray(cfg.entries) ? cfg.entries.slice() : [];
  const already = entries.some(isThisPluginsEntry);
  if (!already) {
    entries.push({ path: PARENT_DIR, include_only: [PLUGIN_BASENAME] });
  }
  cfg.entries = entries;
  await writeFileAtomic(pluginsJsonPathOf(targetDir), JSON.stringify(cfg, null, 2) + "\n");
  reportMcpGlobals();
  console.log(already
    ? `already registered: ${PLUGIN_BASENAME} -> ${pluginsJsonPathOf(targetDir)}`
    : `registered: ${PLUGIN_BASENAME} (path: ${PARENT_DIR}) -> ${pluginsJsonPathOf(targetDir)}`);
}

/**
 * `install --mode copy`: copies plugin items into `<targetDir>/plugins/asd/`.
 * Each item is copied only if it exists; missing items get a skip note
 * (hooks.json and skills SKILL.md may not exist yet — expected, not fatal).
 * @param {string} targetDir
 * @returns {void}
 */
function installCopy(targetDir) {
  const dest = path.join(targetDir, "plugins", PLUGIN_BASENAME);
  fs.mkdirSync(dest, { recursive: true });
  for (const item of COPY_ITEMS) {
    const src = path.join(PLUGIN_DIR, item);
    if (fs.existsSync(src)) {
      fs.cpSync(src, path.join(dest, item), { recursive: true });
      console.log(`copied: ${item}`);
    } else {
      console.log(`skip (missing): ${item}`);
    }
  }
  console.log(`copied plugin -> ${dest}`);
  reportMcpGlobals();
}

/**
 * `uninstall --mode link`: removes this plugin's entry from plugins.json,
 * leaving every other entry and top-level field untouched. No write happens
 * when the plugin is not registered (idempotent, corrupt file left alone).
 * @param {string} targetDir
 * @returns {Promise<void>}
 */
async function uninstallLink(targetDir) {
  const pluginsJsonPath = pluginsJsonPathOf(targetDir);
  const cfg = readPluginsConfig(targetDir);
  if (!Array.isArray(cfg.entries)) {
    console.log(`no plugins.json entries to remove in ${pluginsJsonPath}`);
    return;
  }
  const before = cfg.entries.length;
  cfg.entries = cfg.entries.filter((/** @type {unknown} */ e) => !isThisPluginsEntry(e));
  if (cfg.entries.length === before) {
    console.log(`not registered in ${pluginsJsonPath}`);
    return;
  }
  await writeFileAtomic(pluginsJsonPath, JSON.stringify(cfg, null, 2) + "\n");
  console.log(`unregistered: ${PLUGIN_BASENAME} from ${pluginsJsonPath}`);
}

/**
 * `uninstall --mode copy`: removes `<targetDir>/plugins/asd/` only;
 * sibling plugin directories are untouched.
 * @param {string} targetDir
 * @returns {void}
 */
function uninstallCopy(targetDir) {
  const dest = path.join(targetDir, "plugins", PLUGIN_BASENAME);
  if (fs.existsSync(dest)) {
    fs.rmSync(dest, { recursive: true, force: true });
    console.log(`removed: ${dest}`);
  } else {
    console.log(`not installed (copy) at ${dest}`);
  }
}

/**
 * @param {string[]} argv
 * @returns {ParseOk | ParseError}
 */
function parseArgs(argv) {
  const cmd = argv[0];
  if (!cmd) return { error: "missing command" };
  if (cmd !== "status" && cmd !== "install" && cmd !== "uninstall") {
    return { error: `unknown command: ${cmd}` };
  }
  /** @type {string | null} */ let targetDir = null;
  /** @type {Scope} */ let scope = "workspace";
  /** @type {Mode} */ let mode = "link";
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--target-dir") {
      targetDir = argv[++i];
      if (!targetDir) return { error: "--target-dir requires a value" };
    } else if (a === "--scope") {
      const v = argv[++i];
      if (v !== "workspace" && v !== "global") {
        return { error: `invalid --scope: ${v ?? "(missing)"}` };
      }
      scope = v;
    } else if (a === "--mode") {
      const v = argv[++i];
      if (v !== "link" && v !== "copy") {
        return { error: `invalid --mode: ${v ?? "(missing)"}` };
      }
      mode = v;
    } else {
      return { error: `unknown option: ${a}` };
    }
  }
  return { cmd, targetDir, scope, mode };
}

/**
 * --target-dir wins; otherwise --scope picks the default target.
 * @param {string | null} targetDir
 * @param {Scope} scope
 * @returns {string}
 */
function resolveTargetDir(targetDir, scope) {
  if (targetDir) return path.resolve(targetDir);
  return scope === "global"
    ? path.join(os.homedir(), ".gemini", "config")
    : path.join(process.cwd(), ".agents");
}

const parsed = parseArgs(process.argv.slice(2));
if ("error" in parsed) {
  console.error(usage());
  console.error(`error: ${parsed.error}`);
  process.exit(1);
}
const targetDir = resolveTargetDir(parsed.targetDir, parsed.scope);
if (parsed.cmd === "status") {
  statusCmd(targetDir);
} else if (parsed.cmd === "install") {
  await (parsed.mode === "link" ? installLink(targetDir) : installCopy(targetDir));
} else {
  await (parsed.mode === "link" ? uninstallLink(targetDir) : uninstallCopy(targetDir));
}
