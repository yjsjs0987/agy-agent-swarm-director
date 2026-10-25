// @ts-check
/**
 * Tests for scripts/install.mjs — the ASD plugin installer/verifier.
 *
 * Every invocation spawns the real CLI with an explicit --target-dir inside
 * a fresh os.tmpdir() subdir (cleaned via t.after). The real ~/.gemini/config
 * and <cwd>/.agents are NEVER touched.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INSTALL_MJS = path.join(REPO_ROOT, "scripts", "install.mjs");
/** This plugin's dir IS the repo root; plugins.json registers its PARENT. */
const PARENT_DIR = path.dirname(REPO_ROOT);

/**
 * Spawns the real CLI. cwd = repo root so default-scope resolution is stable,
 * but every test passes --target-dir so no default is ever exercised.
 * @param {string[]} args
 * @returns {import("node:child_process").SpawnSyncReturns<string>}
 */
function runCli(args) {
  const r = spawnSync(process.execPath, [INSTALL_MJS, ...args], {
    encoding: "utf8",
    cwd: REPO_ROOT,
  });
  assert.equal(r.error, undefined, `spawn failed: ${String(r.error)}`);
  return r;
}

/**
 * Fresh temp target dir, removed after the test.
 * @param {import("node:test").TestContext} t
 * @returns {string}
 */
function makeTargetDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "asd-install-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * @param {string} targetDir
 * @returns {any}
 */
function readPluginsJson(targetDir) {
  return JSON.parse(fs.readFileSync(path.join(targetDir, "plugins.json"), "utf8"));
}

test("status reports real plugin dir state (present + missing files)", (t) => {
  const target = makeTargetDir(t);
  const r = runCli(["status", "--target-dir", target]);
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  const report = JSON.parse(r.stdout);
  assert.equal(report.pluginBasename, "asd");
  assert.equal(report.pluginDir, REPO_ROOT);
  assert.equal(report.targetDir, target);
  assert.equal(report.registered, false);
  assert.equal(report.installed, false);
  assert.equal(report.files["plugin.json"], "present");
  assert.equal(report.files["rules/AGENTS.md"], "present");
  assert.equal(report.files["scripts/asd.mjs"], "present");
  // Not authored yet (later todos) — status must REPORT them, never fail.
  assert.equal(report.files["hooks.json"], "missing");
  assert.equal(report.files["skills/*/SKILL.md"], "missing");
});

test("install link registers idempotently and status flips to registered", (t) => {
  const target = makeTargetDir(t);
  // No --mode: exercises the default (link).
  const r1 = runCli(["install", "--target-dir", target]);
  assert.equal(r1.status, 0, `stderr: ${r1.stderr}`);
  const cfg1 = readPluginsJson(target);
  assert.equal(cfg1.entries.length, 1);
  assert.equal(cfg1.entries[0].path, PARENT_DIR);
  assert.deepEqual(cfg1.entries[0].include_only, ["asd"]);

  // Re-run with explicit --mode link: no duplicate entries.
  const r2 = runCli(["install", "--mode", "link", "--target-dir", target]);
  assert.equal(r2.status, 0, `stderr: ${r2.stderr}`);
  assert.equal(readPluginsJson(target).entries.length, 1);

  const st = runCli(["status", "--target-dir", target]);
  assert.equal(st.status, 0);
  assert.equal(JSON.parse(st.stdout).registered, true);
});

test("install copy copies present items and prints skip note for missing", (t) => {
  const target = makeTargetDir(t);
  const r = runCli(["install", "--mode", "copy", "--target-dir", target]);
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  const dest = path.join(target, "plugins", "asd");
  assert.ok(fs.existsSync(path.join(dest, "plugin.json")));
  assert.ok(fs.existsSync(path.join(dest, "rules", "AGENTS.md")));
  assert.ok(fs.existsSync(path.join(dest, "scripts", "asd.mjs")));
  assert.ok(fs.existsSync(path.join(dest, "agents", "asd-worker.md")));
  assert.match(r.stdout, /skip \(missing\): hooks\.json/);
  const st = runCli(["status", "--target-dir", target]);
  assert.equal(JSON.parse(st.stdout).installed, true);
});

test("uninstall link removes only the asd entry; other entries survive", (t) => {
  const target = makeTargetDir(t);
  assert.equal(runCli(["install", "--mode", "link", "--target-dir", target]).status, 0);
  // Seed a second, unrelated plugin entry.
  const pj = path.join(target, "plugins.json");
  const cfg = readPluginsJson(target);
  cfg.entries.push({ path: "C:/other", include_only: ["other"] });
  fs.writeFileSync(pj, JSON.stringify(cfg, null, 2) + "\n");

  const r = runCli(["uninstall", "--mode", "link", "--target-dir", target]);
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  const after = readPluginsJson(target);
  assert.equal(after.entries.length, 1);
  assert.equal(after.entries[0].path, "C:/other");
  assert.deepEqual(after.entries[0].include_only, ["other"]);
  const st = runCli(["status", "--target-dir", target]);
  assert.equal(JSON.parse(st.stdout).registered, false);
});

test("uninstall copy removes plugins/asd but leaves sibling plugin dirs", (t) => {
  const target = makeTargetDir(t);
  assert.equal(runCli(["install", "--mode", "copy", "--target-dir", target]).status, 0);
  const pluginsRoot = path.join(target, "plugins");
  // Sibling plugin dir must survive the uninstall.
  fs.mkdirSync(path.join(pluginsRoot, "other-plugin"), { recursive: true });

  const r = runCli(["uninstall", "--mode", "copy", "--target-dir", target]);
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  assert.ok(!fs.existsSync(path.join(pluginsRoot, "asd")));
  assert.ok(fs.existsSync(path.join(pluginsRoot, "other-plugin")));
});

test("unknown command exits 1 with usage help on stderr", () => {
  const r = runCli(["frobnicate"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Usage: node scripts\/install\.mjs/);
  assert.match(r.stderr, /unknown command: frobnicate/);
});

test("corrupt plugins.json is treated as {} and install link still succeeds", (t) => {
  const target = makeTargetDir(t);
  fs.writeFileSync(path.join(target, "plugins.json"), "{not valid json!!");
  const r = runCli(["install", "--mode", "link", "--target-dir", target]);
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  const cfg = readPluginsJson(target);
  assert.equal(cfg.entries.length, 1);
  assert.equal(cfg.entries[0].path, PARENT_DIR);
});
