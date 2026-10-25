// @ts-check
/**
 * Privacy guard (plan Todo 23): scans the repository for absolute
 * user-profile paths - `C:\Users\<name>\...`, `/Users/<name>/...`,
 * `/home/<name>/...` - that would leak the maintainer's username when the
 * repo is published to GitHub.
 *
 * Pattern-based only: this file must never embed a real username or
 * machine-specific path (synthetic fixtures are built by concatenation).
 * Runs as part of `npm test`, so the CI workflow enforces it on every push.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";

const SELF_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SELF_PATH), "..");

/**
 * Regex SOURCE for an absolute user-profile path up to and including the
 * username segment (the PII). Shapes covered:
 * - `C:\Users\<name>` / `C:/Users/<name>`  (Windows)
 * - `/Users/<name>`                        (macOS)
 * - `/home/<name>`                         (Linux)
 * Built via `new RegExp(source, "g")` per line so no shared lastIndex state.
 * @type {string}
 */
const USER_PROFILE_RE_SOURCE =
  "(?:[A-Za-z]:[\\\\/]|[\\\\/])(?:Users|home)[\\\\/][^\\s\\\\/]+";

/**
 * Finds absolute user-profile path leaks in `text`.
 * @param {string} text
 * @returns {{ line: number, snippet: string }[]}
 */
function findUserPathLeaks(text) {
  /** @type {{ line: number, snippet: string }[]} */
  const hits = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const re = new RegExp(USER_PROFILE_RE_SOURCE, "g");
    let m = re.exec(lines[i]);
    while (m !== null) {
      hits.push({ line: i + 1, snippet: m[0] });
      m = re.exec(lines[i]);
    }
  }
  return hits;
}

/**
 * Redacts the trailing username segment so failure messages never print PII.
 * @param {string} snippet
 * @returns {string}
 */
function redactSnippet(snippet) {
  return snippet.replace(/[^\s\\/]+$/, "[REDACTED]");
}

test("detector flags synthetic absolute user paths (Windows, macOS, Linux shapes)", () => {
  // Built by concatenation so the full literal never appears in this file.
  const windowsShape = "C:" + "\\Users\\someone\\Desktop\\proj\\x.js";
  const macShape = "see " + "/Users" + "/somebody/docs";
  const linuxShape = "see " + "/home" + "/somebody/.bashrc";
  assert.equal(findUserPathLeaks(windowsShape).length, 1, "Windows shape must be flagged");
  assert.equal(findUserPathLeaks(macShape).length, 1, "macOS shape must be flagged");
  assert.equal(findUserPathLeaks(linuxShape).length, 1, "Linux shape must be flagged");
});

test("detector ignores tilde paths, relative paths, placeholders, and prose", () => {
  assert.equal(findUserPathLeaks("~/.gemini/config/hooks.json").length, 0);
  assert.equal(findUserPathLeaks("./scripts/asd.mjs").length, 0);
  assert.equal(findUserPathLeaks('node "<ASD_CLI>" preflight --cmd status').length, 0);
  assert.equal(findUserPathLeaks("the Users table holds rows").length, 0);
  assert.equal(findUserPathLeaks("path separator is / or \\").length, 0);
});

test("redaction truncates the username segment", () => {
  const windowsShape = "C:" + "\\Users\\someone\\Desktop";
  const hits = findUserPathLeaks(windowsShape);
  assert.equal(hits.length, 1);
  const redacted = redactSnippet(hits[0].snippet);
  assert.equal(redacted.includes("someone"), false, "redacted snippet must not contain the username");
  assert.ok(redacted.includes("[REDACTED]"), "redacted snippet must contain the [REDACTED] marker");
});

const TEXT_EXTS = new Set([
  ".mjs",
  ".js",
  ".md",
  ".json",
  ".yml",
  ".yaml",
  ".txt",
  ".html",
  ".css",
]);
const MAX_BYTES = 1024 * 1024;
const EXCLUDED_DIRS = new Set([".omo", ".git", "node_modules"]);

/**
 * Recursively lists files under `dir`, skipping excluded directories.
 * @param {string} dir
 * @param {string[]} [out]
 * @returns {string[]}
 */
function walkFiles(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry.name)) continue;
      walkFiles(full, out);
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out;
}

test("full-tree scan: zero absolute-user-path leaks in the repository", () => {
  /** @type {string[]} */
  const leaks = [];
  for (const file of walkFiles(REPO_ROOT)) {
    if (file === SELF_PATH) continue;
    if (!TEXT_EXTS.has(path.extname(file).toLowerCase())) continue;
    let st;
    try {
      st = fs.statSync(file);
    } catch {
      continue;
    }
    if (!st.isFile() || st.size > MAX_BYTES) continue;
    let text;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue; // non-UTF8 or unreadable -> skipped safely
    }
    for (const hit of findUserPathLeaks(text)) {
      leaks.push(
        `${path.relative(REPO_ROOT, file)}:${hit.line}: ${redactSnippet(hit.snippet)}`,
      );
    }
  }
  assert.equal(
    leaks.length,
    0,
    `PII / absolute-user-path leak(s) detected (username segments redacted):\n  ${leaks.join("\n  ")}`,
  );
});
