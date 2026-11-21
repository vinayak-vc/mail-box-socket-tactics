/**
 * test_state_concurrency.js
 * The broker and several MCP servers share one mailbox_state.json. Claims and completions
 * must never be lost and a message must never be claimed twice.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const StateStore = require('../src/broker/StateStore');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mst-state-'));
const WORKER = path.join(__dirname, 'helpers', 'state_worker.js');
let passed = 0;
let failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`[PASS] ${name}`); }
  catch (err) { failed++; console.log(`[FAIL] ${name}: ${err.message}`); }
}

function runWorker(job) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [WORKER, JSON.stringify(job)], { shell: false });
    let out = ''; let err = '';
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', d => { err += d; });
    p.on('close', code => {
      if (code !== 0) return reject(new Error(`worker exit ${code}: ${err}`));
      try { resolve(JSON.parse(out)); } catch (e) { reject(new Error(`bad output: ${out} ${err}`)); }
    });
  });
}
const readState = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const ids = (prefix, n) => Array.from({ length: n }, (_, i) => `${prefix}-${i + 1}`);

async function run() {
  console.log('===================================================================');
  console.log('RUNNING STATE STORE CONCURRENCY SUITE');
  console.log('===================================================================\n');

  await test('Two processes creating and completing different tasks at once both persist', async () => {
    const f = path.join(TMP, 'a', 'state.json');
    const startAt = Date.now() + 1500;
    const mk = (who, prefix) => ({
      statePath: f, startAt, workerId: who,
      ops: [...ids(prefix, 8).map(id => ({ op: 'create', id })),
            ...ids(prefix, 8).map(id => ({ op: 'claim', id })),
            ...ids(prefix, 8).map(id => ({ op: 'complete', id }))]
    });
    const [a, b] = await Promise.all([runWorker(mk('Claude', 'C')), runWorker(mk('Codex', 'X'))]);
    assert.ok([...a, ...b].every(r => r.ok), JSON.stringify([...a, ...b].filter(r => !r.ok)));
    const tasks = readState(f).tasks;
    assert.strictEqual(Object.keys(tasks).length, 16);
    for (const [id, t] of Object.entries(tasks)) {
      assert.strictEqual(t.status, 'COMPLETED', `${id} is ${t.status}`);
      assert.strictEqual(t.resultEvidence, `by ${id.startsWith('C') ? 'Claude' : 'Codex'}`);
    }
  });

  await test('Of 4 processes racing to claim the same 10 messages, each message is claimed exactly once', async () => {
    const f = path.join(TMP, 'b', 'state.json');
    const seed = new StateStore({ statePath: f });
    for (const id of ids('M', 10)) seed.getOrCreateTask({ messageId: id, sender: 'H' });
    const startAt = Date.now() + 1500;
    const workers = ['Claude', 'Codex', 'Antigravity', 'Broker'];
    const results = await Promise.all(workers.map(w =>
      runWorker({ statePath: f, startAt, workerId: w, ops: ids('M', 10).map(id => ({ op: 'claim', id })) })));
    const wins = {};
    results.forEach((res, i) => res.forEach(r => { if (r.ok) (wins[r.id] = wins[r.id] || []).push(workers[i]); }));
    for (const id of ids('M', 10)) {
      assert.strictEqual((wins[id] || []).length, 1, `${id} claimed by ${JSON.stringify(wins[id])}`);
    }
    const tasks = readState(f).tasks;
    for (const id of ids('M', 10)) {
      assert.strictEqual(tasks[id].attemptCount, 1, `${id} attemptCount ${tasks[id].attemptCount}`);
      assert.strictEqual(tasks[id].claimOwner, wins[id][0]);
    }
  });

  await test('A long-lived store never overwrites another process change with its stale copy', () => {
    const f = path.join(TMP, 'c', 'state.json');
    const broker = new StateStore({ statePath: f });
    const mcp = new StateStore({ statePath: f });
    broker.getOrCreateTask({ messageId: 'A-1' });
    mcp.getOrCreateTask({ messageId: 'A-2' });          // broker copy has not seen A-2
    mcp.claimTask('A-1', 'Claude');
    broker.getOrCreateTask({ messageId: 'A-3' });       // must keep A-2 and the claim
    const t = readState(f).tasks;
    assert.deepStrictEqual(Object.keys(t).sort(), ['A-1', 'A-2', 'A-3']);
    assert.strictEqual(t['A-1'].claimOwner, 'Claude');
    assert.strictEqual(broker.getTask('A-2').messageId, 'A-2', 'reads see other processes tasks');
    assert.strictEqual(broker.claimTask('A-1', 'Codex'), false, 'claim by a second worker is refused');
  });

  await test('Dead letters and requeue persist across processes', () => {
    const f = path.join(TMP, 'd', 'state.json');
    const a = new StateStore({ statePath: f, maxRetries: 1 });
    const b = new StateStore({ statePath: f, maxRetries: 1 });
    a.getOrCreateTask({ messageId: 'D-1' });
    a.claimTask('D-1', 'Codex');
    const r = b.markFailed('D-1', 'Codex', 'boom');
    assert.strictEqual(r.deadLetter, true);
    assert.ok(a.deadLetters.has('D-1'), 'other process sees the dead letter');
    assert.strictEqual(a.requeue('D-1'), true);
    assert.strictEqual(b.deadLetters.size, 0);
    assert.strictEqual(b.getTask('D-1').status, 'PENDING');
  });

  await test('updateTask edits one task under the lock and returns null for a missing task', () => {
    const f = path.join(TMP, 'e', 'state.json');
    const s = new StateStore({ statePath: f });
    s.getOrCreateTask({ messageId: 'E-1' });
    assert.strictEqual(s.updateTask('E-1', t => { t.status = 'CANCELLED'; }).status, 'CANCELLED');
    assert.strictEqual(readState(f).tasks['E-1'].status, 'CANCELLED');
    assert.strictEqual(s.updateTask('nope', () => {}), null);
  });

  await test('A corrupt state file is moved aside, not silently overwritten', () => {
    const f = path.join(TMP, 'f', 'state.json');
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, '{"tasks": {"X-1": {');
    const s = new StateStore({ statePath: f });
    s.getOrCreateTask({ messageId: 'F-1' });
    const aside = fs.readdirSync(path.dirname(f)).filter(n => n.includes('.corrupt-'));
    assert.strictEqual(aside.length, 1, 'broken file preserved');
    assert.strictEqual(fs.readFileSync(path.join(path.dirname(f), aside[0]), 'utf8'), '{"tasks": {"X-1": {');
    assert.ok(readState(f).tasks['F-1']);
  });

  await test('Expired leases are reconciled and persisted; save() is a harmless no-op', () => {
    const f = path.join(TMP, 'g', 'state.json');
    const s = new StateStore({ statePath: f });
    s.getOrCreateTask({ messageId: 'G-1' });
    s.claimTask('G-1', 'Codex', -1000); // already expired
    assert.strictEqual(s.reconcileCrashedTasks(), 1);
    assert.strictEqual(readState(f).tasks['G-1'].status, 'RETRYABLE_FAILED');
    const before = fs.readFileSync(f, 'utf8');
    s.save();
    assert.strictEqual(fs.readFileSync(f, 'utf8'), before);
  });

  console.log('\n===================================================================');
  console.log(`STATE CONCURRENCY SUMMARY: ${passed} PASSED, ${failed} FAILED (Total: ${passed + failed})`);
  console.log('===================================================================');
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
  process.exit(failed > 0 ? 1 : 0);
}
run().catch(err => { console.error(`Fatal: ${err.stack || err.message}`); process.exit(1); });
