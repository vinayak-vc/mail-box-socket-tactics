/**
 * ServiceRunner.js
 * CLI and background daemon runner for the Event Broker and Agent Adapters.
 * Handles process lifecycle, PID management, configuration loading, .env parsing,
 * and graceful shutdown with state preservation.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const EventBroker = require('../broker/EventBroker');
const ZrokManager = require('./ZrokManager');
const ClaudeAdapter = require('../adapters/ClaudeAdapter');
const CodexAdapter = require('../adapters/CodexAdapter');
const AntigravityAdapter = require('../adapters/AntigravityAdapter');
const { normalizeProjects } = require('../config/ProjectConfig');

const CONFIG_PATH = path.resolve(__dirname, '../../config/default.json');
const ENV_PATH = path.resolve(__dirname, '../../config/.env');
const PID_PATH = path.resolve(__dirname, '../../.service.pid');

/**
 * Loads .env file if it exists
 */
function loadDotEnv() {
  if (fs.existsSync(ENV_PATH)) {
    try {
      const content = fs.readFileSync(ENV_PATH, 'utf8');
      const lines = content.split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx !== -1) {
          const key = trimmed.substring(0, eqIdx).trim();
          const val = trimmed.substring(eqIdx + 1).trim();
          if (!process.env[key]) {
            process.env[key] = val;
          }
        }
      }
    } catch (_) {}
  }
}

/**
 * Loads configuration with environment variable overrides
 */
function loadConfig() {
  loadDotEnv();

  let config = {};
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    } catch (err) {
      console.warn(`[ServiceRunner] Failed to parse ${CONFIG_PATH}: ${err.message}`);
    }
  }

  // Environment overrides
  if (process.env.MAILBOX_AUTH_TOKEN) config.broker.authToken = process.env.MAILBOX_AUTH_TOKEN;
  if (process.env.MAILBOX_WS_PORT) config.broker.port = parseInt(process.env.MAILBOX_WS_PORT, 10);
  if (process.env.MAILBOX_HTTP_PORT) config.broker.httpPort = parseInt(process.env.MAILBOX_HTTP_PORT, 10);
  // MAILBOX_PATH overrides the legacy single mailbox, or the default project's mailbox
  if (process.env.MAILBOX_PROJECT) config.defaultProject = process.env.MAILBOX_PROJECT.trim().toLowerCase();
  if (process.env.MAILBOX_PATH) {
    if (config.projects && Object.keys(config.projects).length > 0) {
      const id = config.defaultProject || Object.keys(config.projects)[0];
      if (config.projects[id]) {
        config.projects[id].mailbox = { ...(config.projects[id].mailbox || {}), path: process.env.MAILBOX_PATH };
      }
    } else {
      config.mailbox = { ...(config.mailbox || {}), path: process.env.MAILBOX_PATH };
    }
  }

  if (process.env.ZROK_TOKEN) {
    if (!config.zrok) config.zrok = {};
    config.zrok.token = process.env.ZROK_TOKEN;
    if (config.zrok.enabled === undefined) config.zrok.enabled = true;
  }
  if (process.env.ZROK_BIN) {
    if (!config.zrok) config.zrok = {};
    config.zrok.binPath = process.env.ZROK_BIN;
  }

  // The auth token is a secret: it must come from config/.env (or the environment), never a default
  const tok = config.broker && config.broker.authToken;
  if (!tok || tok === 'mailbox-socket-secret-token') {
    throw new Error('MAILBOX_AUTH_TOKEN is not set (or is the old default). Set a random value in config/.env before starting.');
  }

  // Normalize "projects" (or the legacy single "mailbox") into a validated project list.
  // Fallback paths are applied here; missing mailboxes are reported, not created.
  const { defaultProject, projects } = normalizeProjects(config);
  if (projects.length === 0) {
    throw new Error('No mailbox configured: add a "projects" map (or a legacy "mailbox" block) to config/default.json.');
  }
  for (const p of projects) {
    if (p.usingFallback) {
      console.log(`[ServiceRunner] [${p.id}] Primary mailbox not found, using fallback: ${p.mailboxPath}`);
    } else if (!fs.existsSync(p.mailboxPath)) {
      console.warn(`[ServiceRunner] [${p.id}] Warning: Configured mailbox does not exist at '${p.mailboxPath}'`);
    }
  }
  config.projectList = projects;
  config.defaultProject = defaultProject;
  const def = projects.find(p => p.id === defaultProject) || projects[0];
  // Legacy consumers (adapters) read config.mailbox: point it at the default project
  config.mailbox = { ...(config.mailbox || {}), path: def.mailboxPath, mutexName: def.mutexName, projectId: def.id, headerFormat: def.headerFormat };

  return config;
}

function isPidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

async function queryStatus(httpPort = 8766) {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:${httpPort}/status`, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (_) {
          resolve(data);
        }
      });
    });
    req.on('error', err => reject(err));
  });
}

async function main() {
  const args = process.argv.slice(2);
  const mode = args[0] || '--all';

  if (mode === '--status') {
    const config = loadConfig();
    try {
      const status = await queryStatus(config.broker.httpPort);
      console.log('\n=== MailBox Socket Tactics Status ===');
      console.log(JSON.stringify(status, null, 2));
      process.exit(0);
    } catch (err) {
      console.log('\n[ServiceRunner] Service is NOT running or HTTP port unreachable: ' + err.message);
      process.exit(1);
    }
  }

  if (mode === '--stop') {
    // Release any lingering zrok cloud shares
    try {
      const config = loadConfig();
      const zrokManager = new ZrokManager({
        binPath: config.zrok?.binPath,
        target: config.zrok?.target || `http://127.0.0.1:${config.broker?.httpPort || 8766}`,
        token: config.zrok?.token || process.env.ZROK_TOKEN,
        enabled: true
      });
      zrokManager.cleanupStaleShares();
    } catch (_) {}

    if (fs.existsSync(PID_PATH)) {
      const pid = parseInt(fs.readFileSync(PID_PATH, 'utf8').trim(), 10);
      if (isPidAlive(pid)) {
        try {
          process.kill(pid, 'SIGINT');
          console.log(`[ServiceRunner] Sent SIGINT to process PID ${pid}`);
        } catch (err) {
          console.error(`[ServiceRunner] Failed to stop process ${pid}: ${err.message}`);
        }
      }
      try { fs.unlinkSync(PID_PATH); } catch (_) {}
    } else {
      console.log('[ServiceRunner] No .service.pid file found.');
    }
    process.exit(0);
  }

  // Prevent duplicate daemon execution
  if (fs.existsSync(PID_PATH)) {
    const existingPid = parseInt(fs.readFileSync(PID_PATH, 'utf8').trim(), 10);
    if (isPidAlive(existingPid)) {
      console.error(`[ServiceRunner] Service is already running with PID ${existingPid}. Aborting start.`);
      process.exit(1);
    } else {
      // Stale PID file
      try { fs.unlinkSync(PID_PATH); } catch (_) {}
    }
  }

  const config = loadConfig();
  fs.writeFileSync(PID_PATH, String(process.pid), 'utf8');

  let broker = null;
  let zrokManager = null;
  const adapters = [];

  const startBroker = mode === '--broker' || mode === '--all';
  const startAdapters = mode === '--adapters' || mode === '--all';
  const enableZrok = args.includes('--zrok') || (config.zrok && config.zrok.enabled && process.env.NODE_ENV !== 'test');

  if (startBroker) {
    if (enableZrok) {
      zrokManager = new ZrokManager({
        binPath: config.zrok.binPath,
        target: config.zrok.target || `http://127.0.0.1:${config.broker.httpPort}`,
        token: config.zrok.token,
        enabled: true
      });
    }

    broker = new EventBroker({
      host: config.broker.host,
      port: config.broker.port,
      httpPort: config.broker.httpPort,
      authToken: config.broker.authToken,
      heartbeatIntervalMs: config.broker.heartbeatIntervalMs,
      clientTimeoutMs: config.broker.clientTimeoutMs,
      leaseTimeoutMs: config.broker.leaseTimeoutMs,
      maxRetries: config.broker.maxRetries,
      backoffInitialMs: config.broker.backoffInitialMs,
      projectList: config.projectList,
      defaultProject: config.defaultProject,
      zrokManager
    });

    await broker.start();

    if (zrokManager) {
      // Start zrok tunnel asynchronously so broker is available immediately
      zrokManager.start().catch((err) => {
        console.warn(`[ServiceRunner] zrok tunnel startup error: ${err.message}`);
      });
    }
  }

  if (startAdapters) {
    const brokerUrl = `ws://${config.broker.host}:${config.broker.port}`;

    if (config.agents.Claude && config.agents.Claude.enabled) {
      const claude = new ClaudeAdapter({
        ...config.agents.Claude,
        statePath: path.resolve(__dirname, '../../data/adapter_state_Claude.json'),
        dispatchBroadcast: config.agents.Claude.dispatchBroadcast === true,
        brokerUrl,
        authToken: config.broker.authToken,
        mailboxPath: config.mailbox.path,
        projectId: config.mailbox.projectId,
        headerFormat: config.mailbox.headerFormat
      });
      claude.start();
      adapters.push(claude);
    }

    if (config.agents.Codex && config.agents.Codex.enabled) {
      const codex = new CodexAdapter({
        ...config.agents.Codex,
        statePath: path.resolve(__dirname, '../../data/adapter_state_Codex.json'),
        dispatchBroadcast: config.agents.Codex.dispatchBroadcast === true,
        brokerUrl,
        authToken: config.broker.authToken,
        mailboxPath: config.mailbox.path,
        projectId: config.mailbox.projectId,
        headerFormat: config.mailbox.headerFormat
      });
      codex.start();
      adapters.push(codex);
    }

    if (config.agents.Antigravity && config.agents.Antigravity.enabled) {
      const antigravity = new AntigravityAdapter({
        ...config.agents.Antigravity,
        statePath: path.resolve(__dirname, '../../data/adapter_state_Antigravity.json'),
        dispatchBroadcast: config.agents.Antigravity.dispatchBroadcast === true,
        brokerUrl,
        authToken: config.broker.authToken,
        mailboxPath: config.mailbox.path,
        projectId: config.mailbox.projectId,
        headerFormat: config.mailbox.headerFormat
      });
      antigravity.start();
      adapters.push(antigravity);
    }
  }

  console.log(`[ServiceRunner] MailBox Socket Tactics running (PID: ${process.pid}) in mode ${mode}`);

  const shutdown = async () => {
    console.log('\n[ServiceRunner] Initiating shutdown...');
    if (zrokManager) {
      await zrokManager.stop();
    }
    for (const adapter of adapters) {
      adapter.stop();
    }
    if (broker) {
      await broker.stop();
    }
    if (fs.existsSync(PID_PATH)) {
      try { fs.unlinkSync(PID_PATH); } catch (_) {}
    }
    console.log('[ServiceRunner] Shutdown complete.');
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (require.main === module) {
  main().catch(err => {
    console.error(`[ServiceRunner] Fatal startup error: ${err.message}\n${err.stack}`);
    if (fs.existsSync(PID_PATH)) {
      try { fs.unlinkSync(PID_PATH); } catch (_) {}
    }
    process.exit(1);
  });
}

module.exports = { main, loadConfig };
