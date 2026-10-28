/**
 * test_zrok_suite.js
 * Verification suite for zrok public internet tunneling and HTTP companion WebSocket upgrades.
 */

const assert = require('assert');
const http = require('http');
const path = require('path');
const fs = require('fs');
const WebSocket = require('ws');
const EventBroker = require('../src/broker/EventBroker');
const ZrokManager = require('../src/service/ZrokManager');

let passed = 0;
let failed = 0;

function report(name, ok, err) {
  if (ok) {
    passed++;
    console.log(`[PASS] ${name}`);
  } else {
    failed++;
    console.error(`[FAIL] ${name}: ${err ? err.message : ''}`);
    if (err && err.stack) console.error(err.stack);
  }
}

async function runTests() {
  console.log('===================================================================');
  console.log('   ZROK TUNNELING & DUAL LOCAL/INTERNET ACCESS TEST SUITE          ');
  console.log('===================================================================\n');

  // Test 1: ZrokManager defaults & token masking (No secrets exposed)
  try {
    const zm = new ZrokManager({
      token: 'mk46secretToken123',
      target: 'http://127.0.0.1:8766'
    });
    const status = zm.getStatus();
    assert.strictEqual(status.tokenConfigured, true, 'tokenConfigured should be true');
    assert.strictEqual(status.tokenMasked, 'mk46...123', 'Token should be masked');
    assert.ok(!JSON.stringify(status).includes('mk46secretToken123'), 'Raw token must not appear in status');
    assert.strictEqual(status.status, 'DISCONNECTED', 'Initial status should be DISCONNECTED');
    report('Test 1: ZrokManager masks tokens and preserves security', true);
  } catch (err) {
    report('Test 1: ZrokManager masks tokens and preserves security', false, err);
  }

  // Test 2: ZrokManager disabled behavior
  try {
    const zm = new ZrokManager({ enabled: false });
    const status = zm.getStatus();
    assert.strictEqual(status.enabled, false);
    assert.strictEqual(status.status, 'DISABLED');
    const url = await zm.start();
    assert.strictEqual(url, null, 'Disabled manager should return null on start');
    report('Test 2: ZrokManager respects enabled: false configuration', true);
  } catch (err) {
    report('Test 2: ZrokManager respects enabled: false configuration', false, err);
  }

  // Test 3: Dual WebSocket upgrade on HTTP port AND direct WS port simultaneously
  const testWsPort = 9988;
  const testHttpPort = 9989;
  let broker = null;

  try {
    broker = new EventBroker({
      host: '127.0.0.1',
      port: testWsPort,
      httpPort: testHttpPort,
      authToken: 'test-zrok-secret'
    });
    await broker.start();

    // 3a. Connect via standard WS port (9988)
    const directWs = new WebSocket(`ws://127.0.0.1:${testWsPort}`);
    const directAuthPromise = new Promise((resolve, reject) => {
      directWs.on('open', () => {
        directWs.send(JSON.stringify({
          type: 'AUTH_REQUEST',
          agentId: 'DirectAgent',
          token: 'test-zrok-secret'
        }));
      });
      directWs.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'AUTH_RESPONSE') resolve(msg);
      });
      directWs.on('error', reject);
    });

    const directAuth = await directAuthPromise;
    assert.strictEqual(directAuth.success, true, 'Direct WS connection authentication must succeed');

    // 3b. Connect via HTTP companion port (9989) via WebSocket upgrade (zrok tunnel scenario)
    const upgradedWs = new WebSocket(`ws://127.0.0.1:${testHttpPort}`);
    const upgradeAuthPromise = new Promise((resolve, reject) => {
      upgradedWs.on('open', () => {
        upgradedWs.send(JSON.stringify({
          type: 'AUTH_REQUEST',
          agentId: 'UpgradedRemoteAgent',
          token: 'test-zrok-secret'
        }));
      });
      upgradedWs.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'AUTH_RESPONSE') resolve(msg);
      });
      upgradedWs.on('error', reject);
    });

    const upgradeAuth = await upgradeAuthPromise;
    assert.strictEqual(upgradeAuth.success, true, 'HTTP port WebSocket upgrade authentication must succeed');

    // Verify both are concurrently connected and authenticated
    let directFound = false;
    let upgradedFound = false;
    for (const [, state] of broker.clients.entries()) {
      if (state.agentId === 'DirectAgent' && state.authenticated) directFound = true;
      if (state.agentId === 'UpgradedRemoteAgent' && state.authenticated) upgradedFound = true;
    }

    assert.ok(directFound, 'DirectAgent must be connected');
    assert.ok(upgradedFound, 'UpgradedRemoteAgent must be connected');

    directWs.close();
    upgradedWs.close();
    report('Test 3: Dual WebSocket connectivity (direct :8765 AND HTTP upgraded :8766)', true);
  } catch (err) {
    report('Test 3: Dual WebSocket connectivity (direct :8765 AND HTTP upgraded :8766)', false, err);
  } finally {
    if (broker) await broker.stop();
  }

  // Test 4: /api/snapshot and /status expose zrok telemetry
  try {
    const mockZrok = {
      getStatus: () => ({
        enabled: true,
        status: 'CONNECTED',
        publicUrl: 'https://test.shares.zrok.io',
        shareToken: 'test1234',
        target: 'http://127.0.0.1:9989',
        tokenConfigured: true,
        tokenMasked: 'mk46...nlc',
        lastError: null
      }),
      stop: async () => {}
    };

    broker = new EventBroker({
      host: '127.0.0.1',
      port: testWsPort,
      httpPort: testHttpPort,
      authToken: 'test-zrok-secret',
      zrokManager: mockZrok
    });
    await broker.start();

    // Query /status
    const statusData = await new Promise((resolve, reject) => {
      http.get(`http://127.0.0.1:${testHttpPort}/status`, (res) => {
        let raw = '';
        res.on('data', c => { raw += c; });
        res.on('end', () => resolve(JSON.parse(raw)));
      }).on('error', reject);
    });

    assert.ok(statusData.zrok, 'Status must include zrok block');
    assert.strictEqual(statusData.zrok.status, 'CONNECTED');
    assert.strictEqual(statusData.zrok.publicUrl, 'https://test.shares.zrok.io');

    // Query /api/snapshot
    const snapshotData = await new Promise((resolve, reject) => {
      http.get(`http://127.0.0.1:${testHttpPort}/api/snapshot`, {
        headers: { Authorization: 'Bearer test-zrok-secret' }
      }, (res) => {
        let raw = '';
        res.on('data', c => { raw += c; });
        res.on('end', () => resolve(JSON.parse(raw)));
      }).on('error', reject);
    });

    assert.ok(snapshotData.zrok, 'Snapshot must include zrok block');
    assert.strictEqual(snapshotData.zrok.status, 'CONNECTED');
    assert.strictEqual(snapshotData.zrok.publicUrl, 'https://test.shares.zrok.io');
    assert.strictEqual(snapshotData.zrok.tokenMasked, 'mk46...nlc');

    report('Test 4: /status and /api/snapshot expose zrok telemetry cleanly', true);
  } catch (err) {
    report('Test 4: /status and /api/snapshot expose zrok telemetry cleanly', false, err);
  } finally {
    if (broker) await broker.stop();
  }

  // Test 5: Real zrok environment discovery & status check
  try {
    const envPath = path.resolve(__dirname, '../config/.env');
    let envToken = null;
    if (fs.existsSync(envPath)) {
      const content = fs.readFileSync(envPath, 'utf8');
      const match = content.match(/ZROK_TOKEN\s*=\s*(.+)/);
      if (match) envToken = match[1].trim();
    }

    const zm = new ZrokManager({ token: envToken });
    const isReady = await zm.ensureEnvironment();
    assert.strictEqual(isReady, true, 'zrok environment should be verified successfully');
    report('Test 5: Real zrok binary discovery and environment verification', true);
  } catch (err) {
    report('Test 5: Real zrok binary discovery and environment verification', false, err);
  }

  console.log('\n===================================================================');
  console.log(`TEST SUMMARY: ${passed} PASSED, ${failed} FAILED (Total: ${passed + failed})`);
  console.log('===================================================================');

  if (failed > 0) process.exit(1);
}

runTests().catch(err => {
  console.error('Fatal test runner error:', err);
  process.exit(1);
});
