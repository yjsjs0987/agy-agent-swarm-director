// @ts-check
/**
 * Windows-safe atomic file I/O, BOM/CRLF normalization, and lockfile primitives.
 *
 * Dependency-free module: must NOT import from sibling lib modules.
 * All public writes to final paths go through tmp + fsync + rename
 * (except `appendJsonLine`, whose append semantics require in-place writes).
 */

import fs from "node:fs";
import path from "node:path";

/** @param {number} ms @returns {Promise<void>} */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {unknown} e
 * @returns {string | undefined}
 */
function errorCode(e) {
  if (e && typeof e === "object" && "code" in e && typeof e.code === "string") {
    return e.code;
  }
  return undefined;
}

/** Error thrown when a lock cannot be acquired within `timeoutMs`. */
export class LockTimeoutError extends Error {
  /** @type {string} */ lockPath;
  /** @type {number} */ timeoutMs;
  /** @type {string} */ code;
  /**
   * @param {string} lockPath
   * @param {number} timeoutMs
   */
  constructor(lockPath, timeoutMs) {
    super(`LOCK_TIMEOUT: could not acquire ${lockPath} within ${timeoutMs}ms`);
    this.name = "LockTimeoutError";
    this.code = "LOCK_TIMEOUT";
    this.lockPath = lockPath;
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Strips a leading UTF-8 BOM (`\uFEFF`) and normalizes `\r\n` to `\n`.
 * @param {string} str
 * @returns {string}
 */
export function normalizeText(str) {
  const stripped = str.charCodeAt(0) === 0xfeff ? str.slice(1) : str;
  return stripped.replace(/\r\n/g, "\n");
}

/**
 * Resolves to an absolute path, converts `\` to `/`, and lowercases on
 * Windows so path comparisons are separator- and case-stable.
 * @param {string} p
 * @returns {string}
 */
export function normalizePathForCompare(p) {
  const resolved = path.resolve(p).replace(/\\/g, "/");
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/**
 * True only when the resolved `targetPath` stays strictly inside the
 * resolved `parentDir` (trailing-slash-safe prefix match). Rejects
 * traversal like `<parent>/../outside` and sibling prefixes like
 * `<parent>-backup/`.
 * @param {string} parentDir
 * @param {string} targetPath
 * @returns {boolean}
 */
export function isSubpath(parentDir, targetPath) {
  const parent = normalizePathForCompare(parentDir);
  const target = normalizePathForCompare(targetPath);
  const prefix = parent.endsWith("/") ? parent : parent + "/";
  return target.startsWith(prefix);
}

/**
 * @typedef {Object} FileLockOptions
 * @property {number} [timeoutMs] Give up after this many ms (default 15000).
 * @property {number} [staleMs] Evict locks older than this (default 20000).
 * @property {number} [retryDelayMs] Base retry delay in ms (default 25).
 */

/**
 * Decides whether the lock at `lockPath` is evictable: older than `staleMs`,
 * or corrupt (a crashed writer). An empty file is treated as just-created
 * (live) so a cross-process read never races a fresh `open("wx")` into eviction.
 * @param {string} lockPath
 * @param {number} staleMs
 * @returns {boolean}
 */
function isLockStale(lockPath, staleMs) {
  let raw;
  try {
    raw = fs.readFileSync(lockPath, "utf8");
  } catch {
    return false; // unreadable (e.g. raced eviction) -> let the retry loop decide
  }
  if (raw.trim().length === 0) return false;
  let info;
  try {
    info = JSON.parse(normalizeText(raw));
  } catch {
    return true; // corrupt -> crashed writer, evict
  }
  if (!info || typeof info !== "object" || typeof info.createdAt !== "string") {
    return true;
  }
  const createdAt = Date.parse(info.createdAt);
  if (!Number.isFinite(createdAt)) return true;
  return Date.now() - createdAt > staleMs;
}

/**
 * Runs `fn` under an exclusive lockfile at `lockPath`.
 *
 * Acquisition uses `fs.open(lockPath, "wx")` (O_EXCL) and writes
 * `{ pid, createdAt }`. On EEXIST it retries with randomized jitter
 * (`retryDelayMs + 20 + Math.floor(Math.random() * 31)` ms) so 8 concurrent
 * Windows processes avoid thundering-herd LOCK_TIMEOUT. Stale locks
 * (age > `staleMs`, or corrupt) are unlinked and the acquire retries.
 * Rejects with {@link LockTimeoutError} after `timeoutMs`. The lock is
 * ALWAYS unlinked in `finally` when we own it.
 *
 * ponytail: sync open+write keeps the create->write window race-free
 * in-process; a critical section running longer than staleMs could be
 * evicted by another waiter — keep lock-held work under seconds.
 *
 * @template T
 * @param {string} lockPath
 * @param {() => T | Promise<T>} fn
 * @param {FileLockOptions} [options]
 * @returns {Promise<T>}
 */
export async function withFileLock(lockPath, fn, options = {}) {
  const timeoutMs = options.timeoutMs ?? 15000;
  const staleMs = options.staleMs ?? 20000;
  const retryDelayMs = options.retryDelayMs ?? 25;
  const deadline = Date.now() + timeoutMs;
  let owned = false;
  try {
    while (!owned) {
      let fd = null;
      try {
        fd = fs.openSync(lockPath, "wx");
        owned = true;
        fs.writeFileSync(
          fd,
          JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }) + "\n"
        );
        fs.fsyncSync(fd);
      } catch (e) {
        if (errorCode(e) !== "EEXIST") throw e;
        if (Date.now() > deadline) throw new LockTimeoutError(lockPath, timeoutMs);
        if (isLockStale(lockPath, staleMs)) {
          try {
            fs.unlinkSync(lockPath);
          } catch {
            /* raced: another waiter evicted it first */
          }
          continue;
        }
        await sleep(retryDelayMs + 20 + Math.floor(Math.random() * 31));
      } finally {
        if (fd !== null) {
          try {
            fs.closeSync(fd);
          } catch {
            /* ignore close races */
          }
        }
      }
    }
    return await fn();
  } finally {
    if (owned) {
      try {
        fs.unlinkSync(lockPath);
      } catch {
        /* already gone */
      }
    }
  }
}

/**
 * Writes `content` to `filePath` via `<filePath>.<pid>.<random>.tmp` +
 * fsync + rename. On Windows EPERM/EBUSY/EACCES the rename is retried
 * up to 5 times with exponential backoff (`25ms * 2^n` + jitter).
 * The tmp file is always cleaned up on failure.
 * @param {string} filePath
 * @param {string | Buffer} content
 * @returns {Promise<void>}
 */
export async function writeFileAtomic(filePath, content) {
  const tmpPath = `${filePath}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  let fd = null;
  try {
    fd = fs.openSync(tmpPath, "w");
    fs.writeFileSync(fd, content);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    for (let attempt = 0; ; attempt++) {
      try {
        fs.renameSync(tmpPath, filePath);
        return;
      } catch (e) {
        const code = errorCode(e);
        const retryable = code === "EPERM" || code === "EBUSY" || code === "EACCES";
        if (!retryable || attempt >= 5) throw e;
        await sleep(25 * 2 ** attempt + Math.floor(Math.random() * 25));
      }
    }
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      /* renamed away on success, or never created */
    }
  }
}

/**
 * Reads and parses JSON from `filePath` (after {@link normalizeText}),
 * returning `fallback` on ANY error (missing file, corrupt JSON, ...).
 * @template T
 * @param {string} filePath
 * @param {T} fallback
 * @returns {any | T}
 */
export function readJsonSafe(filePath, fallback) {
  try {
    return JSON.parse(normalizeText(fs.readFileSync(filePath, "utf8")));
  } catch {
    return fallback;
  }
}

/**
 * Appends one JSON line to `filePath`, creating the file when missing and
 * inserting a newline first when the existing tail lacks one.
 * (Append semantics cannot use tmp+rename; in-place appendFileSync is
 * intentional and is not a writeFileSync to a final path.)
 * @param {string} filePath
 * @param {unknown} obj
 * @returns {void}
 */
export function appendJsonLine(filePath, obj) {
  let prefix = "";
  try {
    const size = fs.statSync(filePath).size;
    if (size > 0) {
      const fd = fs.openSync(filePath, "r");
      try {
        const tail = Buffer.alloc(1);
        fs.readSync(fd, tail, 0, 1, size - 1);
        if (tail[0] !== 0x0a) prefix = "\n";
      } finally {
        fs.closeSync(fd);
      }
    }
  } catch (e) {
    if (errorCode(e) !== "ENOENT") throw e;
  }
  fs.appendFileSync(filePath, prefix + JSON.stringify(obj) + "\n");
}

/** Exact 4-line content of `<workspaceRoot>/<dirName>/.gitignore`. */
const ASD_GITIGNORE_CONTENT = "session.json\nledger.jsonl\n*.lock\n*.tmp\n";

/**
 * Creates `<workspaceRoot>/<dirName>/` with `history/` and `reports/`
 * subdirectories plus a `.gitignore` covering plugin-managed volatile
 * files. NEVER touches `<workspaceRoot>/.gitignore`. Idempotent: an
 * existing `<dirName>/.gitignore` is preserved as-is.
 * @param {string} workspaceRoot
 * @param {string} [dirName] Default ".asd" (kept as a parameter so this
 *   module stays standalone — it must not import ASD_DIR_NAME).
 * @returns {Promise<string>} The created `.asd` directory path.
 */
export async function ensureAsdDir(workspaceRoot, dirName = ".asd") {
  const asdDir = path.join(workspaceRoot, dirName);
  fs.mkdirSync(path.join(asdDir, "history"), { recursive: true });
  fs.mkdirSync(path.join(asdDir, "reports"), { recursive: true });
  const gitignorePath = path.join(asdDir, ".gitignore");
  if (!fs.existsSync(gitignorePath)) {
    await writeFileAtomic(gitignorePath, ASD_GITIGNORE_CONTENT);
  }
  return asdDir;
}
