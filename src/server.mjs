import { createJeffApplication } from './application.mjs';

import { createRecurringBackup } from './recurring-backup.mjs';
if (process.env.JEFF_HOSTED_HARDENING === 'true') await import('./runtime-hardening.mjs');
const { prepareStartupBackup } = await import('./startup-backup.mjs');
let backupExport;
try { backupExport = await prepareStartupBackup(); }
catch (error) {
  console.error(/^JEFF_[A-Z_]+$/.test(error.message) ? error.message : 'JEFF_BACKUP_EXPORT_FAILED');
  process.exit(1);
}
const app = await createJeffApplication({ backupExport });
if (backupExport) console.log(JSON.stringify(backupExport.receipt));
let operatorPaused = false;
process.on('SIGUSR2', () => { operatorPaused = true; app.maintenance.pause()
  .then(marker => { if (marker) console.log(JSON.stringify({ event: 'JEFF_MAINTENANCE_READY', ...marker })); })
  .catch(() => console.error('JEFF_MAINTENANCE_DRAIN_FAILED')); });
process.on('SIGCONT', () => {
  operatorPaused = false;
  if (!recurringBackup.isCapturing() && !closing) app.maintenance.resume().catch(() => console.error('JEFF_MAINTENANCE_RESUME_FAILED'));
});
let closing = false;
const recurringBackup = createRecurringBackup({ maintenance: app.maintenance, canResume: () => !closing && !operatorPaused });
recurringBackup.start();
const shutdown = () => {
  if (closing) return;
  closing = true;
  const drained = app.maintenance.pause();
  backupExport?.dispose();
  Promise.all([drained, recurringBackup.stop()]).then(() => app.close()).then(() => process.exit(0)).catch(() => process.exit(1));
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
if (process.env.JEFF_VERIFY_RUNTIME === 'true') {
  app.maintenance.track(import('./operator-smoke.mjs').then(module => module.verifyHostedRuntime()), 'operator-verification')
    .then(proof => console.log(JSON.stringify({ event: 'JEFF_HOSTED_RUNTIME_VERIFIED', ...proof })))
    .catch(() => console.error('JEFF_HOSTED_RUNTIME_VERIFICATION_FAILED'));
}
const port = Number(process.env.PORT || 8788);
app.server.listen(port, process.env.JEFF_BIND || '127.0.0.1', () => {
  console.log(`Simple JEFF: ${process.env.JEFF_PUBLIC_ORIGIN || `http://127.0.0.1:${port}`}`);
});
