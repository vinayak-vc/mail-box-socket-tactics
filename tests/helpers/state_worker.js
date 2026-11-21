/**
 * state_worker.js — test helper, run as a separate Node process by test_state_concurrency.js.
 * Simulates one MCP server / broker process using a shared mailbox_state.json.
 * Usage: node state_worker.js <json>  with { statePath, startAt, workerId, ops: [...] }
 * ops: { op: 'create', id } | { op: 'claim', id } | { op: 'complete', id }
 * Prints a JSON array of results.
 */
const StateStore = require('../../src/broker/StateStore');

const job = JSON.parse(process.argv[2]);
const store = new StateStore({ statePath: job.statePath, projectId: 'p' }); // long-lived, like a real process

while (Date.now() < job.startAt) { /* start barrier */ }

const results = [];
for (const op of job.ops) {
  try {
    if (op.op === 'create') results.push({ id: op.id, ok: !!store.getOrCreateTask({ messageId: op.id, sender: job.workerId }) });
    else if (op.op === 'claim') results.push({ id: op.id, ok: store.claimTask(op.id, job.workerId, 60000) });
    else if (op.op === 'complete') results.push({ id: op.id, ok: store.markCompleted(op.id, job.workerId, `by ${job.workerId}`) });
  } catch (err) {
    results.push({ id: op.id, ok: false, error: err.message });
  }
}
process.stdout.write(JSON.stringify(results));
