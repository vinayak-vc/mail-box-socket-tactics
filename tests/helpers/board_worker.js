/**
 * board_worker.js — test helper, run as a separate Node process by test_board_concurrency.js.
 * Simulates one MCP server / broker process working on a shared board file.
 *
 * Usage: node board_worker.js <json>
 *   json = { boardPath, startAt, actor, ops: [{ op: 'move', id, column } | { op: 'create', title } | { op: 'comment', id, text }] }
 * Waits until startAt (epoch ms) so several workers hit the file at the same moment,
 * then prints a JSON array of results to stdout.
 */

const BoardDomainService = require('../../src/domain/BoardDomainService');

const job = JSON.parse(process.argv[2]);
// One long-lived service per process, like a real MCP server: its in-memory copy goes stale
const board = new BoardDomainService({ storagePath: job.boardPath });

while (Date.now() < job.startAt) { /* start barrier */ }

const results = [];
for (const op of job.ops) {
  try {
    if (op.op === 'move') results.push({ ok: true, id: board.moveTask(op.id, op.column, job.actor).id });
    else if (op.op === 'create') results.push({ ok: true, id: board.createTask({ title: op.title, createdBy: job.actor }).id });
    else if (op.op === 'comment') results.push({ ok: true, id: board.addComment(op.id, op.text, job.actor).id });
  } catch (err) {
    results.push({ ok: false, error: err.message });
  }
}
process.stdout.write(JSON.stringify(results));
