import { posix } from 'node:path';

export const LEGACY_RELEASE = '4a0145727279d22e0db0394b0da0ea5ff3ace03e';

// Used by an operator capture, not by the server's admission policy.
export function backupMarkerPath(maintenance, env) {
  if (!/^[a-f0-9]{40}$/.test(env.JEFF_RELEASE_SHA || '')) throw new Error('BACKUP_RELEASE_REQUIRED');
  let path;
  if (typeof maintenance.resolveMaintenanceMarkerPath === 'function') path = maintenance.resolveMaintenanceMarkerPath({ env, dataRoot: '/data' });
  else if (env.JEFF_RELEASE_SHA === LEGACY_RELEASE) path = env.JEFF_MAINTENANCE_MARKER || '/tmp/simple-jeff-maintenance.json';
  else throw new Error('BACKUP_MAINTENANCE_VERSION_UNSUPPORTED');
  if (typeof path !== 'string' || !posix.isAbsolute(path) || path.includes('\0') || posix.normalize(path) !== path) {
    throw new Error('BACKUP_MARKER_PATH_INVALID');
  }
  return path;
}

export function backupDrainReady(marker, { pid, releaseSha }) {
  return marker?.schema === 'simple-jeff-maintenance-v1' && marker.status === 'ready'
    && marker.pid === pid && marker.releaseSha === releaseSha
    && marker.activeRequests === 0 && marker.pendingTasks === 0
    && Number.isFinite(Date.parse(marker.readyAt));
}
