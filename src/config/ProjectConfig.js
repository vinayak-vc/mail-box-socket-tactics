/**
 * ProjectConfig.js
 * Normalizes the project/mailbox section of config/default.json into a list of
 * project definitions so one broker, dashboard and MCP server can serve several
 * projects (each with its own mailbox, mutex, state file and board).
 *
 * Supported config shapes:
 *
 *   1. Multi-project (preferred):
 *      "defaultProject": "onebossfight",
 *      "projects": {
 *        "onebossfight": { "name": "OneBossFight", "mailbox": { "path": "...", "mutexName": "...", "fallbackPath": "..." } },
 *        "musical-tambola": { "name": "Media Tambola", "mailbox": { "path": "...", "headerFormat": "tel" } }
 *      }
 *      Mailbox fields may also be given flat on the project ("mailboxPath", "mutexName", ...).
 *
 *   2. Legacy single mailbox (still supported, treated as one project):
 *      "mailbox": { "path": "...", "fallbackPath": "...", "mutexName": "..." }
 *
 * When "projects" is present, the legacy "mailbox" block is ignored.
 */

const fs = require('fs');
const path = require('path');
const { HEADER_FORMATS } = require('../protocol/MessageProtocol');

const PROJECT_ROOT = path.resolve(__dirname, '../..');
const DEFAULT_CONFIG_PATH = path.resolve(PROJECT_ROOT, 'config/default.json');

/** Id used for a project derived from the legacy single "mailbox" block */
const LEGACY_PROJECT_ID = 'default';
const DEFAULT_MUTEX_NAME = 'Global\\OneBossFightMailbox';
const PROJECT_ID_REGEX = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** Resolves a possibly relative path against the MailSocket repository root */
function resolveFromRoot(p, root = PROJECT_ROOT) {
  if (!p) return null;
  return path.isAbsolute(p) ? path.normalize(p) : path.resolve(root, p);
}

/** Case-insensitive, separator-insensitive path comparison key (Windows friendly) */
function pathKey(p) {
  if (!p) return '';
  return path.resolve(String(p)).replace(/[\\/]+/g, '/').toLowerCase();
}

function validateProjectId(id) {
  if (typeof id !== 'string' || !PROJECT_ID_REGEX.test(id)) {
    throw new Error(`Invalid project id '${id}': use 1-64 lowercase letters, digits, '-' or '_' (must start with a letter or digit).`);
  }
}

/**
 * Builds one normalized project definition.
 * @param {string} id
 * @param {object} raw - project block from config
 * @param {object} opts - { root, legacy }
 */
function normalizeProject(id, raw = {}, opts = {}) {
  validateProjectId(id);
  const root = opts.root || PROJECT_ROOT;
  const mb = (raw.mailbox && typeof raw.mailbox === 'object') ? raw.mailbox : {};

  const mailboxPath = mb.path || raw.mailboxPath || raw.path || null;
  if (!mailboxPath) {
    throw new Error(`Project '${id}' has no mailbox path (set projects.${id}.mailbox.path).`);
  }

  const headerFormat = (mb.headerFormat || raw.headerFormat || 'broker').toLowerCase();
  if (!HEADER_FORMATS.includes(headerFormat)) {
    throw new Error(`Project '${id}' has unknown headerFormat '${headerFormat}'. Supported: ${HEADER_FORMATS.join(', ')}.`);
  }

  // Legacy single-mailbox installs keep their original data files so nothing is lost on upgrade.
  const defaultState = opts.legacy ? 'data/mailbox_state.json' : `data/projects/${id}/mailbox_state.json`;
  const defaultBoard = opts.legacy ? 'data/board.json' : `data/projects/${id}/board.json`;

  const fallbackPath = mb.fallbackPath || raw.fallbackPath || null;
  const configuredPath = resolveFromRoot(mailboxPath, root);
  let effectivePath = configuredPath;
  let usingFallback = false;
  if (!fs.existsSync(configuredPath) && fallbackPath && fs.existsSync(resolveFromRoot(fallbackPath, root))) {
    effectivePath = resolveFromRoot(fallbackPath, root);
    usingFallback = true;
  }

  return {
    id,
    name: raw.name || id,
    mailboxPath: effectivePath,
    configuredMailboxPath: configuredPath,
    fallbackPath: fallbackPath ? resolveFromRoot(fallbackPath, root) : null,
    usingFallback,
    mutexName: mb.mutexName || raw.mutexName || DEFAULT_MUTEX_NAME,
    headerFormat,
    pollFallbackMs: mb.pollFallbackMs || raw.pollFallbackMs || undefined,
    statePath: resolveFromRoot(raw.statePath || defaultState, root),
    boardPath: resolveFromRoot(raw.boardPath || defaultBoard, root),
    docsDir: raw.docsDir ? resolveFromRoot(raw.docsDir, root) : null,
    workingDir: raw.workingDir || null,
    legacy: Boolean(opts.legacy)
  };
}

/**
 * Normalizes a full config object into { defaultProject, projects: [...] }.
 * Returns an empty project list when neither "projects" nor "mailbox" is configured.
 */
function normalizeProjects(config = {}, opts = {}) {
  const root = opts.root || PROJECT_ROOT;
  const projects = [];

  if (config.projects && typeof config.projects === 'object' && Object.keys(config.projects).length > 0) {
    for (const [id, raw] of Object.entries(config.projects)) {
      projects.push(normalizeProject(id, raw, { root }));
    }
  } else if (config.mailbox && (config.mailbox.path || config.mailbox.mailboxPath)) {
    const id = config.mailbox.projectId || LEGACY_PROJECT_ID;
    projects.push(normalizeProject(id, {
      name: config.mailbox.projectName || config.mailbox.name || 'Default',
      mailbox: config.mailbox,
      statePath: config.mailbox.statePath,
      boardPath: config.mailbox.boardPath,
      docsDir: config.mailbox.docsDir
    }, { root, legacy: true }));
  }

  const seen = new Set();
  for (const p of projects) {
    if (seen.has(p.id)) throw new Error(`Duplicate project id '${p.id}'.`);
    seen.add(p.id);
  }

  let defaultProject = config.defaultProject || (projects[0] ? projects[0].id : null);
  if (defaultProject && projects.length > 0 && !seen.has(defaultProject)) {
    throw new Error(`defaultProject '${defaultProject}' is not defined in "projects" (known: ${[...seen].join(', ')}).`);
  }

  return { defaultProject, projects };
}

/** Reads and parses a JSON config file; returns {} when missing. Throws on invalid JSON. */
function readConfigFile(configPath = DEFAULT_CONFIG_PATH) {
  if (!fs.existsSync(configPath)) return {};
  const text = fs.readFileSync(configPath, 'utf8');
  return text.trim() ? JSON.parse(text) : {};
}

/** Finds a project whose configured or effective mailbox path equals the given path */
function findProjectByMailboxPath(projects, mailboxPath) {
  const key = pathKey(mailboxPath);
  if (!key) return null;
  return projects.find(p => pathKey(p.mailboxPath) === key || pathKey(p.configuredMailboxPath) === key) || null;
}

module.exports = {
  LEGACY_PROJECT_ID,
  DEFAULT_MUTEX_NAME,
  DEFAULT_CONFIG_PATH,
  PROJECT_ID_REGEX,
  normalizeProject,
  normalizeProjects,
  readConfigFile,
  findProjectByMailboxPath,
  pathKey,
  resolveFromRoot,
  validateProjectId
};
