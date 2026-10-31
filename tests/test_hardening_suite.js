/**
 * test_hardening_suite.js
 * Verifies (1) the broker never discloses its auth token to tunnelled/proxied requests,
 * (2) adapters do not re-run mailbox history on (re)connect, and (3) broadcast gating.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const EventBroker = require('../src/broker/EventBroker');
const ClaudeAdapter = require('../src/adapters/ClaudeAdapter');

const WS_PORT = 9970;
const HTTP_PORT = 9971;
const TOKEN = 'test-only-token-not-a-secret';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mst-hardening-'));
const MAILBOX = path.join(TMP, 'TEAM_MAILBOX.md');

const results = [];
function check(name, ok, detail = '') {
  results.push(ok);
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${ok ? '' : ' -> ' + detail}`);
}

function get(pathname, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get({ hostname: '127.0.0.1', port: HTTP_PORT, path: pathname, headers }, res => {
      let d = '';
      res.on('data', c => { d += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    }).on('error', reject);
  });
}

function heading(n, to) {
  return `\n### [X-${n}] Codex -> ${to}, 2026-10-30 10:00\nTASK: t${n}\n`;
}

async function main() {
  fs.writeFileSync(MAILBOX, '# mailbox\n' + heading(1, 'Claude') + heading(2, 'Claude') + heading(3, 'Claude'));

  fs.writeFileSync(path.join(TMP, 'TASKS.md'), [
    '# Tasks', '', '## Dashboard (updated 2026-10-30)', '', '### Progress (rows)',
    '| Area | Rows | Done | Progress | State |', '|---|---|---|---|---|',
    '| Gate 1 | 4 | 2 | 50 % | halfway |', '| **Whole project** | **4** | **2** | **about 50 %** | testing |', '',
    '### Remaining work, in order', '1. **Do the thing (C):** now', '',
    '### Gate 1: slam', '| ID | Task | Owner | Depends | Done when | Status |', '|---|---|---|---|---|---|',
    '| G1-1 | one | C | - | x | Done 2026-10-20 |', '| G1-2 | two | C | - | x | Built: not proved |',
    '| G1-3 | three | AG | - | x | Blocked: art |', '| G1-4 | four | U | - | x | Todo |', ''
  ].join('\n'));

  // --- 1. Token disclosure ---
  const broker = new EventBroker({
    port: WS_PORT, httpPort: HTTP_PORT, authToken: TOKEN,
    statePath: path.join(TMP, 's.json'), registryPath: path.join(TMP, 'r.json'),
    logFilePath: path.join(TMP, 'l.jsonl'), mailbox: { path: MAILBOX }
  });
  await broker.start();
  try {
    const local = JSON.parse((await get('/api/config')).body);
    check('Local browser request receives the auth token', local.authToken === TOKEN);

    const viaTunnel = JSON.parse((await get('/api/config', { Host: 'abc123.shares.zrok.io' })).body);
    check('Tunnelled request (foreign Host) gets no token', viaTunnel.authToken === undefined);

    const proxied = JSON.parse((await get('/api/config', { 'X-Forwarded-For': '203.0.113.9' })).body);
    check('Proxied request (X-Forwarded-For) gets no token', proxied.authToken === undefined);

    const html = (await get('/', { Host: 'abc123.shares.zrok.io' })).body;
    check('Tunnelled HTML page does not embed the token', !html.includes(TOKEN));

    const remoteData = await get('/api/mailbox', { Host: 'abc123.shares.zrok.io' });
    check('Tunnelled data endpoint requires the token (401)', remoteData.status === 401, `status=${remoteData.status}`);
    const remoteAuthed = await get('/api/mailbox', { Host: 'abc123.shares.zrok.io', Authorization: `Bearer ${TOKEN}` });
    check('Tunnelled data endpoint works with the token', remoteAuthed.status === 200, `status=${remoteAuthed.status}`);
    const remoteHealth = await get('/health', { Host: 'abc123.shares.zrok.io' });
    check('Tunnelled /health requires the token (401)', remoteHealth.status === 401, `status=${remoteHealth.status}`);

    // --- Progress API reads the docs read-only ---
    const prog = JSON.parse((await get('/api/progress')).body);
    check('/api/progress returns parsed task tables and conversation',
      prog.totalTasks === 4 && prog.whole && prog.whole.percent === 50 && prog.conversation.total >= 3,
      JSON.stringify({ t: prog.totalTasks, w: prog.whole && prog.whole.percent, c: prog.conversation.total }));
    check('Progress classifies statuses (done/built/blocked/todo)',
      prog.counts.done === 1 && prog.counts.built === 1 && prog.counts.blocked === 1 && prog.counts.todo === 1, JSON.stringify(prog.counts));
    check('Progress exposes the folder name only, not absolute paths',
      prog.docsFolder === path.basename(TMP) && !JSON.stringify(prog).includes(TMP.split(path.sep).join('\\\\')));
  } finally {
    await broker.stop();
  }

  // --- 2. Catch-up must not replay history ---
  const statePath = path.join(TMP, 'adapter_state.json');
  const mk = (extra = {}) => new ClaudeAdapter({
    execMode: 'mock', mailboxPath: MAILBOX, lockDir: path.join(TMP, 'locks'), statePath, ...extra
  });
  const handled = [];
  const instrument = (a) => { a.handleNotification = async n => { handled.push(n.messageId); }; return a; };

  const first = instrument(mk());
  await first.performCatchup();
  check('First run baselines existing history without dispatching', handled.length === 0 && fs.existsSync(statePath), `handled=${handled}`);

  fs.appendFileSync(MAILBOX, heading(4, 'Claude'));
  const second = instrument(mk());
  await second.performCatchup();
  check('Restart only dispatches messages newer than the baseline', handled.join() === 'X-4', `handled=${handled}`);

  // --- 3. Broadcast gating ---
  const gated = mk({ dispatchBroadcast: false });
  check('isBroadcast: multi-agent and ALL are broadcasts',
    gated.isBroadcast('Claude,Codex,Owner') && gated.isBroadcast('ALL') && gated.isBroadcast('Claude and Antigravity'));
  check('isBroadcast: single agent (+Owner) is direct',
    !gated.isBroadcast('Claude') && !gated.isBroadcast('Claude,Owner') && !gated.isBroadcast('Owner,Claude'));

  let dispatched = 0;
  gated.dispatchMessage = async () => { dispatched++; return { evidence: 'x' }; };
  fs.appendFileSync(MAILBOX, heading(5, 'Claude,Codex,Owner'));
  await gated.handleNotification({ messageId: 'X-5', recipientRaw: 'Claude,Codex,Owner' });
  check('Broadcast is not auto-dispatched when dispatchBroadcast=false', dispatched === 0);

  const failed = results.filter(r => !r).length;
  console.log(`\nHARDENING SUMMARY: ${results.length - failed} PASSED, ${failed} FAILED (Total: ${results.length})`);
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
}

main().catch(err => { console.error(err); process.exit(1); });
