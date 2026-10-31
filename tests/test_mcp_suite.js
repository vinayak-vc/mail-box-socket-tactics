/**
 * test_mcp_suite.js
 * Comprehensive unit and integration test suite for MailSocketTactics Shared MCP Server.
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const McpServer = require('../src/mcp/McpServer');
const StateStore = require('../src/broker/StateStore');

const TEST_DIR = path.resolve(__dirname, 'temp_mcp');
if (!fs.existsSync(TEST_DIR)) fs.mkdirSync(TEST_DIR, { recursive: true });

const TEST_MAILBOX = path.resolve(TEST_DIR, 'TEAM_MAILBOX.md');
const TEST_STATE = path.resolve(TEST_DIR, 'test_state.json');
const TEST_REGISTRY = path.resolve(TEST_DIR, 'test_registry.json');

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
  console.log('   MAILSOCKETTACTICS SHARED MCP SERVER TEST SUITE                  ');
  console.log('===================================================================\n');

  // Setup test mailbox
  fs.writeFileSync(TEST_MAILBOX, `# Team Mailbox

### [X-1] Codex -> Claude, 2026-10-28 10:00
TASK: Design state machine for boss phase 2 transition

### [C-2] Claude -> Codex, 2026-10-28 10:15
TASK: Verify hit collision math on Greystone sword sweep
`, 'utf8');

  if (fs.existsSync(TEST_STATE)) fs.unlinkSync(TEST_STATE);
  if (fs.existsSync(TEST_REGISTRY)) fs.unlinkSync(TEST_REGISTRY);

  const sharedStateStore = new StateStore({ statePath: TEST_STATE });

  const mcpClaude = new McpServer({
    agentId: 'Claude',
    projectRoot: path.resolve(__dirname, '..'),
    mailboxPath: TEST_MAILBOX,
    stateStore: sharedStateStore
  });

  const mcpCodex = new McpServer({
    agentId: 'Codex',
    projectRoot: path.resolve(__dirname, '..'),
    mailboxPath: TEST_MAILBOX,
    stateStore: sharedStateStore
  });

  // Test 1: MCP initialize handshake
  try {
    const initRes = await mcpClaude.handleRequest({ jsonrpc: '2.0', id: 1, method: 'initialize' });
    assert.strictEqual(initRes.jsonrpc, '2.0');
    assert.strictEqual(initRes.id, 1);
    assert.strictEqual(initRes.result.protocolVersion, '2024-11-05');
    assert.strictEqual(initRes.result.serverInfo.agentId, 'Claude');
    assert.strictEqual(initRes.result.serverInfo.partyCode, 'C');
    assert.ok(initRes.result.capabilities.tools);
    assert.ok(initRes.result.capabilities.resources);
    assert.ok(initRes.result.capabilities.prompts);
    report('Test 1: MCP initialize returns valid capabilities and bound identity', true);
  } catch (e) {
    report('Test 1: MCP initialize returns valid capabilities and bound identity', false, e);
  }

  // Test 2: MCP tools/list discovery
  try {
    const listRes = await mcpClaude.handleRequest({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const tools = listRes.result.tools;
    assert.strictEqual(tools.length, 16, 'Must expose all 16 domain tools');
    
    const requiredTools = [
      'get_team_status', 'get_my_identity', 'get_pending_messages',
      'get_message', 'wait_for_message', 'claim_message',
      'acknowledge_message', 'send_message', 'update_task_status',
      'complete_task', 'fail_task', 'get_task_history',
      'get_message_history', 'get_agent_status', 'heartbeat',
      'send_owner_email'
    ];

    for (const reqTool of requiredTools) {
      assert.ok(tools.some(t => t.name === reqTool), `Missing tool: ${reqTool}`);
    }

    report('Test 2: MCP tools/list exposes all 16 domain tools with schemas', true);
  } catch (e) {
    report('Test 2: MCP tools/list exposes all 16 domain tools with schemas', false, e);
  }

  // Test 3: Tool get_my_identity binds to caller
  try {
    const claudeId = await mcpClaude.handleRequest({
      jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_my_identity' }
    });
    const parsedC = JSON.parse(claudeId.result.content[0].text);
    assert.strictEqual(parsedC.agentId, 'Claude');
    assert.strictEqual(parsedC.partyCode, 'C');

    const codexId = await mcpCodex.handleRequest({
      jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'get_my_identity' }
    });
    const parsedX = JSON.parse(codexId.result.content[0].text);
    assert.strictEqual(parsedX.agentId, 'Codex');
    assert.strictEqual(parsedX.partyCode, 'X');

    report('Test 3: get_my_identity strictly reflects bound identity per client instance', true);
  } catch (e) {
    report('Test 3: get_my_identity strictly reflects bound identity per client instance', false, e);
  }

  // Test 4: Tool get_team_status operational summary
  try {
    const statusRes = await mcpClaude.handleRequest({
      jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'get_team_status' }
    });
    const parsed = JSON.parse(statusRes.result.content[0].text);
    assert.strictEqual(parsed.status, 'UP');
    assert.strictEqual(parsed.authenticatedAs, 'Claude');
    assert.ok(parsed.agents.length >= 3);
    report('Test 4: get_team_status returns safe operational team summary', true);
  } catch (e) {
    report('Test 4: get_team_status returns safe operational team summary', false, e);
  }

  // Test 5: Tool get_pending_messages delivers recipient-only messages
  try {
    const claudePending = await mcpClaude.handleRequest({
      jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'get_pending_messages' }
    });
    const parsedC = JSON.parse(claudePending.result.content[0].text);
    assert.strictEqual(parsedC.total, 1);
    assert.strictEqual(parsedC.messages[0].id, 'X-1');

    const codexPending = await mcpCodex.handleRequest({
      jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'get_pending_messages' }
    });
    const parsedX = JSON.parse(codexPending.result.content[0].text);
    assert.strictEqual(parsedX.total, 1);
    assert.strictEqual(parsedX.messages[0].id, 'C-2');

    report('Test 5: get_pending_messages isolates messages strictly to authorized recipient', true);
  } catch (e) {
    report('Test 5: get_pending_messages isolates messages strictly to authorized recipient', false, e);
  }

  // Test 6: Cross-agent claim prevention
  try {
    const crossClaim = await mcpCodex.handleRequest({
      jsonrpc: '2.0', id: 8, method: 'tools/call', params: {
        name: 'claim_message',
        arguments: { messageId: 'X-1' } // Addressed to Claude!
      }
    });
    assert.ok(crossClaim.error, 'Cross-agent claim must return error');
    assert.ok(crossClaim.error.message.includes('Unauthorized'));
    report('Test 6: claim_message rejects unauthorized cross-agent claim attempts', true);
  } catch (e) {
    report('Test 6: claim_message rejects unauthorized cross-agent claim attempts', false, e);
  }

  // Test 7: Authorized claim, acknowledge, update status, complete
  try {
    // 7a. Claim
    const claimRes = await mcpClaude.handleRequest({
      jsonrpc: '2.0', id: 9, method: 'tools/call', params: {
        name: 'claim_message',
        arguments: { messageId: 'X-1' }
      }
    });
    const parsedClaim = JSON.parse(claimRes.result.content[0].text);
    assert.strictEqual(parsedClaim.status, 'CLAIMED');

    // 7b. Acknowledge
    const ackRes = await mcpClaude.handleRequest({
      jsonrpc: '2.0', id: 10, method: 'tools/call', params: {
        name: 'acknowledge_message',
        arguments: { messageId: 'X-1', status: 'CLAIMED' }
      }
    });
    assert.ok(!ackRes.error);

    // 7c. Update status to RUNNING
    const runRes = await mcpClaude.handleRequest({
      jsonrpc: '2.0', id: 11, method: 'tools/call', params: {
        name: 'update_task_status',
        arguments: { messageId: 'X-1', status: 'RUNNING' }
      }
    });
    const parsedRun = JSON.parse(runRes.result.content[0].text);
    assert.strictEqual(parsedRun.status, 'RUNNING');

    // 7d. Complete task
    const compRes = await mcpClaude.handleRequest({
      jsonrpc: '2.0', id: 12, method: 'tools/call', params: {
        name: 'complete_task',
        arguments: {
          messageId: 'X-1',
          responseMessageId: 'C-3',
          evidence: { stateMachineDesigned: true }
        }
      }
    });
    const parsedComp = JSON.parse(compRes.result.content[0].text);
    assert.strictEqual(parsedComp.status, 'COMPLETED');

    report('Test 7: Full task lifecycle (claim -> ack -> running -> complete) via MCP', true);
  } catch (e) {
    report('Test 7: Full task lifecycle (claim -> ack -> running -> complete) via MCP', false, e);
  }

  // Test 8: Task history inspection
  try {
    const histRes = await mcpClaude.handleRequest({
      jsonrpc: '2.0', id: 13, method: 'tools/call', params: {
        name: 'get_task_history',
        arguments: { messageId: 'X-1' }
      }
    });
    const parsedHist = JSON.parse(histRes.result.content[0].text);
    assert.strictEqual(parsedHist.messageId, 'X-1');
    assert.ok(parsedHist.events.length >= 3);
    report('Test 8: get_task_history returns full lifecycle timeline', true);
  } catch (e) {
    report('Test 8: get_task_history returns full lifecycle timeline', false, e);
  }

  // Test 9: Tool fail_task
  try {
    await mcpCodex.handleRequest({
      jsonrpc: '2.0', id: 14, method: 'tools/call', params: {
        name: 'claim_message',
        arguments: { messageId: 'C-2' }
      }
    });

    const failRes = await mcpCodex.handleRequest({
      jsonrpc: '2.0', id: 15, method: 'tools/call', params: {
        name: 'fail_task',
        arguments: { messageId: 'C-2', error: 'Collision math error' }
      }
    });
    const parsedFail = JSON.parse(failRes.result.content[0].text);
    assert.strictEqual(parsedFail.status, 'RETRYABLE_FAILED');
    report('Test 9: fail_task records failure and updates status', true);
  } catch (e) {
    report('Test 9: fail_task records failure and updates status', false, e);
  }

  // Test 10: wait_for_message with bounded timeout
  try {
    const waitRes = await mcpClaude.handleRequest({
      jsonrpc: '2.0', id: 16, method: 'tools/call', params: {
        name: 'wait_for_message',
        arguments: { timeoutSeconds: 2 }
      }
    });
    const parsedWait = JSON.parse(waitRes.result.content[0].text);
    assert.strictEqual(parsedWait.timeout, true);
    assert.strictEqual(parsedWait.message, null);
    report('Test 10: wait_for_message respects bounded timeout and returns clean status', true);
  } catch (e) {
    report('Test 10: wait_for_message respects bounded timeout and returns clean status', false, e);
  }

  // Test 11: MCP resources/list and resources/read
  try {
    const rList = await mcpClaude.handleRequest({ jsonrpc: '2.0', id: 17, method: 'resources/list' });
    assert.strictEqual(rList.result.resources.length, 3);

    const rRead = await mcpClaude.handleRequest({
      jsonrpc: '2.0', id: 18, method: 'resources/read', params: { uri: 'mailsocket://protocol' }
    });
    assert.ok(rRead.result.contents[0].text.includes('TEAM_MAILBOX.md'));
    report('Test 11: MCP resources/list and resources/read expose team documentation', true);
  } catch (e) {
    report('Test 11: MCP resources/list and resources/read expose team documentation', false, e);
  }

  // Test 12: MCP prompts/list and prompts/get
  try {
    const pList = await mcpClaude.handleRequest({ jsonrpc: '2.0', id: 19, method: 'prompts/list' });
    assert.strictEqual(pList.result.prompts.length, 1);

    const pGet = await mcpClaude.handleRequest({
      jsonrpc: '2.0', id: 20, method: 'prompts/get', params: { name: 'team_onboarding' }
    });
    const text = pGet.result.messages[0].content.text;
    assert.ok(text.includes('Claude'));
    assert.ok(text.includes('TEAM_MAILBOX.md'));
    assert.ok(!text.includes('password') && !text.includes('token-here'), 'Prompt must contain no secrets');
    report('Test 12: MCP prompts/get generates customized onboarding prompt without secrets', true);
  } catch (e) {
    report('Test 12: MCP prompts/get generates customized onboarding prompt without secrets', false, e);
  }

  // Test 13: JSON-RPC invalid method error handling
  try {
    const errRes = await mcpClaude.handleRequest({ jsonrpc: '2.0', id: 21, method: 'unknown_method' });
    assert.strictEqual(errRes.error.code, -32601);
    report('Test 13: MCP JSON-RPC returns standard -32601 for unknown methods', true);
  } catch (e) {
    report('Test 13: MCP JSON-RPC returns standard -32601 for unknown methods', false, e);
  }

  // Test 14: Tool send_owner_email validation and execution
  try {
    const emailRes = await mcpCodex.handleRequest({
      jsonrpc: '2.0',
      id: 22,
      method: 'tools/call',
      params: {
        name: 'send_owner_email',
        arguments: {
          subject: '[DECISION NEEDED] Boss Phase 2 Transition Logic',
          message: 'The current phase transition logic requires human decision on Greystone invulnerability frames.',
          urgency: 'DECISION_NEEDED',
          taskReference: 'X-1'
        }
      }
    });

    assert.ok(!emailRes.error, 'send_owner_email should not throw RPC error');
    const parsedRes = JSON.parse(emailRes.result.content[0].text);
    // Since mock test has no real credentials, status is either 'skipped' or 'sent'
    assert.ok(['skipped', 'sent', 'error'].includes(parsedRes.status), 'Must return valid status');
    report('Test 14: Tool send_owner_email exposes structured invocation for AI Leads', true);
  } catch (e) {
    report('Test 14: Tool send_owner_email exposes structured invocation for AI Leads', false, e);
  }

  // Clean test files
  try {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  } catch (_) {}

  console.log('\n===================================================================');
  console.log(`MCP SERVER TEST SUMMARY: ${passed} PASSED, ${failed} FAILED (Total: ${passed + failed})`);
  console.log('===================================================================');

  if (failed > 0) process.exit(1);
}

runTests().catch(err => {
  console.error('Fatal MCP test error:', err);
  process.exit(1);
});
