// @ts-check
// allow: SIZE_OK — the plan mandates a single test file (tests/cli-extras.test.mjs);
// splitting would create files outside the approved deliverable set.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readJsonSafe } from "../scripts/lib/fs-atomic.mjs";

const CLI = fileURLToPath(new URL("../scripts/asd.mjs", import.meta.url));

/**
 * Fresh os.tmpdir() subdirectory per test; removed via t.after.
 * @param {import("node:test").TestContext} t
 * @returns {string}
 */
function freshDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "asd-extras-"));
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

/**
 * Spawns the real CLI with cwd = ws.
 * @param {string} ws
 * @param {string[]} args
 * @returns {import("node:child_process").SpawnSyncReturns<string>}
 */
function run(ws, args) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd: ws, encoding: "utf8" });
}

/**
 * Runs a command asserting exit 0; returns the spawn result.
 * @param {string} ws
 * @param {string[]} args
 */
function ok(ws, args) {
  const r = run(ws, args);
  assert.equal(
    r.status,
    0,
    `cmd failed: asd ${args.join(" ")}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`,
  );
  return r;
}

/**
 * Runs one git command in ws asserting exit 0; returns trimmed stdout.
 * @param {string} ws
 * @param {string[]} args
 * @returns {string}
 */
function git(ws, args) {
  const r = spawnSync("git", args, { cwd: ws, encoding: "utf8" });
  assert.equal(r.status, 0, `git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trim();
}

/**
 * Fresh tmp workspace that IS a git repo with repo-local identity, autocrlf
 * off, and one empty initial commit (so rev-list counts are deterministic).
 * @param {import("node:test").TestContext} t
 * @returns {string}
 */
function gitRepo(t) {
  const ws = freshDir(t);
  git(ws, ["init"]);
  git(ws, ["config", "user.name", "asd-test"]);
  git(ws, ["config", "user.email", "asd@test.local"]);
  git(ws, ["config", "core.autocrlf", "false"]);
  git(ws, ["commit", "--allow-empty", "-m", "init"]);
  return ws;
}

/**
 * Standard fixture: init + one task in Turn 1 + one in Turn 2 + turn next.
 * @param {string} ws
 */
function setupTurns(ws) {
  ok(ws, ["init", "--slug", "demo", "--title", "Demo Plan"]);
  ok(ws, ["todo", "add", "--turn", "1", "--flag", "BUILD", "--summary", "build the thing"]);
  ok(ws, ["todo", "add", "--turn", "2", "--flag", "BUILD", "--summary", "later thing"]);
  ok(ws, ["turn", "next"]);
}

/** @param {string} ws @returns {any} */
const stateOf = (ws) => readJsonSafe(path.join(ws, ".asd", "state.json"), null);

/**
 * Flips one boolean in .asd/state.json (test fixture manipulation; the CLI has
 * no option-mutation command by design).
 * @param {string} ws
 * @param {"gitCheckpoint" | "learnings"} key
 */
function enableOption(ws, key) {
  const p = path.join(ws, ".asd", "state.json");
  const st = JSON.parse(fs.readFileSync(p, "utf8"));
  st.options[key] = true;
  fs.writeFileSync(p, JSON.stringify(st, null, 2) + "\n");
}

/* ------------------------------------------------------------------ */

test("checkpoint --turn 1 creates exactly one commit, records the SHA, excludes session/ledger", (t) => {
  const ws = gitRepo(t);
  fs.mkdirSync(path.join(ws, "src"));
  fs.writeFileSync(path.join(ws, "src", "a.js"), "v1\n");
  setupTurns(ws);
  enableOption(ws, "gitCheckpoint");
  const before = Number(git(ws, ["rev-list", "--count", "HEAD"]));

  const r = ok(ws, ["checkpoint", "--turn", "1"]);

  const after = Number(git(ws, ["rev-list", "--count", "HEAD"]));
  assert.equal(after, before + 1, "exactly one new commit");
  const msg = git(ws, ["log", "-1", "--pretty=%B"]);
  assert.match(msg, /^chore\(asd\): checkpoint turn T1 \(Turn 1\)$/);
  const sha = git(ws, ["rev-parse", "HEAD"]);
  const st = stateOf(ws);
  const entry = st.turns.find((/** @type {any} */ x) => x.turn === 1);
  assert.equal(entry.checkpointCommit, sha, "SHA recorded on the turn entry");
  const files = git(ws, ["show", "--name-only", "--pretty=format:", "HEAD"])
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s !== "");
  assert.ok(files.includes("src/a.js"), "project files staged");
  assert.equal(files.includes(".asd/session.json"), false, "session.json never staged");
  assert.equal(
    files.some((f) => f.startsWith(".asd/ledger")),
    false,
    "ledger.jsonl never staged",
  );
  assert.ok(r.stdout.length > 0, "TODO box printed");
});

test("checkpoint --turn 1 when gitCheckpoint false exits 0 skipped with zero commits", (t) => {
  const ws = gitRepo(t);
  setupTurns(ws); // init defaults gitCheckpoint to false
  const before = Number(git(ws, ["rev-list", "--count", "HEAD"]));

  const r = ok(ws, ["checkpoint", "--turn", "1"]);

  assert.deepEqual(JSON.parse(r.stdout), {
    skipped: true,
    reason: "gitCheckpoint disabled in plan options",
  });
  assert.equal(Number(git(ws, ["rev-list", "--count", "HEAD"])), before, "zero new commits");
  const entry = stateOf(ws).turns.find((/** @type {any} */ x) => x.turn === 1);
  assert.equal(entry.checkpointCommit, null, "no SHA recorded");
});

test("rollback --turn 1 restores the working tree and resets Turn 2 tasks to pending", (t) => {
  const ws = gitRepo(t);
  fs.mkdirSync(path.join(ws, "src"));
  fs.writeFileSync(path.join(ws, "src", "a.js"), "v1\n");
  setupTurns(ws);
  enableOption(ws, "gitCheckpoint");
  ok(ws, ["checkpoint", "--turn", "1"]);
  fs.writeFileSync(path.join(ws, "src", "a.js"), "v2\n");
  ok(ws, ["task", "start", "T2.1"]);
  assert.equal(
    stateOf(ws).tasks.find((/** @type {any} */ x) => x.id === "T2.1").status,
    ">",
    "precondition: T2.1 in progress before rollback",
  );

  const r = ok(ws, ["rollback", "--turn", "1"]);

  assert.equal(
    fs.readFileSync(path.join(ws, "src", "a.js"), "utf8"),
    "v1\n",
    "working tree restored to the checkpoint SHA",
  );
  const st = stateOf(ws);
  assert.equal(st.tasks.find((/** @type {any} */ x) => x.id === "T2.1").status, " ");
  const todo = fs.readFileSync(path.join(ws, ".asd", "TODO.md"), "utf8");
  assert.match(todo, /^- \[ \] \[BUILD\] T2\.1 /m, "TODO.md re-rendered with T2.1 pending");
  assert.ok(r.stdout.includes("T2.1"), "TODO box printed");
});

test("checkpoint/rollback on missing turns and non-repo workspaces exit 1 with clear errors", (t) => {
  const ws = gitRepo(t);
  setupTurns(ws);
  enableOption(ws, "gitCheckpoint");

  const noTurn = run(ws, ["checkpoint", "--turn", "9"]);
  assert.equal(noTurn.status, 1);
  assert.ok(noTurn.stderr.includes("T9 not found"));

  const noSha = run(ws, ["rollback", "--turn", "1"]);
  assert.equal(noSha.status, 1);
  assert.ok(noSha.stderr.includes("no checkpoint recorded"));

  const ws2 = freshDir(t); // no git init
  ok(ws2, ["init", "--slug", "demo", "--title", "Demo Plan"]);
  ok(ws2, ["todo", "add", "--turn", "1", "--flag", "BUILD", "--summary", "s"]);
  ok(ws2, ["turn", "next"]);
  enableOption(ws2, "gitCheckpoint");
  const notRepo = run(ws2, ["checkpoint", "--turn", "1"]);
  assert.equal(notRepo.status, 1);
  assert.ok(notRepo.stderr.includes("git repository"));
});

test("learn appends strictly formatted entries and creates the file with header", (t) => {
  const ws = freshDir(t);
  ok(ws, ["init", "--slug", "demo", "--title", "Demo Plan"]);
  enableOption(ws, "learnings");

  const r = ok(ws, ["learn", "--category", "build", "--note", "reuse lib helpers"]);

  const p = path.join(ws, ".asd", "learnings.md");
  const md = fs.readFileSync(p, "utf8");
  assert.equal(md.split(/\r?\n/)[0], "# ASD Project Learnings", "header created on first append");
  assert.match(md, /^- \[\d{4}-\d{2}-\d{2}\] \[build\] reuse lib helpers$/m);
  assert.ok(r.stdout.includes("reuse lib helpers"), "confirmation printed");

  ok(ws, ["learn", "--category", "repo", "--note", "second entry"]);
  const md2 = fs.readFileSync(p, "utf8");
  assert.match(md2, /^- \[\d{4}-\d{2}-\d{2}\] \[repo\] second entry$/m, "second entry appended");
});

test("learn when learnings false exits 0 skipped and creates no file", (t) => {
  const ws = freshDir(t);
  ok(ws, ["init", "--slug", "demo", "--title", "Demo Plan"]); // learnings defaults false

  const r = ok(ws, ["learn", "--category", "build", "--note", "nope"]);

  assert.deepEqual(JSON.parse(r.stdout), {
    skipped: true,
    reason: "learnings disabled in plan options",
  });
  assert.equal(fs.existsSync(path.join(ws, ".asd", "learnings.md")), false);
});

test("learn rejects invalid categories and multiline notes", (t) => {
  const ws = freshDir(t);
  ok(ws, ["init", "--slug", "demo", "--title", "Demo Plan"]);
  enableOption(ws, "learnings");

  const badCat = run(ws, ["learn", "--category", "vibes", "--note", "x"]);
  assert.equal(badCat.status, 1);
  assert.ok(badCat.stderr.includes("--category must be one of"));

  const badNote = run(ws, ["learn", "--category", "build", "--note", "line1\nline2"]);
  assert.equal(badNote.status, 1);
  assert.ok(badNote.stderr.includes("--note"));
  assert.equal(
    fs.existsSync(path.join(ws, ".asd", "learnings.md")),
    false,
    "no file created on rejection",
  );
});
