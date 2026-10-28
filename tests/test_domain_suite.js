/**
 * test_domain_suite.js
 * Comprehensive unit and integration test suite for MailSocketTactics Domain Services layer.
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const {
  MailboxDomainService,
  TaskDomainService,
  AgentDomainService,
  UsageDomainService
} = require('../src/domain');
const StateStore = require('../src/broker/StateStore');
const AgentRegistry = require('../src/broker/AgentRegistry');

const TEST_DIR = path.resolve(__dirname, 'temp_domain');
if (!fs.existsSync(TEST_DIR)) fs.mkdirSync(TEST_DIR, { recursive: true });

const TEST_MAILBOX = path.resolve(TEST_DIR, 'TEAM_MAILBOX.md');
const TEST_STATE = path.resolve(TEST_DIR, 'test_state.json');
const TEST_REGISTRY = path.resolve(TEST_DIR, 'test_registry.json');
const TEST_USAGE = path.resolve(TEST_DIR, 'test_usage.json');

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
  console.log('   MAILSOCKETTACTICS DOMAIN SERVICES TEST SUITE                    ');
  console.log('===================================================================\n');

  // Setup test mailbox
  fs.writeFileSync(TEST_MAILBOX, `# Team Mailbox

### [X-1] Codex -> Claude, 2026-10-28 10:00
TASK: Implement combat camera shake

### [C-2] Claude -> Codex, 2026-10-28 10:15
TASK: Review attack montage blend timings

### [A-3] Antigravity -> Claude, 2026-10-28 10:30
TASK: Unreal physics substepping verification
`, 'utf8');

  // Clean state files
  if (fs.existsSync(TEST_STATE)) fs.unlinkSync(TEST_STATE);
  if (fs.existsSync(TEST_REGISTRY)) fs.unlinkSync(TEST_REGISTRY);
  if (fs.existsSync(TEST_USAGE)) fs.unlinkSync(TEST_USAGE);

  const stateStore = new StateStore({ statePath: TEST_STATE });
  const agentRegistry = new AgentRegistry({ registryPath: TEST_REGISTRY });
  const mailboxService = new MailboxDomainService({ mailboxPath: TEST_MAILBOX });
  const taskService = new TaskDomainService({ stateStore });
  const agentService = new AgentDomainService({ agentRegistry });
  const usageService = new UsageDomainService({ storagePath: TEST_USAGE });

  // Initialize tasks in stateStore
  const allMsgs = await mailboxService.getAllMessages();
  for (const m of allMsgs) {
    stateStore.getOrCreateTask(m);
  }

  // Test 1: Mailbox parsing & query
  try {
    assert.strictEqual(allMsgs.length, 3, 'Should parse 3 messages');
    const msg1 = await mailboxService.getMessageById('X-1');
    assert.ok(msg1, 'Message X-1 must be found');
    assert.strictEqual(msg1.sender, 'Codex');
    assert.strictEqual(msg1.recipientRaw, 'Claude');
    report('Test 1: MailboxDomainService parses messages and finds by ID', true);
  } catch (e) {
    report('Test 1: MailboxDomainService parses messages and finds by ID', false, e);
  }

  // Test 2: Pending messages filtered strictly by recipient
  try {
    const claudePending = await mailboxService.getPendingMessagesForAgent('Claude', stateStore);
    assert.strictEqual(claudePending.length, 2, 'Claude has 2 pending messages (X-1 and A-3)');
    assert.ok(claudePending.some(m => m.id === 'X-1'));
    assert.ok(claudePending.some(m => m.id === 'A-3'));

    const codexPending = await mailboxService.getPendingMessagesForAgent('Codex', stateStore);
    assert.strictEqual(codexPending.length, 1, 'Codex has 1 pending message (C-2)');
    assert.strictEqual(codexPending[0].id, 'C-2');

    report('Test 2: MailboxDomainService filters pending messages strictly by recipient', true);
  } catch (e) {
    report('Test 2: MailboxDomainService filters pending messages strictly by recipient', false, e);
  }

  // Test 3: Unauthorized task claim rejection
  try {
    let errorCaught = false;
    try {
      // Codex attempting to claim X-1 (which is addressed to Claude)
      await taskService.claimMessage({ messageId: 'X-1', agentId: 'Codex' });
    } catch (err) {
      errorCaught = true;
      assert.ok(err.message.includes('Unauthorized'), 'Error message should mention unauthorized');
    }
    assert.ok(errorCaught, 'Codex must not be permitted to claim message addressed to Claude');
    report('Test 3: TaskDomainService rejects unauthorized claims by non-recipients', true);
  } catch (e) {
    report('Test 3: TaskDomainService rejects unauthorized claims by non-recipients', false, e);
  }

  // Test 4: Authorized atomic claim
  try {
    const claimRes = await taskService.claimMessage({ messageId: 'X-1', agentId: 'Claude', workerId: 'worker-claude-1' });
    assert.strictEqual(claimRes.success, true);
    assert.strictEqual(claimRes.status, 'CLAIMED');
    assert.strictEqual(claimRes.claimOwner, 'worker-claude-1');

    const task = stateStore.getTask('X-1');
    assert.strictEqual(task.status, 'CLAIMED');
    assert.strictEqual(task.claimOwner, 'worker-claude-1');

    report('Test 4: TaskDomainService atomically claims eligible message for designated recipient', true);
  } catch (e) {
    report('Test 4: TaskDomainService atomically claims eligible message for designated recipient', false, e);
  }

  // Test 5: Conflicting concurrent claim rejection while lease is active
  try {
    let conflictCaught = false;
    try {
      await taskService.claimMessage({ messageId: 'X-1', agentId: 'Claude', workerId: 'worker-claude-2' });
    } catch (err) {
      conflictCaught = true;
      assert.ok(err.message.includes('already claimed'), 'Should indicate already claimed');
    }
    assert.ok(conflictCaught, 'Conflicting claim during active lease must be rejected');
    report('Test 5: TaskDomainService prevents double-claim race conditions during active lease', true);
  } catch (e) {
    report('Test 5: TaskDomainService prevents double-claim race conditions during active lease', false, e);
  }

  // Test 6: Task status transition to RUNNING
  try {
    const updateRes = await taskService.updateStatus({
      messageId: 'X-1',
      status: 'RUNNING',
      agentId: 'Claude',
      workerId: 'worker-claude-1'
    });
    assert.strictEqual(updateRes.status, 'RUNNING');
    const task = stateStore.getTask('X-1');
    assert.strictEqual(task.status, 'RUNNING');
    report('Test 6: TaskDomainService transitions task to RUNNING', true);
  } catch (e) {
    report('Test 6: TaskDomainService transitions task to RUNNING', false, e);
  }

  // Test 7: Task completion with evidence and history tracking
  try {
    const compRes = await taskService.completeTask({
      messageId: 'X-1',
      agentId: 'Claude',
      responseMessageId: 'C-99',
      evidence: { gitDiffChecked: true }
    });
    assert.strictEqual(compRes.status, 'COMPLETED');
    const task = stateStore.getTask('X-1');
    assert.strictEqual(task.status, 'COMPLETED');
    assert.ok(task.resultEvidence);

    // Verify task history
    const history = taskService.getTaskHistory('X-1');
    assert.ok(history.events.length >= 3, 'History should track CLAIMED, RUNNING, COMPLETED');

    report('Test 7: TaskDomainService records completion, evidence, and event history', true);
  } catch (e) {
    report('Test 7: TaskDomainService records completion, evidence, and event history', false, e);
  }

  // Test 8: Completed task is removed from pending
  try {
    const claudePendingAfter = await mailboxService.getPendingMessagesForAgent('Claude', stateStore);
    assert.strictEqual(claudePendingAfter.length, 1, 'Only A-3 should remain pending for Claude');
    assert.strictEqual(claudePendingAfter[0].id, 'A-3');
    report('Test 8: Completed task is immediately excluded from pending queries', true);
  } catch (e) {
    report('Test 8: Completed task is immediately excluded from pending queries', false, e);
  }

  // Test 9: Task failure, attempt tracking, and retry
  try {
    await taskService.claimMessage({ messageId: 'C-2', agentId: 'Codex', workerId: 'worker-codex-1' });
    const failRes = await taskService.failTask({
      messageId: 'C-2',
      agentId: 'Codex',
      error: 'Simulated compiler error',
      isPermanent: false
    });
    assert.strictEqual(failRes.status, 'RETRYABLE_FAILED');
    assert.strictEqual(failRes.attempts, 1);

    // Requeue
    const retryRes = await taskService.retryTask('C-2');
    assert.strictEqual(retryRes.status, 'PENDING');
    const taskC2 = stateStore.getTask('C-2');
    assert.strictEqual(taskC2.status, 'PENDING');

    report('Test 9: TaskDomainService handles failure, attempt counting, and requeue', true);
  } catch (e) {
    report('Test 9: TaskDomainService handles failure, attempt counting, and requeue', false, e);
  }

  // Test 10: Task cancellation
  try {
    const cancelRes = await taskService.cancelTask('A-3', 'Operator cancelled task');
    assert.strictEqual(cancelRes.status, 'CANCELLED');
    const taskA3 = stateStore.getTask('A-3');
    assert.strictEqual(taskA3.status, 'CANCELLED');
    report('Test 10: TaskDomainService cancels task safely with audit reason', true);
  } catch (e) {
    report('Test 10: TaskDomainService cancels task safely with audit reason', false, e);
  }

  // Test 11: AgentDomainService pause and resume
  try {
    const paused = agentService.pauseAgent('Codex');
    assert.strictEqual(paused.paused, true);
    const agent = agentService.getAgent('Codex');
    assert.strictEqual(agent.paused, true);

    const resumed = agentService.resumeAgent('Codex');
    assert.strictEqual(resumed.paused, false);
    report('Test 11: AgentDomainService manages pause and resume lifecycle', true);
  } catch (e) {
    report('Test 11: AgentDomainService manages pause and resume lifecycle', false, e);
  }

  // Test 12: UsageDomainService metrics and honest quota reporting
  try {
    usageService.recordTaskUsage('Claude', 4500, 1200, 800);
    usageService.recordTaskUsage('Claude', 2500, 600, 400);
    usageService.recordTaskUsage('Codex', 3000, 800, 500);

    const summary = usageService.getUsageSummary();
    assert.strictEqual(summary.aggregated.totalTasks, 3);
    assert.strictEqual(summary.aggregated.totalComputeDurationMs, 10000);
    assert.ok(summary.quotas.length >= 3);

    // Check Claude quotas
    const claudeQuota = summary.quotas.find(q => q.agentId === 'Claude');
    assert.ok(claudeQuota);
    assert.strictEqual(claudeQuota.fiveHourQuota.state, 'Unavailable', 'Subscription quota must be explicitly marked Unavailable');
    assert.strictEqual(claudeQuota.taskMetrics.tasksExecuted, 2);
    assert.strictEqual(claudeQuota.taskMetrics.totalComputeMs, 7000);

    report('Test 12: UsageDomainService records task compute and reports quota transparency', true);
  } catch (e) {
    report('Test 12: UsageDomainService records task compute and reports quota transparency', false, e);
  }

  // Clean test files
  try {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  } catch (_) {}

  console.log('\n===================================================================');
  console.log(`DOMAIN SERVICES SUMMARY: ${passed} PASSED, ${failed} FAILED (Total: ${passed + failed})`);
  console.log('===================================================================');

  if (failed > 0) process.exit(1);
}

runTests().catch(err => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
