/**
 * test_board_concurrency.js
 * Several processes (broker + MCP servers) share one board.json. Every write must survive:
 * no lost moves, no lost tasks, no reissued ids, no torn files.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const BoardDomainService = require('../src/domain/BoardDomainService');
const { withFileLockSync } = require('../src/domain/FileLock');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mst-board-'));
const WORKER = path.join(__dirname, 'helpers', 'board_worker.js');

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`[PASS] ${name}`);
  } catch (err) {
    failed++;
    console.log(`[FAIL] ${name}: ${err.message}`);
  }
}

// Runs one worker process; resolves with its parsed results
function runWorker(job) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [WORKER, JSON.stringify(job)], { shell: false });
    let out = '';
    let err = '';
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', d => { err += d; });
    p.on('close', (code) => {
      if (code !== 0) return reject(new Error(`worker exit ${code}: ${err}`));
      try { resolve(JSON.parse(out)); } catch (e) { reject(new Error(`bad worker output: ${out} ${err}`)); }
    });
  });
}

// Creates a board with n tasks BT-1..BT-n in "todo"
function seedBoard(file, n) {
  const svc = new BoardDomainService({ storagePath: file });
  for (let i = 1; i <= n; i++) svc.createTask({ title: `task ${i}`, column: 'todo', createdBy: 'Seed' });
  return svc;
}

const readBoard = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

async function run() {
  console.log('===================================================================');
  console.log('RUNNING BOARD CONCURRENCY SUITE');
  console.log('===================================================================\n');

  await test('Two processes moving different tasks at the same moment both persist (with history)', async () => {
    const file = path.join(TMP, 'moves', 'board.json');
    seedBoard(file, 20);
    const startAt = Date.now() + 1500; // both workers are loaded before the barrier opens
    const ops = (from, to, column) => {
      const list = [];
      for (let i = from; i <= to; i++) list.push({ op: 'move', id: `BT-${i}`, column });
      return list;
    };
    const [a, b] = await Promise.all([
      runWorker({ boardPath: file, startAt, actor: 'Claude', ops: ops(1, 10, 'done') }),
      runWorker({ boardPath: file, startAt, actor: 'Codex', ops: ops(11, 20, 'review') })
    ]);
    assert.ok([...a, ...b].every(r => r.ok), JSON.stringify([...a, ...b].filter(r => !r.ok)));

    const board = readBoard(file);
    for (const t of board.tasks) {
      const n = parseInt(t.id.slice(3), 10);
      const want = n <= 10 ? 'done' : 'review';
      assert.strictEqual(t.column, want, `${t.id} is in "${t.column}", expected "${want}"`);
      assert.ok(t.history.some(h => h.action === 'moved' && h.detail.includes(want)), `${t.id} lost its move history`);
    }
  });

  await test('Concurrent creates from 3 processes get unique ids and none are lost', async () => {
    const file = path.join(TMP, 'creates', 'board.json');
    seedBoard(file, 24); // like the real board: next id is BT-25
    const startAt = Date.now() + 1500;
    const creates = (who) => Array.from({ length: 6 }, (_, i) => ({ op: 'create', title: `${who} ${i}` }));
    const results = await Promise.all(['Claude', 'Codex', 'Antigravity'].map(actor =>
      runWorker({ boardPath: file, startAt, actor, ops: creates(actor) })));
    const ids = results.flat().map(r => r.id);
    assert.strictEqual(new Set(ids).size, 18, `duplicate ids issued: ${ids.join(', ')}`);

    const board = readBoard(file);
    assert.strictEqual(board.tasks.length, 24 + 18, `expected 42 tasks, file has ${board.tasks.length}`);
    for (const id of ids) assert.ok(board.tasks.some(t => t.id === id), `${id} was reported created but is not in the file`);
    assert.strictEqual(board.nextId, 43);
  });

  await test('Mixed moves, comments and creates across processes all land', async () => {
    const file = path.join(TMP, 'mixed', 'board.json');
    seedBoard(file, 6);
    const startAt = Date.now() + 1500;
    const [a, b] = await Promise.all([
      runWorker({ boardPath: file, startAt, actor: 'Claude', ops: [
        { op: 'move', id: 'BT-1', column: 'done' }, { op: 'comment', id: 'BT-2', text: 'from claude' },
        { op: 'create', title: 'claude new' }, { op: 'move', id: 'BT-3', column: 'review' }
      ] }),
      runWorker({ boardPath: file, startAt, actor: 'Codex', ops: [
        { op: 'comment', id: 'BT-1', text: 'from codex' }, { op: 'move', id: 'BT-2', column: 'in-progress' },
        { op: 'create', title: 'codex new' }, { op: 'move', id: 'BT-4', column: 'done' }
      ] })
    ]);
    assert.ok([...a, ...b].every(r => r.ok), JSON.stringify([...a, ...b]));
    const byId = Object.fromEntries(readBoard(file).tasks.map(t => [t.id, t]));
    assert.strictEqual(byId['BT-1'].column, 'done');
    assert.ok(byId['BT-1'].comments.some(c => c.text === 'from codex'));
    assert.strictEqual(byId['BT-2'].column, 'in-progress');
    assert.ok(byId['BT-2'].comments.some(c => c.text === 'from claude'));
    assert.strictEqual(byId['BT-3'].column, 'review');
    assert.strictEqual(byId['BT-4'].column, 'done');
    assert.ok(byId['BT-7'] && byId['BT-8'], 'both new tasks exist');
  });

  await test('A long-lived service never writes back its stale copy over another process\'s change', () => {
    const file = path.join(TMP, 'stale', 'board.json');
    const broker = seedBoard(file, 3);   // e.g. the broker, loaded long ago
    const mcp = new BoardDomainService({ storagePath: file }); // an MCP server
    mcp.moveTask('BT-1', 'done', 'Claude');
    mcp.createTask({ title: 'made by mcp', createdBy: 'Claude' });
    broker.moveTask('BT-2', 'review', 'Dashboard'); // must not undo the MCP server's work
    const byId = Object.fromEntries(readBoard(file).tasks.map(t => [t.id, t]));
    assert.strictEqual(byId['BT-1'].column, 'done');
    assert.strictEqual(byId['BT-2'].column, 'review');
    assert.ok(byId['BT-4'], 'BT-4 survives');
    assert.strictEqual(broker.getTask('BT-4').title, 'made by mcp', 'reads see other processes\' tasks');
    assert.strictEqual(broker.createTask({ title: 'next' }).id, 'BT-5', 'ids are not reissued');
  });

  await test('Deleted ids are never reissued, even if nextId in the file is behind', () => {
    const file = path.join(TMP, 'ids', 'board.json');
    const svc = seedBoard(file, 3);
    svc.deleteTask('BT-3');
    assert.strictEqual(svc.createTask({ title: 'x' }).id, 'BT-4');
    const raw = readBoard(file);
    raw.nextId = 2; // simulate an old file
    fs.writeFileSync(file, JSON.stringify(raw));
    assert.strictEqual(svc.createTask({ title: 'y' }).id, 'BT-5');
  });

  await test('A corrupt board file is never replaced by an empty board', () => {
    const file = path.join(TMP, 'corrupt', 'board.json');
    const svc = seedBoard(file, 2);
    fs.writeFileSync(file, '{"tasks": [ {"id": "BT-1"'); // torn / hand-broken file
    assert.throws(() => svc.moveTask('BT-1', 'done'), /JSON|Unexpected|end/i);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), '{"tasks": [ {"id": "BT-1"', 'file left untouched');
  });

  await test('A lock left behind by a dead process is taken over', () => {
    const file = path.join(TMP, 'stalelock', 'board.json');
    const svc = seedBoard(file, 1);
    fs.writeFileSync(`${file}.lock`, `999999:${Date.now()}:dead`); // pid that does not exist
    svc.moveTask('BT-1', 'done', 'Claude');
    assert.strictEqual(readBoard(file).tasks[0].column, 'done');
    assert.ok(!fs.existsSync(`${file}.lock`), 'lock released');
  });

  await test('A lock held by a live process makes writers wait, then time out cleanly', () => {
    const file = path.join(TMP, 'held', 'board.json');
    const svc = new BoardDomainService({ storagePath: file, lockTimeoutMs: 200 });
    svc.createTask({ title: 'a' });
    withFileLockSync(file, () => {
      assert.throws(() => svc.moveTask('BT-1', 'done'), /Could not acquire lock/);
    });
    assert.strictEqual(readBoard(file).tasks[0].column, 'backlog');
    svc.moveTask('BT-1', 'done');
    assert.strictEqual(readBoard(file).tasks[0].column, 'done');
  });

  console.log('\n===================================================================');
  console.log(`BOARD CONCURRENCY SUMMARY: ${passed} PASSED, ${failed} FAILED (Total: ${passed + failed})`);
  console.log('===================================================================');
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => {
  console.error(`Fatal: ${err.stack || err.message}`);
  process.exit(1);
});
