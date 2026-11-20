/**
 * FileLock.js
 * Small synchronous cross-process lock built on an exclusive lock file (`<target>.lock`),
 * plus an atomic JSON write (temp file + rename).
 *
 * Why: several processes (the broker and one MCP server per desktop agent) share the same
 * JSON files. Each must re-read the file, change it and write it back while holding the lock,
 * otherwise the last writer silently discards everyone else's changes.
 *
 * Works on Windows, macOS and Linux with plain Node (no native modules).
 * Holders keep the lock for a few milliseconds, so waiting is a short spin with Atomics.wait.
 */

const fs = require('fs');
const path = require('path');

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM'; // exists, owned by someone else
  }
}

class FileLockTimeoutError extends Error {
  constructor(lockPath, timeoutMs) {
    super(`Could not acquire lock '${lockPath}' within ${timeoutMs} ms`);
    this.name = 'FileLockTimeoutError';
  }
}

/**
 * Runs fn() while holding an exclusive lock for targetPath. Returns fn's result.
 * A lock left by a dead process, or older than staleMs, is taken over.
 */
function withFileLockSync(targetPath, fn, { timeoutMs = 10000, staleMs = 30000 } = {}) {
  const lockPath = `${targetPath}.lock`;
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const token = `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`;
  const deadline = Date.now() + timeoutMs;
  let fd = null;

  while (fd === null) {
    try {
      fd = fs.openSync(lockPath, 'wx'); // fails with EEXIST while someone else holds it
      fs.writeSync(fd, token);
    } catch (err) {
      if (err.code !== 'EEXIST' && err.code !== 'EPERM' && err.code !== 'EBUSY') throw err;
      _removeIfStale(lockPath, staleMs);
      if (Date.now() > deadline) throw new FileLockTimeoutError(lockPath, timeoutMs);
      sleepSync(5 + Math.floor(Math.random() * 10));
    }
  }

  try {
    return fn();
  } finally {
    try { fs.closeSync(fd); } catch (_) {}
    // Only delete the lock if it is still ours (it could have been taken over as stale)
    try {
      if (fs.readFileSync(lockPath, 'utf8') === token) fs.unlinkSync(lockPath);
    } catch (_) {}
  }
}

function _removeIfStale(lockPath, staleMs) {
  let content;
  let stat;
  try {
    content = fs.readFileSync(lockPath, 'utf8');
    stat = fs.statSync(lockPath);
  } catch (_) {
    return; // already gone, or being created right now
  }
  const pid = parseInt(String(content).split(':')[0], 10);
  const ageMs = Date.now() - stat.mtimeMs;
  // An empty file is a lock whose owner is between open and write: never stale unless very old
  const ownerDead = content && !isProcessAlive(pid);
  if (!ownerDead && ageMs < staleMs) return;
  try {
    // Re-check right before removal so we never delete a lock someone just took over
    if (fs.readFileSync(lockPath, 'utf8') === content) fs.unlinkSync(lockPath);
  } catch (_) {}
}

/**
 * Writes JSON atomically: readers see either the old or the new file, never a half-written one.
 * Retries the rename briefly because Windows refuses it while another process has the file open.
 */
function writeJsonAtomicSync(targetPath, data) {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const tmpPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf8');
  for (let attempt = 1; ; attempt++) {
    try {
      fs.renameSync(tmpPath, targetPath);
      return;
    } catch (err) {
      if (attempt >= 50 || !['EPERM', 'EBUSY', 'EACCES'].includes(err.code)) {
        try { fs.unlinkSync(tmpPath); } catch (_) {}
        throw err;
      }
      sleepSync(10);
    }
  }
}

module.exports = { withFileLockSync, writeJsonAtomicSync, FileLockTimeoutError, isProcessAlive };
