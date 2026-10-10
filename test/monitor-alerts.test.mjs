import test from 'node:test';
import assert from 'node:assert/strict';
import { createMonitorAlerts, deliverMonitorTransition } from '../scripts/monitor-alerts.mjs';
test('monitor sends only configured HTTPS alerts and reports failed delivery without exposing the URL', async () => {
  assert.throws(() => createMonitorAlerts({ url: 'http://alerts.example' }), /CONFIG_INVALID/);
  let body;
  const alerts = createMonitorAlerts({ url: 'https://alerts.example/private-token', fetchImpl: async (url, options) => {
    assert.equal(options.redirect, 'error'); body = JSON.parse(options.body); return new Response('', { status: 204 });
  } });
  // A bodyless 204 is used by actual webhook providers.
  const accepted = createMonitorAlerts({ url: 'https://alerts.example/private-token', fetchImpl: async (url, options) => {
    body = JSON.parse(options.body); return new Response(null, { status: 204 });
  } });
  assert.equal(await accepted.send({ event: 'failure', origin: 'https://jeff.example', observedAt: new Date().toISOString() }), true);
  assert.equal(JSON.stringify(body).includes('private-token'), false);
  await assert.rejects(alerts.send({ event: 'unknown' }), /EVENT_INVALID/);
});
test('outage alerts retry until accepted, deduplicate success and deliver recovery once', async () => {
  let calls = 0;
  const observation = { origin: 'https://jeff.example', observedAt: new Date().toISOString(), checks: [{ name: 'health', ok: false }] };
  const alerts = { send: async () => { calls++; if (calls === 1) throw new Error('failure'); return true; } };
  const current = { alertActive: true };
  let state = await deliverMonitorTransition(null, current, observation, alerts);
  assert.equal(state.alertDeliveryError, true); assert.equal(state.deliveredAlert, null);
  state = await deliverMonitorTransition(state, current, observation, alerts); assert.equal(state.deliveredAlert, 'failure');
  state = await deliverMonitorTransition(state, current, observation, alerts); assert.equal(calls, 2);
  state = await deliverMonitorTransition(state, { alertActive: false }, observation, alerts); assert.equal(state.deliveredAlert, 'recovery');
  await deliverMonitorTransition(state, { alertActive: false }, observation, alerts); assert.equal(calls, 3);
});
test('synthetic alerts do not claim observed application health', async () => {
  const messages = [];
  const alerts = createMonitorAlerts({ url: 'https://alerts.example/test', fetchImpl: async (url, options) => {
    messages.push(JSON.parse(options.body)); return new Response(null, { status: 204 });
  } });
  for (const event of ['test-failure', 'test-recovery', 'recovery']) {
    await alerts.send({ event, origin: 'https://jeff.example', observedAt: '2026-10-10T12:00:00Z' });
  }
  for (const message of messages.slice(0, 2)) {
    assert.match(message.text, /Synthetic delivery test; no application health change implied\./);
    assert.doesNotMatch(message.text, /Checks healthy/);
    assert.equal(message.content, message.text);
  }
  assert.match(messages[2].text, /Checks healthy\./);
});
