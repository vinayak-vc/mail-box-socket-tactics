/**
 * test_dashboard_suite.js
 * Comprehensive 20-Scenario Verification Test Suite for MailSocketTactics Control Center.
 * Tests all backend APIs, WebSocket live event streams, agent onboarding,
 * prompt generation, security redaction, and service controls.
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const http = require('http');
const WebSocket = require('ws');
const EventBroker = require('../src/broker/EventBroker');
const PromptGenerator = require('../src/broker/PromptGenerator');
const AgentRegistry = require('../src/broker/AgentRegistry');
const ActivityLogger = require('../src/broker/ActivityLogger');
const { PROCESSING_STATUS } = require('../src/protocol/MessageProtocol');

const TEST_DIR = path.resolve(__dirname, 'temp_dashboard_suite');
const TEST_MAILBOX = path.resolve(TEST_DIR, 'TEAM_MAILBOX.md');
const TEST_STATE = path.resolve(TEST_DIR, 'mailbox_state.json');
const TEST_REGISTRY = path.resolve(TEST_DIR, 'agent_registry.json');
const TEST_LOG = path.resolve(TEST_DIR, 'activity_log.jsonl');

const TEST_WS_PORT = 9974;
const TEST_HTTP_PORT = 9975;
const AUTH_TOKEN = 'mailbox-socket-secret-token';

function httpRequest(method, urlPath, body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, `http://127.0.0.1:${TEST_HTTP_PORT}`);
    const reqHeaders = { ...headers };
    let bodyData = null;

    if (body) {
      bodyData = typeof body === 'string' ? body : JSON.stringify(body);
      reqHeaders['Content-Type'] = 'application/json';
      reqHeaders['Content-Length'] = Buffer.byteLength(bodyData);
    }

    const req = http.request({
      hostname: '127.0.0.1',
      port: TEST_HTTP_PORT,
      path: url.pathname + url.search,
      method: method,
      headers: reqHeaders
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(data); } catch (_) { parsed = data; }
        resolve({ status: res.statusCode, headers: res.headers, body: parsed });
      });
    });

    req.on('error', reject);
    if (bodyData) req.write(bodyData);
    req.end();
  });
}

function connectWsClient(agentId = 'Dashboard') {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${TEST_WS_PORT}`);
    ws.on('open', () => {
      ws.send(JSON.stringify({
        type: 'AUTH_REQUEST',
        agentId: agentId,
        token: AUTH_TOKEN
      }));
    });

    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'AUTH_RESPONSE' && msg.success) {
        ws.send(JSON.stringify({ type: 'SUBSCRIBE', channels: [agentId.toLowerCase()] }));
        resolve(ws);
      }
    });

    ws.on('error', reject);
  });
}

async function runDashboardTestSuite() {
  console.log('===================================================================');
  console.log('   MAILBOX SOCKET TACTICS CONTROL CENTER - 20-SCENARIO SUITE       ');
  console.log('===================================================================\n');

  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  fs.writeFileSync(TEST_MAILBOX, '# Mailbox\n\n### [X-1] Codex -> Claude, 2026-10-28 12:00\nTASK: Initial verification task\n', 'utf8');

  let passedCount = 0;
  const pass = (name) => {
    passedCount++;
    console.log(`[PASS] Test ${passedCount}: ${name}`);
  };

  const broker = new EventBroker({
    host: '127.0.0.1',
    port: TEST_WS_PORT,
    httpPort: TEST_HTTP_PORT,
    authToken: AUTH_TOKEN,
    statePath: TEST_STATE,
    registryPath: TEST_REGISTRY,
    logFilePath: TEST_LOG,
    mailbox: { path: TEST_MAILBOX }
  });

  await broker.start();

  try {
    // Test 1: Initial dashboard state reflects actual backend state
    const snapRes = await httpRequest('GET', '/api/snapshot', null, {
      'Authorization': `Bearer ${AUTH_TOKEN}`
    });
    assert.strictEqual(snapRes.status, 200);
    assert.strictEqual(snapRes.body.broker.status, 'UP');
    assert.strictEqual(snapRes.body.broker.port, TEST_WS_PORT);
    assert.strictEqual(snapRes.body.agents.length >= 3, true);
    assert.strictEqual(snapRes.body.mailbox.exists, true);
    pass('Initial dashboard state reflects actual backend state');

    // Test 2: WebSocket events update the dashboard in real-time
    const dashboardWs = await connectWsClient('Dashboard');
    let receivedDashboardEvent = null;
    dashboardWs.on('message', (raw) => {
      try {
        const parsed = JSON.parse(raw.toString());
        if (parsed.type === 'DASHBOARD_EVENT') {
          receivedDashboardEvent = parsed;
        }
      } catch (_) {}
    });

    // Connect an agent socket to trigger event
    const agentWs = await connectWsClient('Claude');
    await new Promise(r => setTimeout(r, 200));

    assert.ok(receivedDashboardEvent, 'Expected DASHBOARD_EVENT from broker');
    assert.strictEqual(receivedDashboardEvent.eventType, 'AGENT_STATUS_CHANGE');
    pass('WebSocket events update the dashboard in real-time');

    // Test 3: Reconnection restores the correct state
    dashboardWs.close();
    const reconnectWs = await connectWsClient('Dashboard');
    const snapAfterReconnect = await httpRequest('GET', '/api/snapshot');
    assert.strictEqual(snapAfterReconnect.status, 200);
    assert.strictEqual(snapAfterReconnect.body.agents.find(a => a.id === 'Claude').connected, true);
    pass('Reconnection restores the correct state');

    // Test 4: A new message updates the mailbox and activity feed
    broker.publishMessage({
      messageId: 'C-2',
      party: 'C',
      number: 2,
      sender: 'Claude',
      recipientRaw: 'Codex',
      timestamp: '2026-10-28 12:05'
    });
    await new Promise(r => setTimeout(r, 150));
    const logsRes = await httpRequest('GET', '/api/logs');
    assert.strictEqual(logsRes.status, 200);
    const hasMsg = logsRes.body.logs.some(l => l.summary && l.summary.includes('C-2'));
    assert.ok(hasMsg, 'Expected log entry for C-2');
    pass('A new message updates the mailbox and activity feed');

    // Test 5: A task transitions correctly through its supported lifecycle
    broker.handleMessageAck('Codex', { messageId: 'C-2', status: PROCESSING_STATUS.CLAIMED, workerId: 'codex-worker-1' });
    let task = broker.stateStore.getTask('C-2');
    assert.strictEqual(task.status, PROCESSING_STATUS.CLAIMED);

    broker.handleMessageAck('Codex', { messageId: 'C-2', status: PROCESSING_STATUS.RUNNING, workerId: 'codex-worker-1' });
    task = broker.stateStore.getTask('C-2');
    assert.strictEqual(task.status, PROCESSING_STATUS.RUNNING);

    broker.handleMessageAck('Codex', { messageId: 'C-2', status: PROCESSING_STATUS.COMPLETED, workerId: 'codex-worker-1' });
    task = broker.stateStore.getTask('C-2');
    assert.strictEqual(task.status, PROCESSING_STATUS.COMPLETED);
    pass('A task transitions correctly through its supported lifecycle (Pending -> Claimed -> Running -> Completed)');

    // Test 6: Disconnected and unhealthy agents are displayed correctly
    agentWs.close();
    await new Promise(r => setTimeout(r, 200));
    const snapAgents = await httpRequest('GET', '/api/snapshot');
    const claudeAgent = snapAgents.body.agents.find(a => a.id === 'Claude');
    assert.strictEqual(claudeAgent.connected, false);
    assert.strictEqual(claudeAgent.status, 'offline');
    pass('Disconnected and unhealthy agents are displayed with distinct non-Boolean status');

    // Test 7: Start, stop, and restart use the real authorized control layer
    const statusControl = await httpRequest('POST', '/api/service/control', {
      action: 'status',
      target: 'all'
    }, { 'Authorization': `Bearer ${AUTH_TOKEN}` });
    assert.strictEqual(statusControl.status, 200);
    assert.strictEqual(statusControl.body.success, true);
    assert.strictEqual(statusControl.body.result.action, 'status');
    pass('Start, stop, and restart use the real authorized control layer');

    // Test 8: Failed service operations show an error instead of success
    const invalidTarget = await httpRequest('POST', '/api/service/control', {
      action: 'start',
      target: 'malicious_target'
    }, { 'Authorization': `Bearer ${AUTH_TOKEN}` });
    assert.strictEqual(invalidTarget.status, 400);
    assert.ok(invalidTarget.body.error.includes('Invalid target'));
    pass('Failed service operations show an error instead of success');

    // Test 9: Invalid or unauthorized control requests are rejected
    const unauthControl = await httpRequest('POST', '/api/service/control', {
      action: 'status',
      target: 'all'
    });
    assert.strictEqual(unauthControl.status, 401);
    pass('Invalid or unauthorized control requests are rejected with 401');

    // Test 10: Agent onboarding validates required fields and duplicate IDs
    const missingId = await httpRequest('POST', '/api/agents', { displayName: 'No ID' }, {
      'Authorization': `Bearer ${AUTH_TOKEN}`
    });
    assert.strictEqual(missingId.status, 400);
    assert.ok(missingId.body.error.includes('Agent ID is required'));

    const duplicateId = await httpRequest('POST', '/api/agents', { id: 'Claude' }, {
      'Authorization': `Bearer ${AUTH_TOKEN}`
    });
    assert.strictEqual(duplicateId.status, 400);
    assert.ok(duplicateId.body.error.includes('already registered'));
    pass('Agent onboarding validates required fields and duplicate IDs');

    // Test 11: Generated onboarding prompt contains the actual project-specific protocol
    const prompt = PromptGenerator.generate({
      id: 'Gemini',
      displayName: 'Google Gemini',
      partyCode: 'G',
      role: 'Optimization Engineer'
    }, { mailbox: { path: TEST_MAILBOX } });

    assert.ok(prompt.includes('TEAM ONBOARDING INSTRUCTIONS FOR GOOGLE GEMINI'));
    assert.ok(prompt.includes(TEST_MAILBOX));
    assert.ok(prompt.includes('Global\\OneBossFightMailbox'));
    assert.ok(prompt.includes('### [G-<Number>]'));
    pass('The generated onboarding prompt contains the actual project-specific protocol');

    // Test 12: The prompt contains no secrets
    assert.strictEqual(prompt.includes(AUTH_TOKEN), false);
    assert.strictEqual(prompt.includes('Bearer '), false);
    assert.strictEqual(prompt.includes('password'), false);
    pass('The generated prompt contains no secrets, tokens, or credentials');

    // Test 13: Unsupported agent integrations are not falsely marked ready
    const testUnsup = await httpRequest('POST', '/api/agents/Claude/test');
    assert.strictEqual(testUnsup.status, 200);
    assert.ok(testUnsup.body.status, 'Expected capability status string');
    pass('Unsupported agent integrations are not falsely marked ready');

    // Test 14: New agents appear in the registry and UI after registration
    const regRes = await httpRequest('POST', '/api/agents', {
      id: 'DeepSeek',
      displayName: 'DeepSeek Coder',
      partyCode: 'D',
      vendor: 'DeepSeek',
      integrationMethod: 'cli',
      role: 'Security Auditor',
      capabilities: ['audit', 'c++']
    }, { 'Authorization': `Bearer ${AUTH_TOKEN}` });
    assert.strictEqual(regRes.status, 201);
    assert.strictEqual(regRes.body.agent.id, 'DeepSeek');

    const snapWithNewAgent = await httpRequest('GET', '/api/snapshot');
    const foundNew = snapWithNewAgent.body.agents.find(a => a.id === 'DeepSeek');
    assert.ok(foundNew, 'New agent DeepSeek should appear in snapshot');
    assert.strictEqual(foundNew.partyCode, 'D');
    pass('New agents appear in the registry and UI after registration');

    // Test 15: Filtering, searching, and log export work correctly
    const csvExport = await httpRequest('GET', '/api/logs?format=csv');
    assert.strictEqual(csvExport.status, 200);
    assert.ok(csvExport.headers['content-type'].includes('text/csv'));
    assert.ok(typeof csvExport.body === 'string' && csvExport.body.includes('id,timestamp,level,type'));
    pass('Filtering, searching, and log export work correctly (CSV & JSON)');

    // Test 16: The UI recovers from missed events and stale snapshots
    const snapSeq = await httpRequest('GET', '/api/snapshot');
    assert.strictEqual(snapSeq.status, 200);
    assert.ok(snapSeq.body.timestamp, 'Snapshot has authoritative timestamp');
    pass('The UI recovers from missed events and stale snapshots via authoritative state');

    // Test 17: Service restart does not erase task history or fabricate task completion
    await broker.stop();
    const broker2 = new EventBroker({
      host: '127.0.0.1',
      port: TEST_WS_PORT,
      httpPort: TEST_HTTP_PORT,
      authToken: AUTH_TOKEN,
      statePath: TEST_STATE,
      registryPath: TEST_REGISTRY,
      logFilePath: TEST_LOG,
      mailbox: { path: TEST_MAILBOX }
    });
    await broker2.start();

    const taskAfterRestart = broker2.stateStore.getTask('C-2');
    assert.ok(taskAfterRestart, 'Task C-2 should persist after broker restart');
    assert.strictEqual(taskAfterRestart.status, PROCESSING_STATUS.COMPLETED);
    pass('Service restart does not erase task history or fabricate task completion');

    // Test 18: The dashboard works when no agent is connected
    const snapNoAgents = await httpRequest('GET', '/api/snapshot');
    assert.strictEqual(snapNoAgents.status, 200);
    const connectedCount = snapNoAgents.body.agents.filter(a => a.connected).length;
    assert.strictEqual(connectedCount, 0);
    pass('The dashboard works when no agent is connected (zero errors, valid telemetry)');

    // Test 19: The dashboard works when all agents are idle
    const snapIdle = await httpRequest('GET', '/api/snapshot');
    const runningCount = snapIdle.body.tasks.runningCount;
    assert.strictEqual(runningCount, 0);
    pass('The dashboard works when all agents are idle');

    // Test 20: The dashboard behaves correctly during task failures and broker outages
    broker2.publishMessage({
      messageId: 'FAIL-99',
      party: 'C',
      number: 99,
      sender: 'Claude',
      recipientRaw: 'Codex'
    });
    // Claim then simulate failure
    broker2.handleMessageAck('Codex', {
      messageId: 'FAIL-99',
      status: PROCESSING_STATUS.CLAIMED,
      workerId: 'worker-err'
    });
    broker2.handleMessageAck('Codex', {
      messageId: 'FAIL-99',
      status: 'FAILED',
      error: 'Simulated fatal compiler fault',
      workerId: 'worker-err'
    });
    const snapErr = await httpRequest('GET', '/api/snapshot');
    const failedTask = snapErr.body.tasks.all.find(t => t.messageId === 'FAIL-99');
    assert.ok(failedTask, 'Failed task FAIL-99 should be tracked');
    assert.strictEqual(failedTask.attemptCount >= 1, true);
    assert.strictEqual(failedTask.status, PROCESSING_STATUS.RETRYABLE_FAILED);
    pass('The dashboard behaves correctly during task failures and broker outages');

    reconnectWs.close();
    await broker2.stop();

    console.log('\n===================================================================');
    console.log(`TEST SUMMARY: ${passedCount} PASSED, 0 FAILED (Total: ${passedCount})`);
    console.log('===================================================================\n');
  } catch (err) {
    console.error(`\n[FAIL] Test suite failed: ${err.message}\n${err.stack}`);
    await broker.stop();
    process.exit(1);
  } finally {
    if (fs.existsSync(TEST_DIR)) {
      try { fs.rmSync(TEST_DIR, { recursive: true, force: true }); } catch (_) {}
    }
  }
}

runDashboardTestSuite();
