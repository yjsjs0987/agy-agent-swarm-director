// @ts-check
/**
 * `.asd/session.json` manager: single-main-Orchestrator lock with stale
 * takeover, archive history, and subagent discrimination (plan Todo 7).
 *
 * Contract:
 * - Every session write happens under `withFileLock("<session.json>.lock")`
 *   through `writeFileAtomic`; readers use `readJsonSafe` (BOM/CRLF/corrupt
 *   tolerant). A corrupt session.json is re-initialized, never repaired.
 * - `command` arrives as a preflight cmd ("plan"|"asd"|"run"|"status") and is
 *   mapped into the schema's ACTIVE_COMMANDS vocabulary; unknown -> null.
 * - Takeover resets phase/startedAt/autonomyGranted because a NEW
 *   conversation begins; the previous holder is archived with a reason.
 */
import path from "node:path";
import {
  ASD_DIR_NAME,
  SCHEMA_VERSION,
  STALE_SESSION_MS,
} from "./constants.mjs";
import {
  ensureAsdDir,
  readJsonSafe,
  writeFileAtomic,
  withFileLock,
} from "./fs-atomic.mjs";
import { validateSession } from "./schema.mjs";

/** Session phases that never hold the Orchestrator lock (plan line 346). */
const INACTIVE_PHASES = new Set(["idle", "done", "paused"]);

/** preflight cmd -> schema-valid activeCommand (ACTIVE_COMMANDS vocabulary). */
const CMD_TO_ACTIVE = new Map([
  ["asd", "asd"],
  ["plan", "asd-plan"],
  ["run", "asd-run"],
  ["status", "asd-status"],
]);

/**
 * @typedef {Object} AsdSession
 * @property {number} schemaVersion
 * @property {string} mainConversationId
 * @property {string} projectRoot
 * @property {string | null} activeCommand
 * @property {string} phase
 * @property {string} startedAt
 * @property {string} lastSeenAt
 * @property {boolean} autonomyGranted
 * @property {{ conversationId: string, endedAt: string, reason: string }[]} previousSessions
 */

/**
 * @typedef {Object} LoadSessionOptions
 * @property {string} conversationId
 * @property {string | null} [command] preflight cmd; mapped to activeCommand
 * @property {boolean} [forceTakeover]
 */

/**
 * Absolute `.asd/session.json` path (also used by hooks and the CLI).
 * @param {string} workspaceRoot
 * @returns {string}
 */
export function sessionPath(workspaceRoot) {
  return path.join(workspaceRoot, ASD_DIR_NAME, "session.json");
}

/**
 * Maps a preflight cmd to the session schema's activeCommand vocabulary;
 * anything unknown becomes `null` (schema-valid "no active command").
 * @param {string | null | undefined} cmd
 * @returns {string | null}
 */
function toActiveCommand(cmd) {
  if (typeof cmd !== "string") return null;
  return CMD_TO_ACTIVE.get(cmd) ?? null;
}

/**
 * @param {Record<string, unknown>} session
 * @param {string} label
 */
function assertValid(session, label) {
  const v = validateSession(session);
  if (!v.ok) {
    throw new Error(`${label} failed session validation: ${v.errors.join("; ")}`);
  }
}

/** @param {Record<string, unknown>} s @returns {string} */
const serialize = (s) => JSON.stringify(s, null, 2) + "\n";

/**
 * Loads `.asd/session.json` for `conversationId`, creating it when missing
 * or corrupt, heart-beating it when the same conversation returns, and
 * enforcing the single-main-Orchestrator lock otherwise.
 *
 * Outcomes:
 * - `{ session, status }` with status `"created"` (missing/corrupt file),
 *   `"ok"` (same conversation), `"took_over_stale_session"` (holder stale
 *   > STALE_SESSION_MS or in an inactive phase), or `"took_over_forced"`
 *   (`forceTakeover`). The previous holder is archived into
 *   `previousSessions[]` on every takeover.
 * - `{ lockConflict: true, holderConversationId, lastSeenAt }` — a fresh,
 *   active session belongs to a different conversation and `forceTakeover`
 *   was not set; the caller must ask the human about `--force-takeover`.
 *
 * @param {string} workspaceRoot
 * @param {LoadSessionOptions} options
 * @returns {Promise<{ session: AsdSession, status: string } | { lockConflict: boolean, holderConversationId: string, lastSeenAt: string }>}
 */
export async function loadOrInitSession(workspaceRoot, options) {
  const conversationId = options.conversationId;
  if (typeof conversationId !== "string" || conversationId.length === 0) {
    throw new TypeError("conversationId must be a non-empty string");
  }
  const forceTakeover = options.forceTakeover === true;
  await ensureAsdDir(workspaceRoot);
  const sPath = sessionPath(workspaceRoot);
  return withFileLock(`${sPath}.lock`, async () => {
    const now = new Date().toISOString();
    const existing = readJsonSafe(sPath, null);
    if (existing === null || !validateSession(existing).ok) {
      // Missing OR corrupt session.json -> fresh init (readJsonSafe makes a
      // corrupt file indistinguishable from an absent one, by design).
      const session = {
        schemaVersion: SCHEMA_VERSION,
        mainConversationId: conversationId,
        projectRoot: path.resolve(workspaceRoot),
        activeCommand: toActiveCommand(options.command),
        phase: "idle",
        startedAt: now,
        lastSeenAt: now,
        autonomyGranted: false,
        previousSessions: [],
      };
      assertValid(session, "session init");
      await writeFileAtomic(sPath, serialize(session));
      return { session, status: "created" };
    }

    if (existing.mainConversationId === conversationId) {
      existing.lastSeenAt = now;
      if (options.command !== undefined) {
        existing.activeCommand = toActiveCommand(options.command);
      }
      assertValid(existing, "session heartbeat");
      await writeFileAtomic(sPath, serialize(existing));
      return { session: existing, status: "ok" };
    }

    const ageMs = Date.now() - Date.parse(existing.lastSeenAt);
    const stale = ageMs > STALE_SESSION_MS;
    const phaseInactive = INACTIVE_PHASES.has(existing.phase);
    if (!forceTakeover && !stale && !phaseInactive) {
      return {
        lockConflict: true,
        holderConversationId: existing.mainConversationId,
        lastSeenAt: existing.lastSeenAt,
      };
    }

    const reason = forceTakeover
      ? "forced_takeover"
      : stale
        ? "stale_last_seen"
        : `inactive_phase_${existing.phase}`;
    const taken = {
      ...existing,
      mainConversationId: conversationId,
      activeCommand: toActiveCommand(options.command),
      phase: "idle",
      startedAt: now,
      lastSeenAt: now,
      autonomyGranted: false,
      previousSessions: [
        ...existing.previousSessions,
        { conversationId: existing.mainConversationId, endedAt: now, reason },
      ],
    };
    assertValid(taken, "session takeover");
    await writeFileAtomic(sPath, serialize(taken));
    return {
      session: taken,
      status: forceTakeover ? "took_over_forced" : "took_over_stale_session",
    };
  });
}

/**
 * True ONLY when `.asd/session.json` exists, validates, and its
 * `mainConversationId` equals `conversationId`. Hooks rely on this so
 * subagent sessions are NEVER treated as the main Orchestrator.
 * @param {string} workspaceRoot
 * @param {string} conversationId
 * @returns {boolean}
 */
export function isMainOrchestratorSession(workspaceRoot, conversationId) {
  if (typeof conversationId !== "string" || conversationId.length === 0) {
    return false;
  }
  const session = readJsonSafe(sessionPath(workspaceRoot), null);
  if (session === null || !validateSession(session).ok) return false;
  return session.mainConversationId === conversationId;
}
