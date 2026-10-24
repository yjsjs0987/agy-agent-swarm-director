// @ts-check
import { strict as assert } from "node:assert";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  normalizeText,
  normalizePathForCompare,
  isSubpath,
  withFileLock,
  writeFileAtomic,
  readJsonSafe,
  appendJsonLine,
  ensureAsdDir,
  LockTimeoutError,
} from "../scripts/lib/fs-atomic.mjs";

/**
 * Fresh os.tmpdir() subdirectory per test; removed via t.after.
 * @param {import("node:test").TestContext} t
 * @returns {string}
 */
function freshDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "asd-fs-atomic-"));
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

test("normalizeText strips leading BOM and normalizes CRLF", () => {
  assert.equal(normalizeText("\uFEFFhello\r\nworld\r\n"), "hello\nworld\n");
  assert.equal(normalizeText("plain text"), "plain text");
  // Only the LEADING BOM is stripped; mid-string \uFEFF and lone \r survive.
  assert.equal(normalizeText("a\uFEFFb"), "a\uFEFFb");
  assert.equal(normalizeText("a\rb"), "a\rb");
  assert.equal(normalizeText(""), "");
});

test("normalizePathForCompare yields absolute forward-slash form", () => {
  const norm = normalizePathForCompare(path.join("some", "nested", "dir"));
  assert.ok(!norm.includes("\\"), "backslashes must be converted to /");
  assert.ok(path.isAbsolute(norm), "must resolve to an absolute path");
  if (process.platform === "win32") {
    assert.equal(norm, norm.toLowerCase(), "win32 paths must be lowercased");
    assert.equal(
      normalizePathForCompare("a\\b"),
      normalizePathForCompare("a/b"),
      "separator forms must unify on win32"
    );
  }
});

test("isSubpath accepts containment and rejects traversal/sibling prefixes", () => {
  assert.equal(isSubpath("/project/.asd", "/project/.asd/state.json"), true);
  assert.equal(isSubpath("/project/.asd", "/project/.asd/history/x.json"), true);
  assert.equal(isSubpath("/project/.asd", "/project/.asd/../src/index.js"), false);
  assert.equal(isSubpath("/project/.asd", "/project/.asd-backup/x"), false);
  assert.equal(isSubpath("/project/.asd", "/elsewhere/x"), false);
  assert.equal(isSubpath("/project/.asd", "/project/.asd"), false);
});

test("withFileLock: 20 concurrent increments on a shared counter yield exactly 20", async (t) => {
  const dir = freshDir(t);
  const counterPath = path.join(dir, "counter.json");
  const lockPath = path.join(dir, "counter.lock");
  fs.writeFileSync(counterPath, "0");
  await Promise.all(
    Array.from({ length: 20 }, () =>
      withFileLock(lockPath, async () => {
        const current = Number(fs.readFileSync(counterPath, "utf8"));
        await new Promise((resolve) => setTimeout(resolve, 1)); // hold lock across a tick
        fs.writeFileSync(counterPath, String(current + 1));
      })
    )
  );
  assert.equal(fs.readFileSync(counterPath, "utf8"), "20");
  assert.equal(fs.existsSync(lockPath), false, "lock must be released");
});

test("withFileLock evicts a stale lock (old createdAt)", async (t) => {
  const dir = freshDir(t);
  const lockPath = path.join(dir, "stale.lock");
  fs.writeFileSync(
    lockPath,
    JSON.stringify({ pid: 999999, createdAt: new Date(Date.now() - 60_000).toISOString() })
  );
  const result = await withFileLock(lockPath, async () => "acquired", { staleMs: 5_000 });
  assert.equal(result, "acquired");
  assert.equal(fs.existsSync(lockPath), false);
});

test("withFileLock evicts a corrupt (non-JSON) lock safely", async (t) => {
  const dir = freshDir(t);
  const lockPath = path.join(dir, "corrupt.lock");
  fs.writeFileSync(lockPath, "{not json at all");
  assert.equal(await withFileLock(lockPath, async () => 7), 7);
  assert.equal(fs.existsSync(lockPath), false);
});

test("withFileLock rejects with LOCK_TIMEOUT when a fresh lock stays held", async (t) => {
  const dir = freshDir(t);
  const lockPath = path.join(dir, "held.lock");
  fs.writeFileSync(
    lockPath,
    JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })
  );
  await assert.rejects(
    withFileLock(lockPath, async () => "never", { timeoutMs: 200, retryDelayMs: 10 }),
    (err) => err instanceof LockTimeoutError && err.code === "LOCK_TIMEOUT"
  );
  assert.ok(fs.existsSync(lockPath), "failed acquirer must not unlink a live lock");
});

test("withFileLock releases the lock when fn throws and stays reusable", async (t) => {
  const dir = freshDir(t);
  const lockPath = path.join(dir, "err.lock");
  await assert.rejects(
    withFileLock(lockPath, async () => {
      throw new Error("boom");
    })
  );
  assert.equal(fs.existsSync(lockPath), false);
  assert.equal(await withFileLock(lockPath, async () => "ok"), "ok");
});

test("writeFileAtomic overwrites content and leaves no *.tmp residue", async (t) => {
  const dir = freshDir(t);
  const target = path.join(dir, "state.json");
  await writeFileAtomic(target, "v1");
  await writeFileAtomic(target, "v2");
  assert.equal(fs.readFileSync(target, "utf8"), "v2");
  const residue = fs.readdirSync(dir).filter((f) => f.endsWith(".tmp"));
  assert.deepEqual(residue, []);
});

test("writeFileAtomic accepts Buffer content", async (t) => {
  const dir = freshDir(t);
  const target = path.join(dir, "bin.dat");
  await writeFileAtomic(target, Buffer.from([1, 2, 3]));
  assert.deepEqual(fs.readFileSync(target), Buffer.from([1, 2, 3]));
});

test("readJsonSafe parses BOM/CRLF files and falls back on corrupt/missing", (t) => {
  const dir = freshDir(t);
  const dataPath = path.join(dir, "data.json");
  fs.writeFileSync(dataPath, "\uFEFF{\"a\":1}\r\n");
  assert.deepEqual(readJsonSafe(dataPath, { a: 0 }), { a: 1 });
  fs.writeFileSync(dataPath, "{corrupt");
  assert.deepEqual(readJsonSafe(dataPath, { fallback: true }), { fallback: true });
  assert.deepEqual(readJsonSafe(path.join(dir, "missing.json"), null), null);
});

test("appendJsonLine creates, appends, and repairs a missing trailing newline", (t) => {
  const dir = freshDir(t);
  const ledgerPath = path.join(dir, "ledger.jsonl");
  appendJsonLine(ledgerPath, { n: 1 });
  appendJsonLine(ledgerPath, { n: 2 });
  const lines = fs.readFileSync(ledgerPath, "utf8").trim().split("\n");
  assert.equal(lines.length, 2);
  assert.deepEqual(lines.map((l) => JSON.parse(l)), [{ n: 1 }, { n: 2 }]);

  const tailPath = path.join(dir, "tail.jsonl");
  fs.writeFileSync(tailPath, '{"n":0}'); // no trailing newline
  appendJsonLine(tailPath, { n: 9 });
  const tailLines = fs.readFileSync(tailPath, "utf8").trim().split("\n");
  assert.equal(tailLines.length, 2);
  assert.deepEqual(tailLines.map((l) => JSON.parse(l)), [{ n: 0 }, { n: 9 }]);
});

test("ensureAsdDir creates all 4 artifacts and never touches <root>/.gitignore", async (t) => {
  const root = freshDir(t);
  const expectedGitignore = "session.json\nledger.jsonl\n*.lock\n*.tmp\n";
  const asdDir = await ensureAsdDir(root);
  assert.equal(asdDir, path.join(root, ".asd"));
  assert.ok(fs.statSync(path.join(root, ".asd")).isDirectory());
  assert.ok(fs.statSync(path.join(root, ".asd", "history")).isDirectory());
  assert.ok(fs.statSync(path.join(root, ".asd", "reports")).isDirectory());
  assert.equal(
    fs.readFileSync(path.join(root, ".asd", ".gitignore"), "utf8"),
    expectedGitignore
  );
  assert.equal(fs.existsSync(path.join(root, ".gitignore")), false, "root .gitignore untouched");

  // Idempotent: second call preserves the existing .asd/.gitignore.
  fs.writeFileSync(path.join(root, ".asd", ".gitignore"), "custom\n");
  await ensureAsdDir(root);
  assert.equal(fs.readFileSync(path.join(root, ".asd", ".gitignore"), "utf8"), "custom\n");

  // Custom dirName also works and stays inside the root.
  const other = await ensureAsdDir(root, ".asd-scratch");
  assert.ok(fs.statSync(path.join(other, "history")).isDirectory());
  assert.ok(fs.statSync(path.join(other, "reports")).isDirectory());
});
