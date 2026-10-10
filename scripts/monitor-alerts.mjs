export function createMonitorAlerts({ url, bearer, fetchImpl = fetch } = {}) {
  if (!url) return { configured: false, async send() { return false; } };
  let destination;
  try { destination = new URL(url); } catch { throw new Error('JEFF_ALERT_CONFIG_INVALID'); }
  if (destination.protocol !== 'https:' || destination.username || destination.password || destination.hash
    || bearer && (typeof bearer !== 'string' || /[\r\n]/.test(bearer))) throw new Error('JEFF_ALERT_CONFIG_INVALID');
  return { configured: true, async send({ event, origin, failedChecks = [], observedAt }) {
    if (!['failure', 'recovery', 'test-failure', 'test-recovery'].includes(event)) throw new Error('JEFF_ALERT_EVENT_INVALID');
    const detail = event.startsWith('test-') ? 'Synthetic delivery test; no application health change implied.'
      : failedChecks.length ? 'Failed checks: ' + failedChecks.join(', ') : 'Checks healthy.';
    const text = `JEFF ${event}: ${origin} at ${observedAt}. ${detail}`;
    const response = await fetchImpl(destination.href, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
      headers: { 'content-type': 'application/json', ...(bearer ? { authorization: 'Bearer ' + bearer } : {}) },
      body: JSON.stringify({ text, content: text }) });
    await response.body?.cancel(); if (!response.ok) throw new Error('JEFF_ALERT_DELIVERY_FAILED'); return true;
  } };
}

export async function deliverMonitorTransition(previous, current, observation, alerts) {
  const event = current.alertActive ? 'failure' : previous?.deliveredAlert === 'failure' ? 'recovery' : null;
  if (!event || current.alertActive && previous?.deliveredAlert === 'failure') return { ...current, deliveredAlert: previous?.deliveredAlert || null };
  try {
    const sent = await alerts.send({ event, origin: observation.origin, observedAt: observation.observedAt,
      failedChecks: observation.checks.filter(check => !check.ok).map(check => check.name) });
    return { ...current, deliveredAlert: sent ? event : previous?.deliveredAlert || null, externalAlertDelivered: sent };
  } catch { return { ...current, deliveredAlert: previous?.deliveredAlert || null, externalAlertDelivered: false, alertDeliveryError: true }; }
}
