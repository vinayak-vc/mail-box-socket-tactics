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
const ClaudeAdapter = require('../adapters/ClaudeAdapter');
const CodexAdapter = require('../adapters/CodexAdapter');
const AntigravityAdapter = require('../adapters/AntigravityAdapter');

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
  if (process.env.MAILBOX_PATH) config.mailbox.path = process.env.MAILBOX_PATH;

  // Validate authoritative mailbox path
  if (!fs.existsSync(config.mailbox.path)) {
    if (config.mailbox.fallbackPath && fs.existsSync(config.mailbox.fallbackPath)) {
      console.log(`[ServiceRunner] Primary mailbox not found, using fallback: ${config.mailbox.fallbackPath}`);
      config.mailbox.path = config.mailbox.fallbackPath;
    } else {
      console.warn(`[ServiceRunner] Warning: Configured mailbox does not exist at '${config.mailbox.path}'`);
    }
  }

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
  const adapters = [];

  const startBroker = mode === '--broker' || mode === '--all';
  const startAdapters = mode === '--adapters' || mode === '--all';

  if (startBroker) {
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
      mailbox: config.mailbox
    });

    await broker.start();
  }

  if (startAdapters) {
    const brokerUrl = `ws://${config.broker.host}:${config.broker.port}`;

    if (config.agents.Claude && config.agents.Claude.enabled) {
      const claude = new ClaudeAdapter({
        ...config.agents.Claude,
        brokerUrl,
        authToken: config.broker.authToken,
        mailboxPath: config.mailbox.path
      });
      claude.start();
      adapters.push(claude);
    }

    if (config.agents.Codex && config.agents.Codex.enabled) {
      const codex = new CodexAdapter({
        ...config.agents.Codex,
        brokerUrl,
        authToken: config.broker.authToken,
        mailboxPath: config.mailbox.path
      });
      codex.start();
      adapters.push(codex);
    }

    if (config.agents.Antigravity && config.agents.Antigravity.enabled) {
      const antigravity = new AntigravityAdapter({
        ...config.agents.Antigravity,
        brokerUrl,
        authToken: config.broker.authToken,
        mailboxPath: config.mailbox.path
      });
      antigravity.start();
      adapters.push(antigravity);
    }
  }

  console.log(`[ServiceRunner] MailBox Socket Tactics running (PID: ${process.pid}) in mode ${mode}`);

  const shutdown = async () => {
    console.log('\n[ServiceRunner] Initiating shutdown...');
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
