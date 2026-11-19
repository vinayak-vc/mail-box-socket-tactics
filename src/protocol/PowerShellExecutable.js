/**
 * PowerShellExecutable.js
 * Resolves which PowerShell to launch for the mailbox scripts.
 *
 * On Windows this is the built-in Windows PowerShell, exactly as before. Elsewhere (macOS, Linux)
 * there is no powershell.exe, so the scripts run under PowerShell 7 ("pwsh"). A process started by
 * an editor or an MCP host often has a short PATH that omits per-user install folders, so the usual
 * install locations are checked directly rather than relying on PATH alone.
 *
 * Override with the MAILBOX_POWERSHELL environment variable (an absolute path or a command name).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

let cached = null;
let cachedTempDir = null;

function candidatePaths() {
  const home = os.homedir();
  return [
    path.join(home, '.local', 'bin', 'pwsh'),
    '/opt/homebrew/bin/pwsh',
    '/usr/local/bin/pwsh',
    '/usr/local/microsoft/powershell/7/pwsh',
    '/usr/bin/pwsh'
  ];
}

function isExecutable(filePath) {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * Returns the PowerShell executable to pass to spawn/execFile.
 * Never throws: if nothing is found it returns 'pwsh', so the caller's spawn error names the problem.
 */
function resolvePowerShellExecutable() {
  if (cached) {
    return cached;
  }

  const override = process.env.MAILBOX_POWERSHELL;
  if (override && override.trim()) {
    cached = override.trim();
    return cached;
  }

  if (process.platform === 'win32') {
    cached = 'powershell.exe';
    return cached;
  }

  const found = candidatePaths().find(isExecutable);
  cached = found || 'pwsh';
  return cached;
}

/**
 * The per-user temporary folder an interactive shell would have. On macOS that is the
 * DARWIN_USER_TEMP_DIR under /var/folders, not /tmp.
 */
function resolveTempDir() {
  if (cachedTempDir) {
    return cachedTempDir;
  }

  if (process.platform === 'darwin') {
    try {
      const darwinTemp = execFileSync('getconf', ['DARWIN_USER_TEMP_DIR'], { encoding: 'utf8' }).trim();
      if (darwinTemp) {
        cachedTempDir = darwinTemp;
        return cachedTempDir;
      }
    } catch (e) {}
  }

  cachedTempDir = os.tmpdir();
  return cachedTempDir;
}

/**
 * Environment for a PowerShell child process.
 *
 * Off Windows, .NET keeps named mutexes as files under TMPDIR. A process started by an app (such as
 * an MCP host) may have no TMPDIR, and the mailbox script's named mutex then fails with
 * `lstat("") == ENOENT`. Filling it in with the user's normal temp folder also means the lock is the
 * same one an agent posting from a terminal takes, so the two exclude each other.
 */
function powerShellEnvironment() {
  const env = Object.assign({}, process.env);
  if (process.platform !== 'win32' && !env.TMPDIR) {
    env.TMPDIR = resolveTempDir();
  }
  return env;
}

module.exports = { resolvePowerShellExecutable, powerShellEnvironment };
