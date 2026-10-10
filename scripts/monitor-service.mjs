import { createServer } from 'node:http';
import { runMonitorProbe, nextMonitorState, validateMonitorConfig } from './uptime-monitor.mjs';
import { createMonitorAlerts, deliverMonitorTransition } from './monitor-alerts.mjs';
const config = validateMonitorConfig(JSON.parse(process.env.JEFF_MONITOR_CONFIG || '{}'));
const alerts = createMonitorAlerts({ url: process.env.JEFF_ALERT_WEBHOOK, bearer: process.env.JEFF_ALERT_BEARER });
let state, active, closing = false;
const run = () => {
  if (active || closing) return active;
  active = (async () => {
    const observation = await runMonitorProbe(config);
    state = await deliverMonitorTransition(state, nextMonitorState(state, observation), { ...observation, origin: config.origin }, alerts);
    console.log(JSON.stringify({ event: 'JEFF_MONITOR_SAMPLE', observedAt: observation.observedAt, ok: observation.ok,
      alertActive: state.alertActive, alertConfigured: alerts.configured, externalAlertDelivered: state.externalAlertDelivered || false }));
  })().catch(() => console.error('JEFF_MONITOR_SAMPLE_FAILED')).finally(() => { active = null; }); return active;
};
if (process.env.JEFF_MONITOR_TEST_DELIVERY === 'true') {
  for (const event of ['test-failure', 'test-recovery']) {
    if (!await alerts.send({ event, origin: config.origin, observedAt: new Date().toISOString(), failedChecks: event === 'test-failure' ? ['synthetic-test'] : [] })) throw new Error('JEFF_ALERT_TEST_NOT_DELIVERED');
  }
  console.log('JEFF_ALERT_TEST_DELIVERY_VERIFIED');
}
await run();
const timer = setInterval(run, 60000);
const server = createServer((request, response) => {
  response.setHeader('Cache-Control', 'no-store');
  response.writeHead(request.url === '/health' ? 200 : 404, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(request.url === '/health' ? { status: 'monitoring', lastObservedAt: state?.lastObservedAt || state?.history?.at(-1)?.observedAt,
    targetHealthy: state?.consecutiveFailures === 0, alertConfigured: alerts.configured, alertActive: Boolean(state?.alertActive) } : { error: 'NOT_FOUND' }));
});
server.listen(Number(process.env.PORT || 8788), '0.0.0.0');
const stop = async () => { closing = true; clearInterval(timer); await active; server.close(() => process.exit(0)); };
process.on('SIGTERM', stop); process.on('SIGINT', stop);
