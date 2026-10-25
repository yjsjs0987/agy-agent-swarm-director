// @ts-check
/**
 * Structural validation for all 4 ASD skills (plan Todo 14): YAML frontmatter,
 * canonical CLI invocations, and relative reference links. Read-only over the
 * repo; the broken-link detector self-test uses a throwaway temp dir.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SKILLS = ["asd", "asd-plan", "asd-run", "asd-status"];

/**
 * Reads one skill file and validates its YAML frontmatter.
 * @param {string} skill
 * @returns {{ name: string, description: string, body: string }}
 */
function readSkill(skill) {
  const file = path.join(REPO_ROOT, "skills", skill, "SKILL.md");
  const raw = fs.readFileSync(file, "utf8");
  const fmMatch = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
  assert.ok(fmMatch, `${skill}: missing YAML frontmatter`);
  const nameMatch = /^name:\s*([A-Za-z0-9-]+)\s*$/m.exec(fmMatch[1]);
  const descMatch = /^description:\s*"(.+)"\s*$/m.exec(fmMatch[1]);
  assert.ok(nameMatch, `${skill}: frontmatter missing name`);
  assert.equal(nameMatch[1], skill, `${skill}: frontmatter name "${nameMatch[1]}" != directory "${skill}"`);
  assert.ok(descMatch && descMatch[1].length > 0, `${skill}: frontmatter missing description`);
  return { name: nameMatch[1], description: descMatch[1], body: raw };
}

/**
 * Returns broken relative .md reference links in a skill body.
 * @param {string} skillDir
 * @param {string} body
 * @returns {string[]}
 */
function brokenLinks(skillDir, body) {
  /** @type {string[]} */
  const out = [];
  const linkRe = /\]\(([^)#?]+?\.md)\)/g;
  let m = linkRe.exec(body);
  while (m !== null) {
    const target = path.resolve(skillDir, m[1]);
    if (!fs.existsSync(target)) out.push(m[1]);
    m = linkRe.exec(body);
  }
  return out;
}

test("all 4 skills have valid frontmatter (name matches directory, non-empty description)", () => {
  for (const skill of SKILLS) readSkill(skill);
});

test("every relative markdown reference link in every SKILL.md resolves", () => {
  for (const skill of SKILLS) {
    const { body } = readSkill(skill);
    const skillDir = path.join(REPO_ROOT, "skills", skill);
    const broken = brokenLinks(skillDir, body);
    assert.deepEqual(
      broken,
      [],
      `BROKEN_SKILL_REFERENCE in ${skill}: ${broken.join(", ")}`,
    );
  }
});

test("canonical CLI invocations appear in the skills that drive them", () => {
  const run = fs.readFileSync(path.join(REPO_ROOT, "skills", "asd-run", "SKILL.md"), "utf8");
  for (const needle of [
    "preflight --cmd",
    "turn next",
    "task start",
    "task done",
    "task fail",
    "todo add",
    "amend",
    "checkpoint",
    "learn",
    "summary",
  ]) {
    assert.ok(run.includes(needle), `asd-run SKILL.md missing canonical invocation: ${needle}`);
  }
  const status = fs.readFileSync(path.join(REPO_ROOT, "skills", "asd-status", "SKILL.md"), "utf8");
  for (const needle of ["preflight --cmd status", "phase set paused", "rollback --turn", "force-takeover"]) {
    assert.ok(status.includes(needle), `asd-status SKILL.md missing canonical invocation: ${needle}`);
  }
  const allInOne = fs.readFileSync(path.join(REPO_ROOT, "skills", "asd", "SKILL.md"), "utf8");
  for (const needle of ["preflight --cmd asd", "asd-plan", "asd-run", "summary --notes"]) {
    assert.ok(allInOne.includes(needle), `asd SKILL.md missing canonical reference: ${needle}`);
  }
});

test("detector self-test: a synthetic broken link is flagged (detector works)", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "asd-skillcheck-"));
  try {
    const body = "See [missing](references/does-not-exist.md) for details.";
    const broken = brokenLinks(tmp, body);
    assert.deepEqual(broken, ["references/does-not-exist.md"]);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
