import assert from 'node:assert/strict';
import test from 'node:test';
import { UiAuditClient, auditValue, newTraceId, newUuid, normalizeLabel, resolveApiBase } from '../lib/ui-audit.ts';

type Call = { url: string; body: { session_id: string; events: Array<{ event_id: string; feature: string; action: string; parent_event_id: string | null; trace_id: string }> } };

function harness(responder: (call: Call) => { status: number; body?: unknown } | Error) {
  let clock = 1_000_000;
  const scheduled: Array<() => void> = [];
  const calls: Call[] = [];
  const client = new UiAuditClient({
    apiBase: 'http://localhost:8100',
    sessionId: 'session-under-test',
    now: () => clock,
    schedule: (callback) => scheduled.push(callback),
    fetchImpl: async (url, init) => {
      const call = { url, body: JSON.parse(init.body) };
      calls.push(call);
      const outcome = responder(call);
      if (outcome instanceof Error) throw outcome;
      return { status: outcome.status, ok: outcome.status >= 200 && outcome.status < 300, json: async () => outcome.body ?? {} };
    },
  });
  return { client, calls, scheduled, advance: (ms: number) => { clock += ms; } };
}

test('ids have the formats the platform API validates', () => {
  assert.match(newUuid(), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.match(newTraceId(), /^[0-9a-f]{32}$/);
  assert.notEqual(newUuid(), newUuid());
});

test('the API base is explicit, localhost-derived, or disabled; deployed pages never call localhost', () => {
  assert.equal(resolveApiBase({ protocol: 'http:', hostname: 'localhost' }), 'http://localhost:8100');
  assert.equal(resolveApiBase({ protocol: 'http:', hostname: '127.0.0.1' }), 'http://127.0.0.1:8100');
  assert.equal(resolveApiBase({ protocol: 'https:', hostname: 'chipdesignsoftware.vercel.app' }), null);
  assert.equal(resolveApiBase({ protocol: 'https:', hostname: 'x.app' }, 'https://api.example.com/'), 'https://api.example.com');
  assert.equal(resolveApiBase({ protocol: 'http:', hostname: 'localhost' }, 'https://api.example.com', 'http://localhost:8101'), 'http://localhost:8101');
  assert.equal(resolveApiBase({ protocol: 'http:', hostname: 'localhost' }, null, 'off'), null);
});

test('logged values never include passwords, emails, or redacted fields', () => {
  assert.deepEqual(auditValue({ type: 'password', value: 'hunter2hunter2' }), { redacted: true });
  assert.deepEqual(auditValue({ type: 'email', value: 'a@b.c' }), { redacted: true });
  assert.deepEqual(auditValue({ type: 'text', value: 'secret', redact: true }), { redacted: true });
  assert.deepEqual(auditValue({ type: 'range', value: '12.5' }), { value: 12.5 });
  assert.deepEqual(auditValue({ type: 'checkbox', checked: true }), { value: true });
  assert.deepEqual(auditValue({ type: 'select-one', value: 'x1-production' }), { value: 'x1-production' });
  assert.equal(normalizeLabel('  Run \n  mission   replay '), 'Run mission replay');
  assert.equal(normalizeLabel('x'.repeat(200), 10).length, 10);
});

test('without an API, events stay local and are still recorded', () => {
  const client = new UiAuditClient({ apiBase: null, now: () => 0 });
  client.record('ui.view', 'changed', { key: 'view', from: 'twin', to: 'x1' });
  const snapshot = client.snapshot();
  assert.equal(snapshot.mode, 'local-only');
  assert.equal(snapshot.events[0].status, 'local');
  assert.deepEqual(snapshot.counts, { recorded: 1, sent: 0, rejected: 0, dropped: 0, queued: 0 });
});

test('events caused by an interaction share its trace and name it as parent', () => {
  const { client, advance } = harness(() => ({ status: 200, body: { rejections: [] } }));
  const click = client.interaction('click', { control: { label: 'Run mission replay' } });
  const caused = client.record('ui.agent_replay', 'started', {});
  advance(5000);
  const later = client.record('ui.sweep', 'completed', {});
  assert.equal(caused.parent_event_id, click.event_id);
  assert.equal(caused.trace_id, click.trace_id);
  assert.equal(later.parent_event_id, null);
  assert.notEqual(later.trace_id, click.trace_id);
});

test('batches are delivered, rejections are kept with their reason', async () => {
  const { client, calls } = harness((call) => ({ status: 200, body: { rejections: [{ event_id: call.body.events[1].event_id, reason: 'undeclared_action' }] } }));
  client.setContext({ view: 'twin' });
  const good = client.record('ui.view', 'changed', {});
  const bad = client.record('ui.view', 'exploded', {});
  await client.flush();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://localhost:8100/api/events/ui');
  assert.equal(calls[0].body.session_id, 'session-under-test');
  assert.equal(good.status, 'sent');
  assert.equal(bad.status, 'rejected');
  assert.equal(bad.reason, 'undeclared_action');
  assert.equal(good.details.view, 'twin', 'context is merged into every event');
  assert.equal(client.snapshot().counts.queued, 0);
});

test('failures keep events queued and back off; sign-in retries immediately', async () => {
  let outcome: { status: number; body?: unknown } | Error = new Error('connection refused');
  const { client, calls } = harness(() => outcome);
  client.record('ui.view', 'changed', {});
  await client.flush();
  assert.equal(client.mode, 'offline');
  assert.equal(client.snapshot().counts.queued, 1);
  await client.flush();
  assert.equal(calls.length, 1, 'backoff prevents hammering the API');

  outcome = { status: 401 };
  await client.retryNow();
  assert.equal(client.mode, 'unauthorized');
  assert.equal(client.snapshot().counts.queued, 1);

  outcome = { status: 200, body: { rejections: [] } };
  await client.retryNow();
  assert.equal(client.mode, 'connected');
  assert.equal(client.snapshot().counts.queued, 0);
  assert.equal(client.snapshot().counts.sent, 1);
});

test('the buffer is bounded and snapshots are cached until something changes', () => {
  const client = new UiAuditClient({ apiBase: null, maxBuffer: 3, now: () => 0 });
  for (let index = 0; index < 5; index += 1) client.record('ui.state', 'changed', { index });
  const first = client.cachedSnapshot();
  assert.equal(first, client.cachedSnapshot());
  assert.deepEqual(first.events.map((event) => event.details.index), [4, 3, 2]);
  client.record('ui.state', 'changed', { index: 5 });
  assert.notEqual(first, client.cachedSnapshot());
  assert.equal(client.snapshot().counts.recorded, 6);
});

test('unload delivery uses the beacon for everything still queued', () => {
  const beacons: string[] = [];
  const client = new UiAuditClient({ apiBase: 'http://localhost:8100', beacon: (_url, body) => (beacons.push(body), true), maxBatch: 2, now: () => 0, schedule: () => undefined });
  for (let index = 0; index < 3; index += 1) client.record('ui.state', 'changed', { index });
  client.flushWithBeacon();
  assert.equal(beacons.length, 2);
  assert.equal(client.snapshot().counts.queued, 0);
  assert.equal(JSON.parse(beacons[1]).events.length, 1);
});
