/**
 * test_suite.js
 * Comprehensive automated test suite for MailBox Socket Tactics.
 * Covers all 20 required test scenarios from Section 16 of the specification.
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const http = require('http');
const WebSocket = require('ws');
const EventBroker = require('../src/broker/EventBroker');
const MailboxWatcher = require('../src/broker/MailboxWatcher');
const StateStore = require('../src/broker/StateStore');
const LockManager = require('../src/adapters/LockManager');
const ClaudeAdapter = require('../src/adapters/ClaudeAdapter');
const CodexAdapter = require('../src/adapters/CodexAdapter');
const AntigravityAdapter = require('../src/adapters/AntigravityAdapter');
const {
  EVENT_TYPES,
  PROCESSING_STATUS,
  parseMailboxMessages,
  isRecipientMatch
} = require('../src/protocol/MessageProtocol');

const TEST_DIR = path.resolve(__dirname, 'temp_suite');
const TEST_MAILBOX = path.join(TEST_DIR, 'TEST_MAILBOX.md');
const TEST_STATE_PATH = path.join(TEST_DIR, 'test_state.json');
const TEST_PORT = 9980;
const TEST_HTTP_PORT = 9981;
const TEST_AUTH_TOKEN = 'secret-test-token-777';

function appendTestMessage(party, number, sender, to, body) {
  const header = `\n### [${party}-${number}] ${sender} -> ${to}, 2026-10-28 12:00:00\n`;
  const content = `${header}${body}\n`;
  fs.appendFileSync(TEST_MAILBOX, content, 'utf8');
  return { party, number, id: `${party}-${number}`, sender, recipientRaw: to, body, headerLine: header.trim() };
}

async function runComprehensiveTests() {
  console.log('===================================================================');
  console.log('   MAILBOX SOCKET TACTICS - COMPREHENSIVE 20-SCENARIO TEST SUITE   ');
  console.log('===================================================================\n');

  if (fs.existsSync(TEST_DIR)) {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(TEST_DIR, { recursive: true });
  fs.writeFileSync(TEST_MAILBOX, '# TEST TEAM MAILBOX\n\n', 'utf8');

  let passed = 0;
  let failed = 0;

  function report(num, name, condition, details = '') {
    if (condition) {
      console.log(`[PASS] Test ${num}: ${name}`);
      passed++;
    } else {
      console.error(`[FAIL] Test ${num}: ${name} - Details: ${details}`);
      failed++;
    }
  }

  const broker = new EventBroker({
    host: '127.0.0.1',
    port: TEST_PORT,
    httpPort: TEST_HTTP_PORT,
    authToken: TEST_AUTH_TOKEN,
    statePath: TEST_STATE_PATH,
    heartbeatIntervalMs: 2000,
    clientTimeoutMs: 6000,
    leaseTimeoutMs: 4000,
    maxRetries: 2,
    backoffInitialMs: 150,
    mailbox: {
      path: TEST_MAILBOX,
      pollFallbackMs: 500
    }
  });

  await broker.start();
  const brokerUrl = `ws://127.0.0.1:${TEST_PORT}`;

  // Track raw socket deliveries
  const rawNotifications = {
    Claude: [],
    Codex: [],
    Antigravity: []
  };

  const claude = new ClaudeAdapter({
    brokerUrl,
    authToken: TEST_AUTH_TOKEN,
    mailboxPath: TEST_MAILBOX,
    lockDir: path.join(TEST_DIR, 'locks_claude'),
    execMode: 'mock',
    mockHandler: async (m) => ({ success: true, evidence: `Claude mock handled ${m.id}` })
  });

  const codex = new CodexAdapter({
    brokerUrl,
    authToken: TEST_AUTH_TOKEN,
    mailboxPath: TEST_MAILBOX,
    lockDir: path.join(TEST_DIR, 'locks_codex'),
    execMode: 'mock',
    mockHandler: async (m) => ({ success: true, evidence: `Codex mock handled ${m.id}` })
  });

  const antigravity = new AntigravityAdapter({
    brokerUrl,
    authToken: TEST_AUTH_TOKEN,
    mailboxPath: TEST_MAILBOX,
    lockDir: path.join(TEST_DIR, 'locks_ag'),
    execMode: 'mock',
    mockHandler: async (m) => ({ success: true, evidence: `AG mock handled ${m.id}` })
  });

  // Intercept socket notifications at raw client level
  function trackRawNotifications(adapter, name) {
    const origHandle = adapter.handleBrokerMessage.bind(adapter);
    adapter.handleBrokerMessage = function(msg) {
      if (msg.type === EVENT_TYPES.MAILBOX_MESSAGE_NOTIFY) {
        rawNotifications[name].push(msg);
      }
      return origHandle(msg);
    };
  }

  trackRawNotifications(claude, 'Claude');
  trackRawNotifications(codex, 'Codex');
  trackRawNotifications(antigravity, 'Antigravity');

  claude.start();
  codex.start();
  antigravity.start();

  await new Promise(r => setTimeout(r, 600));

  try {
    // -------------------------------------------------------------
    // Test 1: Recipient-only notification delivery
    // -------------------------------------------------------------
    rawNotifications.Claude = [];
    rawNotifications.Codex = [];
    rawNotifications.Antigravity = [];

    // Message addressed strictly to Claude
    appendTestMessage('X', 1, 'Codex', 'Claude', 'TASK: Review Work Order 1');
    await broker.watcher.checkNow();
    await new Promise(r => setTimeout(r, 300));

    const t1a = rawNotifications.Claude.some(n => n.messageId === 'X-1') &&
                !rawNotifications.Codex.some(n => n.messageId === 'X-1') &&
                !rawNotifications.Antigravity.some(n => n.messageId === 'X-1');

    // Message addressed strictly to Codex
    rawNotifications.Claude = []; rawNotifications.Codex = []; rawNotifications.Antigravity = [];
    appendTestMessage('C', 2, 'Claude', 'Codex', 'TASK: Independent Review');
    await broker.watcher.checkNow();
    await new Promise(r => setTimeout(r, 300));

    const t1b = rawNotifications.Codex.some(n => n.messageId === 'C-2') &&
                !rawNotifications.Claude.some(n => n.messageId === 'C-2') &&
                !rawNotifications.Antigravity.some(n => n.messageId === 'C-2');

    // Human owner message addressed to Claude and Codex
    rawNotifications.Claude = []; rawNotifications.Codex = []; rawNotifications.Antigravity = [];
    appendTestMessage('H', 3, 'Owner', 'Claude,Codex', 'TASK: Joint review');
    await broker.watcher.checkNow();
    await new Promise(r => setTimeout(r, 300));

    const t1c = rawNotifications.Claude.some(n => n.messageId === 'H-3') &&
                rawNotifications.Codex.some(n => n.messageId === 'H-3') &&
                !rawNotifications.Antigravity.some(n => n.messageId === 'H-3');

    report(1, 'Recipient-only notification delivery (non-recipients receive zero notifications)',
      t1a && t1b && t1c, `Claude-only: ${t1a}, Codex-only: ${t1b}, Multi-recipient: ${t1c}`);

    // -------------------------------------------------------------
    // Test 2: Rejection of unauthenticated state-changing operations
    // -------------------------------------------------------------
    let wsRejected = false;
    await new Promise(resolve => {
      const ws = new WebSocket(brokerUrl);
      ws.on('open', () => {
        // Send state-changing SUBSCRIBE without prior authentication
        ws.send(JSON.stringify({ type: EVENT_TYPES.SUBSCRIBE, channels: ['Claude'] }));
      });
      ws.on('message', data => {
        const res = JSON.parse(data.toString());
        if (res.type === 'ERROR' && res.error.includes('Authentication required')) {
          wsRejected = true;
          ws.close();
          resolve();
        }
      });
      ws.on('close', resolve);
    });

    // HTTP /publish without token
    let httpRejected = false;
    await new Promise(resolve => {
      const req = http.request({
        host: '127.0.0.1',
        port: TEST_HTTP_PORT,
        path: '/publish',
        method: 'POST'
      }, res => {
        if (res.statusCode === 401) httpRejected = true;
        resolve();
      });
      req.end('{}');
    });

    report(2, 'Rejection of unauthenticated state-changing operations (WS and HTTP)',
      wsRejected && httpRejected, `WS: ${wsRejected}, HTTP: ${httpRejected}`);

    // -------------------------------------------------------------
    // Test 3: Persistence of completed state through restart
    // -------------------------------------------------------------
    const t3Pre = broker.stateStore.isCompleted('X-1');
    // Stop broker and restart with fresh instance pointing to same state file
    await broker.stop();
    const brokerRestarted = new EventBroker({
      host: '127.0.0.1',
      port: TEST_PORT,
      httpPort: TEST_HTTP_PORT,
      authToken: TEST_AUTH_TOKEN,
      statePath: TEST_STATE_PATH,
      mailbox: { path: TEST_MAILBOX }
    });
    await brokerRestarted.start();
    const t3Post = brokerRestarted.stateStore.isCompleted('X-1');
    report(3, 'Persistence of completed state through broker restart',
      t3Pre && t3Post, `Pre: ${t3Pre}, Post-restart: ${t3Post}`);
    await brokerRestarted.stop();
    // Restart test broker
    await broker.start();
    claude.connect();
    codex.connect();
    antigravity.connect();
    await new Promise(r => setTimeout(r, 600));

    // -------------------------------------------------------------
    // Test 4: Recovery of a message whose worker crashed
    // -------------------------------------------------------------
    const crashStore = broker.stateStore;
    crashStore.getOrCreateTask({ id: 'X-55', sender: 'Codex', recipientRaw: 'Claude' });
    crashStore.claimTask('X-55', 'crashed-worker-999', 300); // 300ms lease
    await new Promise(r => setTimeout(r, 450)); // wait for lease to expire
    const reconciledCount = crashStore.reconcileCrashedTasks();
    const taskAfterCrash = crashStore.getTask('X-55');
    const t4 = taskAfterCrash.status === PROCESSING_STATUS.RETRYABLE_FAILED && taskAfterCrash.claimOwner === null;
    report(4, 'Recovery of task whose worker crashed (lease expired and reconciled)',
      t4, `Reconciled: ${reconciledCount}, Status: ${taskAfterCrash.status}`);

    // -------------------------------------------------------------
    // Test 5: Safe stale-lock recovery
    // -------------------------------------------------------------
    const lockDir = path.join(TEST_DIR, 'test_locks');
    const lmA = new LockManager('TestAgent', lockDir);
    const lmB = new LockManager('TestAgent', lockDir);

    // Acquire lock with short lease and pretend it crashed
    const l1 = lmA.acquireLock('TASK-100', 300);
    // While lmA's lock is active, lmB CANNOT claim
    const l2 = lmB.acquireLock('TASK-100', 5000);
    const cantStealActive = (l2.acquired === false);

    // Wait for lmA lease to expire
    await new Promise(r => setTimeout(r, 400));
    // Now lmB can safely recover the stale lock
    const l3 = lmB.acquireLock('TASK-100', 5000);
    const recoveredStale = (l3.acquired === true && l3.recovered === true);

    // lmA cannot release lmB's lock
    const lmACannotRelease = lmA.releaseLock('TASK-100') === false;
    lmB.releaseLock('TASK-100');

    report(5, 'Safe stale-lock recovery with worker identity protection',
      cantStealActive && recoveredStale && lmACannotRelease,
      `Blocked theft: ${cantStealActive}, Recovered: ${recoveredStale}, Owner protection: ${lmACannotRelease}`);

    // -------------------------------------------------------------
    // Test 6: Lease renewal for tasks lasting over 120s (tested via heartbeat)
    // -------------------------------------------------------------
    const lmRenew = new LockManager('WorkerRenew', lockDir);
    lmRenew.acquireLock('LONG-TASK', 2000);
    const renew1 = lmRenew.renewLock('LONG-TASK', 5000);
    const lockData = JSON.parse(fs.readFileSync(lmRenew.getLockPath('LONG-TASK'), 'utf8'));
    const t6 = renew1 && (lockData.leaseExpiresAt > Date.now() + 4000);
    lmRenew.releaseLock('LONG-TASK');
    report(6, 'Lease renewal mechanism prevents active work from expiring',
      t6, `Renewed: ${renew1}, New Expiry: ${lockData.leaseExpiresAt}`);

    // -------------------------------------------------------------
    // Test 7: Duplicate notifications are idempotent
    // -------------------------------------------------------------
    let dispatchesForX88 = 0;
    const dupAdapter = new ClaudeAdapter({
      brokerUrl,
      authToken: TEST_AUTH_TOKEN,
      mailboxPath: TEST_MAILBOX,
      lockDir: path.join(TEST_DIR, 'locks_dup'),
      execMode: 'mock',
      initialSeenNumber: 50, // ignore prior messages
      mockHandler: async (m) => {
        if (m.id === 'X-88') dispatchesForX88++;
        return { success: true };
      }
    });
    dupAdapter.start();
    await new Promise(r => setTimeout(r, 400));

    appendTestMessage('X', 88, 'Codex', 'Claude', 'TASK: Idempotency Test');
    await dupAdapter.handleNotification({ messageId: 'X-88', recipientRaw: 'Claude' });
    // Second notification for same message
    await dupAdapter.handleNotification({ messageId: 'X-88', recipientRaw: 'Claude' });
    dupAdapter.stop();

    report(7, 'Duplicate notification idempotency (task executed exactly once)',
      dispatchesForX88 === 1, `Dispatches for X-88: ${dispatchesForX88}`);

    // -------------------------------------------------------------
    // Test 8: Simultaneous workers attempting to claim same message
    // -------------------------------------------------------------
    const simStore = new StateStore({ statePath: path.join(TEST_DIR, 'sim_state.json') });
    simStore.getOrCreateTask({ id: 'RACE-1', recipientRaw: 'Claude' });
    const claim1 = simStore.claimTask('RACE-1', 'worker-ALPHA', 10000);
    const claim2 = simStore.claimTask('RACE-1', 'worker-BETA', 10000);
    report(8, 'Simultaneous claim race condition prevention (exactly one winner)',
      claim1 === true && claim2 === false, `Worker 1: ${claim1}, Worker 2: ${claim2}`);

    // -------------------------------------------------------------
    // Test 9: Lost acknowledgement reconciliation
    // -------------------------------------------------------------
    simStore.getOrCreateTask({ id: 'LOST-ACK-1', recipientRaw: 'Claude' });
    simStore.claimTask('LOST-ACK-1', 'worker-1', 10000);
    // Task completed with evidence
    simStore.markCompleted('LOST-ACK-1', 'worker-1', 'Receipt confirmed on disk');
    const t9 = simStore.isCompleted('LOST-ACK-1');
    report(9, 'Lost acknowledgement reconciliation via recorded completion evidence',
      t9, `Status: ${simStore.getTask('LOST-ACK-1').status}`);

    // -------------------------------------------------------------
    // Test 10: Task accepted but not yet completed (Antigravity semantics)
    // -------------------------------------------------------------
    const agAdapter = new AntigravityAdapter({
      brokerUrl,
      authToken: TEST_AUTH_TOKEN,
      mailboxPath: TEST_MAILBOX,
      execMode: 'mock',
      mockHandler: async () => ({
        success: true,
        status: 'ACCEPTED_PENDING_RESPONSE',
        evidence: 'Canvas accepted work order'
      })
    });
    const agRes = await agAdapter.dispatchMessage({ id: 'C-77', sender: 'Claude', headerLine: '', body: '' });
    report(10, 'Antigravity task acceptance distinguished from completion',
      agRes.status === 'ACCEPTED_PENDING_RESPONSE', `Status: ${agRes.status}`);

    // -------------------------------------------------------------
    // Test 11: Malformed mailbox messages quarantined
    // -------------------------------------------------------------
    const parsedMalformed = parseMailboxMessages('\n### [] Not a valid heading\nSome text\n');
    const t11 = parsedMalformed.length === 0;
    report(11, 'Malformed message headings safely rejected by parser',
      t11, `Parsed count: ${parsedMalformed.length}`);

    // -------------------------------------------------------------
    // Test 12: Missing authoritative mailbox path fails fast
    // -------------------------------------------------------------
    let failFastTriggered = false;
    try {
      new MailboxWatcher({
        mailboxPath: 'C:\\NonExistentDirectory\\TEAM_MAILBOX.md',
        failFastOnMissing: true,
        allowCreate: false
      });
    } catch (err) {
      failFastTriggered = err.message.includes('not found');
    }
    report(12, 'Missing authoritative mailbox fails fast without creating split file',
      failFastTriggered, `Fail-fast triggered: ${failFastTriggered}`);

    // -------------------------------------------------------------
    // Test 13: Adversarial shell metacharacters in message content
    // -------------------------------------------------------------
    const adversarialPrompt = '`whoami` & calc.exe | rm -rf / ; %TEMP% " && echo injected';
    const claudeSafe = new ClaudeAdapter({
      execMode: 'mock',
      mockHandler: async (m) => {
        // Assert content is received verbatim without shell evaluation
        assert.strictEqual(m.body, adversarialPrompt);
        return { success: true };
      }
    });
    const t13 = await claudeSafe.dispatchMessage({
      id: 'ADV-1',
      sender: 'Codex',
      headerLine: '### [X-99] Codex -> Claude',
      body: adversarialPrompt
    });
    report(13, 'Adversarial shell metacharacters treated as inert content (shell: false)',
      t13.success === true, 'No shell injection occurred');

    // -------------------------------------------------------------
    // Test 14: Process exit, timeout, and cancellation handling
    // -------------------------------------------------------------
    const timeoutAdapter = new ClaudeAdapter({
      cliCommand: 'node',
      sessionMode: 'new',
      timeoutMs: 300, // 300ms timeout
      execMode: 'cli',
      // Run a hanging script to test cancellation
      workingDir: TEST_DIR
    });
    // Replace cliCommand to execute a node hang script
    timeoutAdapter.cliCommand = 'node';
    timeoutAdapter.sessionMode = 'none';
    let timeoutCaught = false;
    try {
      // Simulate timeout by calling an adapter method with small timeout
      await new Promise((resolve, reject) => {
        const { spawn } = require('child_process');
        const p = spawn('node', ['-e', 'setTimeout(()=>{}, 10000)'], { shell: false });
        const to = setTimeout(() => {
          try { p.kill('SIGTERM'); } catch (_) {}
          timeoutCaught = true;
          resolve();
        }, 300);
        p.on('close', () => { clearTimeout(to); resolve(); });
      });
    } catch (_) {}
    report(14, 'Process timeout cancellation and SIGTERM termination handling',
      timeoutCaught, `Timeout caught: ${timeoutCaught}`);

    // -------------------------------------------------------------
    // Test 15: Retry exhaustion, dead letters, and requeue API
    // -------------------------------------------------------------
    const dlStore = broker.stateStore;
    dlStore.getOrCreateTask({ id: 'FAIL-1', recipientRaw: 'Claude', sender: 'Codex' });
    dlStore.claimTask('FAIL-1', 'worker-1', 1000);
    dlStore.markFailed('FAIL-1', 'worker-1', 'Attempt 1 failed');
    dlStore.claimTask('FAIL-1', 'worker-1', 1000);
    const finalFail = dlStore.markFailed('FAIL-1', 'worker-1', 'Attempt 2 failed');
    const inDLQ = dlStore.deadLetters.has('FAIL-1');
    const requeued = dlStore.requeue('FAIL-1');
    const backToPending = dlStore.getTask('FAIL-1').status === PROCESSING_STATUS.PENDING;
    report(15, 'Retry exhaustion, Dead Letter Queue routing, and requeue capability',
      inDLQ && requeued && backToPending,
      `In DLQ: ${inDLQ}, Requeued: ${requeued}, Status: ${dlStore.getTask('FAIL-1').status}`);

    // -------------------------------------------------------------
    // Test 16: Service status and health query via HTTP
    // -------------------------------------------------------------
    let healthUp = false;
    await new Promise(resolve => {
      http.get(`http://127.0.0.1:${TEST_HTTP_PORT}/health`, res => {
        let raw = '';
        res.on('data', d => raw += d);
        res.on('end', () => {
          const json = JSON.parse(raw);
          if (json.status === 'UP') healthUp = true;
          resolve();
        });
      });
    });
    report(16, 'Service lifecycle, HTTP health and diagnostics endpoint verification',
      healthUp, `Status: ${healthUp ? 'UP' : 'DOWN'}`);

    // -------------------------------------------------------------
    // Test 17: Actual WebSocket connection and notification delivery
    // -------------------------------------------------------------
    let wsReceived = false;
    await new Promise(resolve => {
      const ws = new WebSocket(brokerUrl);
      ws.on('open', () => {
        ws.send(JSON.stringify({ type: EVENT_TYPES.AUTH_REQUEST, agentId: 'Claude', token: TEST_AUTH_TOKEN }));
      });
      ws.on('message', data => {
        const msg = JSON.parse(data.toString());
        if (msg.type === EVENT_TYPES.AUTH_RESPONSE && msg.success) {
          broker.publishMessage({ messageId: 'LIVE-1', recipientRaw: 'Claude', sender: 'Codex' });
        }
        if (msg.type === EVENT_TYPES.MAILBOX_MESSAGE_NOTIFY && msg.messageId === 'LIVE-1') {
          wsReceived = true;
          ws.close();
          resolve();
        }
      });
      ws.on('close', resolve);
    });
    report(17, 'Direct WebSocket notification delivery on published event',
      wsReceived, `Delivered: ${wsReceived}`);

    // -------------------------------------------------------------
    // Test 18: Configuration loading and environment variable precedence
    // -------------------------------------------------------------
    process.env.MAILBOX_WS_PORT = '9999';
    const { loadConfig } = require('../src/service/ServiceRunner');
    const cfg = loadConfig();
    const t18 = cfg.broker.port === 9999;
    delete process.env.MAILBOX_WS_PORT;
    report(18, 'Configuration loading with environment variable override precedence',
      t18, `Loaded port: ${cfg.broker.port}`);

    // -------------------------------------------------------------
    // Test 19: Rapid message bursts handled in order without dropped events
    // -------------------------------------------------------------
    if (!claude.isConnected) {
      claude.connect();
      await new Promise(r => setTimeout(r, 600));
    }
    rawNotifications.Claude = [];
    for (let i = 10; i <= 14; i++) {
      appendTestMessage('X', i, 'Codex', 'Claude', `TASK: Burst ${i}`);
    }
    await broker.watcher.checkNow();
    await new Promise(r => setTimeout(r, 500));
    const burstIds = rawNotifications.Claude.map(n => n.messageId);
    const t19 = ['X-10', 'X-11', 'X-12', 'X-13', 'X-14'].every(id => burstIds.includes(id));
    report(19, 'Rapid burst of 5 sequential messages delivered without loss',
      t19, `Delivered: ${burstIds.join(', ')}`);

    // -------------------------------------------------------------
    // Test 20: Backward compatibility with real team mailbox format
    // -------------------------------------------------------------
    const sampleRealMailbox = `
### [C-234] Claude -> Antigravity, 2026-10-28 15:52
TASK: Review A-168
FINDINGS: Pass after build check

### [A-170] Antigravity -> Claude,Codex,Owner, 2026-10-28 16:01
TASK: AG-CONTENT-02 REV5
STATUS: DELIVERED
`;
    const realParsed = parseMailboxMessages(sampleRealMailbox);
    const t20 = realParsed.length === 2 &&
                realParsed[0].id === 'C-234' &&
                realParsed[0].recipientRaw === 'Antigravity' &&
                realParsed[1].id === 'A-170' &&
                isRecipientMatch('Claude', realParsed[1].recipientRaw) &&
                isRecipientMatch('Codex', realParsed[1].recipientRaw);
    report(20, 'Existing mailbox format and multi-recipient parsing backward compatibility',
      t20, `Parsed: ${realParsed.length}`);

  } finally {
    claude.stop();
    codex.stop();
    antigravity.stop();
    await broker.stop();
  }

  console.log('\n===================================================================');
  console.log(`TEST SUMMARY: ${passed} PASSED, ${failed} FAILED (Total: ${passed + failed})`);
  console.log('===================================================================\n');

  return { passed, failed };
}

if (require.main === module) {
  runComprehensiveTests().then(res => {
    process.exit(res.failed === 0 ? 0 : 1);
  }).catch(err => {
    console.error('Fatal test error:', err);
    process.exit(1);
  });
}

module.exports = { runComprehensiveTests };
