/**
 * test_projects_suite.js
 * Multi-project support: config loading (legacy + multi), the "tel" heading format,
 * per-project isolation in the broker (HTTP + WebSocket), concurrent sessions of one
 * agent, and the MCP `project` argument.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');
const EventBroker = require('../src/broker/EventBroker');
const McpServer = require('../src/mcp/McpServer');
const { normalizeProjects } = require('../src/config/ProjectConfig');
const { parseMailboxMessages } = require('../src/protocol/MessageProtocol');

const WS_PORT = 9980;
const HTTP_PORT = 9981;
const TOKEN = 'test-only-token-not-a-secret';
const REPO_ROOT = path.resolve(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mst-projects-'));

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`[PASS] ${name}`);
  } catch (err) {
    failed++;
    console.error(`[FAIL] ${name}: ${err.message}`);
  }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function request(method, pathname, body = null) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({
      hostname: '127.0.0.1', port: HTTP_PORT, path: pathname, method,
      headers: { 'Authorization': `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }
    }, res => {
      let d = '';
      res.on('data', c => { d += c; });
      res.on('end', () => {
        let parsed = d;
        try { parsed = JSON.parse(d); } catch (_) {}
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

/** Opens an authenticated broker socket and records every message it receives */
function connectAgent(agentId, extra = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${WS_PORT}`);
    const received = [];
    ws.on('open', () => ws.send(JSON.stringify({ type: 'AUTH_REQUEST', agentId, token: TOKEN, ...extra })));
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      received.push(msg);
      if (msg.type === 'AUTH_RESPONSE') {
        if (msg.success) resolve({ ws, received });
        else reject(new Error('auth failed'));
      }
    });
    ws.on('error', reject);
  });
}

// ─── Fixtures ──────────────────────────────────────────────────
const ALPHA_MB = path.join(TMP, 'alpha', 'TEAM_MAILBOX.md');
const BETA_MB = path.join(TMP, 'beta', 'TEAM_MAILBOX.md');
const TEL_MB = path.join(TMP, 'tel', 'MAILBOX.md');
for (const p of [ALPHA_MB, BETA_MB, TEL_MB]) fs.mkdirSync(path.dirname(p), { recursive: true });
fs.writeFileSync(ALPHA_MB, '# Alpha mailbox\n');
fs.writeFileSync(BETA_MB, '# Beta mailbox\n');
fs.writeFileSync(TEL_MB, [
  '# Tel_Mailbox', '',
  'Header format: `## [MSG-###] FROM -> TO | YYYY-MM-DD | STATUS`', '', '---', '',
  '## [MSG-001] C -> A | 2026-11-20 | OPEN',
  'Subject: kickoff', '', '### 0. Ground rules', '1. rule one', '',
  '## [MSG-002] A -> C | 2026-11-20 | BLOCKED',
  'Subject: toolchain missing', ''
].join('\n'));

const projectsConfig = {
  defaultProject: 'alpha',
  projects: {
    alpha: { name: 'Alpha', mailbox: { path: ALPHA_MB, mutexName: 'Global\\TestAlphaMailbox' }, statePath: path.join(TMP, 'alpha_state.json'), boardPath: path.join(TMP, 'alpha_board.json') },
    beta: { name: 'Beta', mailbox: { path: BETA_MB, mutexName: 'Global\\TestBetaMailbox' }, statePath: path.join(TMP, 'beta_state.json'), boardPath: path.join(TMP, 'beta_board.json') },
    tel: { name: 'Tel Project', mailbox: { path: TEL_MB, headerFormat: 'tel' }, statePath: path.join(TMP, 'tel_state.json'), boardPath: path.join(TMP, 'tel_board.json') }
  }
};

async function run() {
  console.log('===================================================================');
  console.log('   MAILSOCKETTACTICS MULTI-PROJECT TEST SUITE                      ');
  console.log('===================================================================\n');

  // ─── 1. Config loading ───────────────────────────────────────
  await test('Legacy single "mailbox" block loads as one default project with legacy data files', () => {
    const { defaultProject, projects } = normalizeProjects({ mailbox: { path: ALPHA_MB, mutexName: 'Global\\X' } }, { root: REPO_ROOT });
    assert.strictEqual(projects.length, 1);
    assert.strictEqual(defaultProject, 'default');
    assert.strictEqual(projects[0].mailboxPath, path.normalize(ALPHA_MB));
    assert.strictEqual(projects[0].mutexName, 'Global\\X');
    assert.strictEqual(projects[0].headerFormat, 'broker');
    assert.strictEqual(projects[0].statePath, path.join(REPO_ROOT, 'data', 'mailbox_state.json'));
    assert.strictEqual(projects[0].boardPath, path.join(REPO_ROOT, 'data', 'board.json'));
  });

  await test('Legacy fallbackPath is used when the primary mailbox is missing', () => {
    const { projects } = normalizeProjects({ mailbox: { path: path.join(TMP, 'nope.md'), fallbackPath: ALPHA_MB } });
    assert.strictEqual(projects[0].mailboxPath, path.normalize(ALPHA_MB));
    assert.strictEqual(projects[0].usingFallback, true);
  });

  await test('Multi-project config loads every project with its own state/board defaults', () => {
    const { defaultProject, projects } = normalizeProjects({
      defaultProject: 'two',
      projects: {
        one: { name: 'One', mailbox: { path: ALPHA_MB } },
        two: { mailboxPath: BETA_MB, mutexName: 'Global\\Two', headerFormat: 'tel' }
      }
    }, { root: REPO_ROOT });
    assert.strictEqual(defaultProject, 'two');
    assert.deepStrictEqual(projects.map(p => p.id), ['one', 'two']);
    assert.strictEqual(projects[0].name, 'One');
    assert.strictEqual(projects[1].name, 'two');
    assert.strictEqual(projects[1].headerFormat, 'tel');
    assert.strictEqual(projects[1].mutexName, 'Global\\Two');
    assert.strictEqual(projects[0].statePath, path.join(REPO_ROOT, 'data', 'projects', 'one', 'mailbox_state.json'));
    assert.strictEqual(projects[1].boardPath, path.join(REPO_ROOT, 'data', 'projects', 'two', 'board.json'));
  });

  await test('"projects" takes precedence over the legacy "mailbox" block; first project is default', () => {
    const { defaultProject, projects } = normalizeProjects({
      mailbox: { path: TEL_MB },
      projects: { only: { mailbox: { path: ALPHA_MB } } }
    });
    assert.strictEqual(projects.length, 1);
    assert.strictEqual(defaultProject, 'only');
  });

  await test('Invalid project configs are rejected with clear errors', () => {
    assert.throws(() => normalizeProjects({ projects: { 'Bad Id': { mailbox: { path: ALPHA_MB } } } }), /Invalid project id/);
    assert.throws(() => normalizeProjects({ projects: { a: { name: 'no path' } } }), /no mailbox path/);
    assert.throws(() => normalizeProjects({ defaultProject: 'zzz', projects: { a: { mailbox: { path: ALPHA_MB } } } }), /defaultProject 'zzz'/);
    assert.throws(() => normalizeProjects({ projects: { a: { mailbox: { path: ALPHA_MB, headerFormat: 'yaml' } } } }), /unknown headerFormat/);
    assert.deepStrictEqual(normalizeProjects({}).projects, []);
  });

  // ─── 2. Tel heading format ───────────────────────────────────
  await test('Tel heading format parses ids, parties, recipients, status and keeps ### sub-headings in the body', () => {
    const text = fs.readFileSync(TEL_MB, 'utf8');
    const msgs = parseMailboxMessages(text, { format: 'tel' });
    assert.strictEqual(msgs.length, 2);
    assert.strictEqual(msgs[0].id, 'MSG-001');
    assert.strictEqual(msgs[0].number, 1);
    assert.strictEqual(msgs[0].party, 'C');
    assert.strictEqual(msgs[0].sender, 'C');
    assert.strictEqual(msgs[0].recipientRaw, 'A');
    assert.strictEqual(msgs[0].timestamp, '2026-11-20');
    assert.strictEqual(msgs[0].status, 'OPEN');
    assert.ok(msgs[0].body.includes('### 0. Ground rules'));
    assert.strictEqual(msgs[1].status, 'BLOCKED');
    // The broker format must not pick up tel headings (and vice versa)
    assert.strictEqual(parseMailboxMessages(text).length, 0);
    assert.strictEqual(parseMailboxMessages('### [C-1] Claude -> Codex, 2026-11-20 10:00\nx', { format: 'tel' }).length, 0);
  });

  await test('Tel parser accepts date-only, date+time and ISO timestamps in the same mailbox', () => {
    const text = [
      '## [MSG-001] C -> A | 2026-11-20 | OPEN', 'old date-only',
      '## [MSG-002] A -> C | 2026-11-20 14:45 | ACK', 'new with time',
      '## [MSG-003] C -> X | 2026-11-20T14:45:12+05:30 | REVIEW', 'iso'
    ].join('\n');
    const msgs = parseMailboxMessages(text, { format: 'tel' });
    assert.deepStrictEqual(msgs.map(m => [m.id, m.timestamp, m.status]), [
      ['MSG-001', '2026-11-20', 'OPEN'],
      ['MSG-002', '2026-11-20 14:45', 'ACK'],
      ['MSG-003', '2026-11-20T14:45:12+05:30', 'REVIEW']
    ]);
  });

  if (process.platform === 'win32') {
    await test('MailboxPostSocket.ps1 -Format tel writes a local date AND time in the heading', () => {
      const { execFileSync } = require('child_process');
      const mb = path.join(TMP, 'post_tel', 'MAILBOX.md');
      fs.mkdirSync(path.dirname(mb), { recursive: true });
      fs.writeFileSync(mb, '# Tel\n\n## [MSG-001] C -> A | 2026-11-20 | OPEN\nold\n');
      const out = execFileSync('powershell.exe', [
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(REPO_ROOT, 'scripts', 'MailboxPostSocket.ps1'),
        '-As', 'C', '-To', 'Antigravity', '-Body', 'time test', '-Mailbox', mb,
        '-MutexName', 'Global\\MstTestTelMailbox', '-Format', 'tel', '-Project', 'tel',
        '-HttpPort', '9', '-AuthToken', TOKEN
      ], { encoding: 'utf8' });
      assert.ok(/POSTED MSG-002/.test(out), out);
      const msgs = parseMailboxMessages(fs.readFileSync(mb, 'utf8'), { format: 'tel' });
      assert.strictEqual(msgs.length, 2, 'old date-only header still parses next to the new one');
      assert.match(msgs[1].timestamp, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/, `got '${msgs[1].timestamp}'`);
      assert.strictEqual(msgs[1].recipientRaw, 'A');
      assert.strictEqual(msgs[1].status, 'OPEN');
    });
  }

  // ─── 3. Broker isolation ─────────────────────────────────────
  const broker = new EventBroker({
    port: WS_PORT, httpPort: HTTP_PORT, authToken: TOKEN,
    heartbeatIntervalMs: 60000,
    registryPath: path.join(TMP, 'registry.json'),
    logFilePath: path.join(TMP, 'activity.jsonl'),
    usageStoragePath: path.join(TMP, 'usage.json'),
    ...projectsConfig
  });
  await broker.start();

  const sockets = [];
  try {
    await test('Broker creates one watcher + state store per project and exposes /api/projects', async () => {
      assert.strictEqual(broker.projects.size, 3);
      assert.strictEqual(broker.defaultProjectId, 'alpha');
      assert.notStrictEqual(broker.getProject('alpha').stateStore, broker.getProject('beta').stateStore);
      const res = await request('GET', '/api/projects');
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.defaultProject, 'alpha');
      assert.deepStrictEqual(res.body.projects.map(p => p.id), ['alpha', 'beta', 'tel']);
      assert.ok(res.body.projects.every(p => p.exists && p.watcherRunning));
      assert.strictEqual(res.body.projects.find(p => p.id === 'tel').headerFormat, 'tel');
    });

    // Codex scoped to alpha, Antigravity unscoped (all projects)
    const codex = await connectAgent('Codex', { projects: ['alpha'], instanceId: 'codex-1' });
    const ag = await connectAgent('Antigravity', { instanceId: 'ag-1' });
    sockets.push(codex.ws, ag.ws);

    // Same message id "C-1" in two projects
    fs.appendFileSync(ALPHA_MB, '\n### [C-1] Claude -> Codex, 2026-11-20 10:00\nTASK: alpha work\n');
    fs.appendFileSync(BETA_MB, '\n### [C-1] Claude -> Codex, Antigravity, 2026-11-20 10:05\nTASK: beta work\n');
    fs.appendFileSync(TEL_MB, '\n## [MSG-003] C -> A | 2026-11-21 | OPEN\nSubject: tel work\n');
    const pub = await request('POST', '/publish', {});
    await sleep(200);

    await test('/publish without a project re-scans every project mailbox', () => {
      assert.strictEqual(pub.status, 200);
      assert.strictEqual(pub.body.newMessagesFound, 3);
    });

    await test('A message in project A never shows up in project B (mailbox API)', async () => {
      const a = await request('GET', '/api/mailbox?project=alpha');
      const b = await request('GET', '/api/mailbox?project=beta');
      const t = await request('GET', '/api/mailbox?project=tel');
      const def = await request('GET', '/api/mailbox');
      assert.strictEqual(a.body.project, 'alpha');
      assert.deepStrictEqual(a.body.messages.map(m => m.body), ['TASK: alpha work']);
      assert.deepStrictEqual(b.body.messages.map(m => m.body), ['TASK: beta work']);
      assert.deepStrictEqual(t.body.messages.map(m => m.id), ['MSG-001', 'MSG-002', 'MSG-003']);
      assert.ok(t.body.messages.every(m => m.project === 'tel'));
      assert.strictEqual(def.body.project, 'alpha', 'missing project param uses the default project');
    });

    await test('Task state is isolated per project even when message ids collide', async () => {
      const a = await request('GET', '/api/tasks?project=alpha');
      const b = await request('GET', '/api/tasks?project=beta');
      assert.deepStrictEqual(a.body.tasks.map(t => [t.messageId, t.project, t.recipient]), [['C-1', 'alpha', 'Codex']]);
      assert.deepStrictEqual(b.body.tasks.map(t => [t.messageId, t.project]), [['C-1', 'beta']]);
      const snap = await request('GET', '/api/snapshot?project=beta');
      assert.strictEqual(snap.body.project.id, 'beta');
      assert.strictEqual(snap.body.mailbox.path, path.normalize(BETA_MB));
      assert.strictEqual(snap.body.mailbox.mutexName, 'Global\\TestBetaMailbox');
      assert.strictEqual(snap.body.tasks.all.length, 1);
      assert.strictEqual(snap.body.projects.length, 3);
    });

    await test('Unknown project returns 404 with the list of known projects', async () => {
      const res = await request('GET', '/api/mailbox?project=does-not-exist');
      assert.strictEqual(res.status, 404);
      assert.deepStrictEqual(res.body.projects, ['alpha', 'beta', 'tel']);
      const cfg = await request('GET', '/api/config?project=does-not-exist');
      assert.strictEqual(cfg.status, 200, '/api/config must survive a stale project id');
    });

    await test('WS notifications are tagged with their project and respect a client project scope', () => {
      const codexNotes = codex.received.filter(m => m.type === 'MAILBOX_MESSAGE_NOTIFY');
      assert.deepStrictEqual(codexNotes.map(n => [n.project, n.messageId]), [['alpha', 'C-1']], 'Codex is scoped to alpha only');
      const agNotes = ag.received.filter(m => m.type === 'MAILBOX_MESSAGE_NOTIFY');
      assert.deepStrictEqual(agNotes.map(n => [n.project, n.messageId]).sort(), [['beta', 'C-1'], ['tel', 'MSG-003']]);
      assert.strictEqual(agNotes.find(n => n.project === 'tel').projectName, 'Tel Project');
    });

    await test('MESSAGE_ACK with a project completes only that project\'s task', async () => {
      ag.ws.send(JSON.stringify({ type: 'MESSAGE_ACK', project: 'beta', messageId: 'C-1', status: 'COMPLETED', workerId: 'ag-1' }));
      await sleep(150);
      assert.strictEqual(broker.getProject('beta').stateStore.getTask('C-1').status, 'COMPLETED');
      assert.strictEqual(broker.getProject('alpha').stateStore.getTask('C-1').status, 'PENDING');
      ag.ws.send(JSON.stringify({ type: 'MESSAGE_ACK', project: 'nope', messageId: 'C-1', status: 'COMPLETED' }));
      await sleep(100);
      const err = ag.received.find(m => m.type === 'ERROR' && /Unknown project/.test(m.error));
      assert.ok(err, 'unknown project ACK is rejected');
    });

    await test('Board data is per project', async () => {
      const created = await request('POST', '/api/board/tasks?project=tel', { title: 'Tel-only task' });
      assert.strictEqual(created.status, 201);
      const telBoard = await request('GET', '/api/board?project=tel');
      const alphaBoard = await request('GET', '/api/board');
      assert.deepStrictEqual(telBoard.body.tasks.map(t => t.title), ['Tel-only task']);
      assert.strictEqual(alphaBoard.body.tasks.length, 0);
    });

    await test('Activity log entries are tagged and filtered by project', async () => {
      const logs = await request('GET', '/api/logs?project=beta&type=MAILBOX_MESSAGE');
      assert.ok(logs.body.logs.length >= 1);
      assert.ok(logs.body.logs.every(e => e.project === 'beta' || e.project === null));
    });

    // ─── 4. Concurrent sessions of one agent (connect/disconnect loop fix) ───
    await test('Two sessions of the same agent stay connected (no mutual eviction loop)', async () => {
      const s1 = await connectAgent('Claude', { instanceId: 'claude-window-1' });
      const s2 = await connectAgent('Claude', { instanceId: 'claude-window-2' });
      sockets.push(s1.ws, s2.ws);
      await sleep(200);
      assert.strictEqual(s1.ws.readyState, WebSocket.OPEN, 'first session must not be kicked');
      assert.strictEqual(s2.ws.readyState, WebSocket.OPEN);
      s2.ws.close();
      await sleep(150);
      assert.notStrictEqual(broker.agentTelemetry.get('claude').status, 'offline', 'still online while one session remains');
      s1.ws.close();
      await sleep(150);
      assert.strictEqual(broker.agentTelemetry.get('claude').status, 'offline');
    });

    await test('A reconnect from the same client instance replaces its own stale socket', async () => {
      const old = await connectAgent('Claude', { instanceId: 'claude-same' });
      sockets.push(old.ws);
      const closed = new Promise(r => old.ws.on('close', r));
      const fresh = await connectAgent('Claude', { instanceId: 'claude-same' });
      sockets.push(fresh.ws);
      await Promise.race([closed, sleep(1000)]);
      assert.notStrictEqual(old.ws.readyState, WebSocket.OPEN);
      assert.strictEqual(fresh.ws.readyState, WebSocket.OPEN);
    });
  } finally {
    for (const ws of sockets) { try { ws.terminate(); } catch (_) {} }
    await broker.stop();
  }

  // ─── 5. MCP project argument ─────────────────────────────────
  const cfgPath = path.join(TMP, 'mcp_config.json');
  fs.writeFileSync(cfgPath, JSON.stringify({ broker: { authToken: TOKEN, port: 1 }, ...projectsConfig }, null, 2));
  const mcpOpts = {
    agentId: 'Claude',
    projectRoot: REPO_ROOT,
    configPath: cfgPath,
    registryPath: path.join(TMP, 'mcp_registry.json'),
    logFilePath: path.join(TMP, 'mcp_activity.jsonl')
  };
  const savedEnv = { MAILBOX_PATH: process.env.MAILBOX_PATH, MAILBOX_PROJECT: process.env.MAILBOX_PROJECT };
  delete process.env.MAILBOX_PATH;
  delete process.env.MAILBOX_PROJECT;

  try {
    const mcp = new McpServer(mcpOpts);
    const call = async (name, args = {}) => {
      const res = await mcp.handleRequest({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
      if (res.error) throw new Error(res.error.message);
      return JSON.parse(res.result.content[0].text);
    };

    await test('MCP: config defaultProject is the default; list_projects returns every project', async () => {
      assert.strictEqual(mcp.defaultProjectId, 'alpha');
      const r = await call('list_projects');
      assert.strictEqual(r.defaultProject, 'alpha');
      assert.deepStrictEqual(r.projects.map(p => [p.id, p.headerFormat]), [['alpha', 'broker'], ['beta', 'broker'], ['tel', 'tel']]);
    });

    await test('MCP: project-scoped tools declare an optional "project" argument', () => {
      const tools = mcp.getTools();
      for (const n of ['send_message', 'get_pending_messages', 'wait_for_message', 'get_team_status', 'claim_message', 'complete_task', 'get_board']) {
        const t = tools.find(x => x.name === n);
        assert.ok(t.inputSchema.properties.project, `${n} has project`);
        assert.ok(!(t.inputSchema.required || []).includes('project'), `${n} project is optional`);
      }
    });

    await test('MCP: get_pending_messages / get_message are isolated by project', async () => {
      const def = await call('get_pending_messages');
      assert.strictEqual(def.project, 'alpha');
      assert.deepStrictEqual(def.messages.map(m => m.id), [], 'alpha has nothing for Claude');
      const tel = await call('get_pending_messages', { project: 'tel' });
      assert.deepStrictEqual(tel.messages.map(m => m.id), ['MSG-002']);
      assert.ok(tel.messages.every(m => m.project === 'tel'));
      const msg = await call('get_message', { project: 'tel', messageId: 'MSG-002' });
      assert.strictEqual(msg.status, 'BLOCKED');
      await assert.rejects(() => call('get_message', { messageId: 'MSG-002' }), /not found in project 'alpha'/);
      const all = await call('get_pending_messages', { project: 'all' });
      assert.deepStrictEqual(all.messages.map(m => `${m.project}:${m.id}`), ['tel:MSG-002']);
    });

    await test('MCP: claim/complete write only the named project\'s state', async () => {
      const claimed = await call('claim_message', { project: 'tel', messageId: 'MSG-002' });
      assert.strictEqual(claimed.project, 'tel');
      assert.strictEqual(mcp._getProject('tel').stateStore.getTask('MSG-002').status, 'CLAIMED');
      assert.strictEqual(mcp._getProject('alpha').stateStore.getTask('MSG-002'), null);
      await call('complete_task', { project: 'tel', messageId: 'MSG-002', evidence: { summary: 'ok' } });
      const after = await call('get_pending_messages', { project: 'tel' });
      assert.strictEqual(after.total, 0);
      const status = await call('get_team_status', { project: 'tel' });
      assert.strictEqual(status.project, 'tel');
      assert.strictEqual(status.taskCounts.completed, 1);
    });

    await test('MCP: unknown project is rejected before any side effect', async () => {
      await assert.rejects(() => call('send_message', { project: 'ghost', to: 'Codex', body: 'x' }), /Unknown project 'ghost'/);
    });
    mcp.close();

    await test('MCP: MAILBOX_PROJECT selects the default project', () => {
      process.env.MAILBOX_PROJECT = 'tel';
      const m = new McpServer(mcpOpts);
      assert.strictEqual(m.defaultProjectId, 'tel');
      m.close();
      delete process.env.MAILBOX_PROJECT;
      process.env.MAILBOX_PROJECT = 'ghost';
      assert.throws(() => new McpServer(mcpOpts), /MAILBOX_PROJECT 'ghost' is not configured/);
      delete process.env.MAILBOX_PROJECT;
    });

    await test('MCP: MAILBOX_PATH matching a configured project selects it (legacy env still works)', () => {
      process.env.MAILBOX_PATH = BETA_MB.toUpperCase();
      const m = new McpServer(mcpOpts);
      assert.strictEqual(m.defaultProjectId, 'beta');
      assert.strictEqual(m.mailboxPath, path.normalize(BETA_MB));
      m.close();
      delete process.env.MAILBOX_PATH;
    });

    await test('MCP: an unconfigured MAILBOX_PATH becomes an ad-hoc default project', () => {
      const other = path.join(TMP, 'other', 'TEAM_MAILBOX.md');
      fs.mkdirSync(path.dirname(other), { recursive: true });
      fs.writeFileSync(other, '# other\n');
      const m = new McpServer({ ...mcpOpts, mailboxPath: other, statePath: path.join(TMP, 'adhoc_state.json') });
      assert.strictEqual(m.defaultProjectId, 'default');
      assert.strictEqual(m.mailboxPath, path.normalize(other));
      assert.ok(m.projectDefs.has('alpha'), 'configured projects stay addressable');
      m.close();
    });
  } finally {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }

  console.log('\n===================================================================');
  console.log(`MULTI-PROJECT SUMMARY: ${passed} PASSED, ${failed} FAILED (Total: ${passed + failed})`);
  console.log('===================================================================');
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => {
  console.error(`Fatal: ${err.stack || err.message}`);
  process.exit(1);
});
