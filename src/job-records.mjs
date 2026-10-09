import { randomUUID } from 'node:crypto';
import { mkdir, open, rename, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const JOB_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const TRANSIENT_RENAME_ERRORS = new Set(['EPERM', 'EACCES', 'EBUSY']);
// Eight attempts, with at most 900 ms of waiting for a temporarily locked file.
const RENAME_DELAYS_MS = Object.freeze([20, 40, 80, 160, 200, 200, 200]);

export function createJobRecordPersister({ renameImpl = rename, sleepImpl = sleep } = {}) {
  if (typeof renameImpl !== 'function' || typeof sleepImpl !== 'function') {
    throw new TypeError('JEFF_JOB_RECORD_CONFIG_INVALID');
  }
  return async function persistRecord(directory, record) {
    if (typeof directory !== 'string' || !directory.trim() || !JOB_ID.test(record?.id ?? '')) {
      throw new Error('JEFF_JOB_RECORD_INVALID');
    }
    const raw = JSON.stringify(record, null, 2);
    if (typeof raw !== 'string') throw new Error('JEFF_JOB_RECORD_INVALID');
    const file = resolve(directory, `${record.id}.json`);
    const temporary = `${file}.${randomUUID()}.tmp`;
    let handle;
    let ownsTemporary = false;
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      handle = await open(temporary, 'wx', 0o600);
      ownsTemporary = true;
      await handle.writeFile(raw);
      await handle.sync();
      await handle.close();
      handle = undefined;
      for (let attempt = 0; ; attempt++) {
        try {
          await renameImpl(temporary, file);
          ownsTemporary = false;
          return;
        } catch (error) {
          if (!TRANSIENT_RENAME_ERRORS.has(error?.code) || attempt >= RENAME_DELAYS_MS.length) throw error;
          await sleepImpl(RENAME_DELAYS_MS[attempt]);
        }
      }
    } finally {
      if (handle) await handle.close().catch(() => {});
      // Never remove the destination to make a rename succeed. A failed write
      // leaves the previous receipt intact and cleans only this call's temp file.
      if (ownsTemporary) await unlink(temporary).catch(() => {});
    }
  };
}
