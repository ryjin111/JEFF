import { access, lstat, readFile, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';

const railwayIds = ['RAILWAY_PROJECT_ID', 'RAILWAY_ENVIRONMENT_ID', 'RAILWAY_SERVICE_ID', 'RAILWAY_DEPLOYMENT_ID', 'RAILWAY_VOLUME_ID'];
const railwayFields = [...railwayIds, 'RAILWAY_VOLUME_MOUNT_PATH', 'RAILWAY_VOLUME_NAME'];
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const unescapeMount = value => value.replace(/\\(040|011|012|134)/g, (_, octal) => String.fromCharCode(parseInt(octal, 8)));

// Check the kernel mount table, not the existence of a directory that startup could create.
export function writableDataMount(mountinfo) {
  const mounts = mountinfo.trim().split('\n').map(line => line.split(' ')).filter(fields => unescapeMount(fields[4] || '') === '/data');
  if (mounts.length !== 1) return false;
  const fields = mounts[0], separator = fields.indexOf('-');
  if (separator < 6 || fields.length < separator + 4) return false;
  return [fields[5], fields[separator + 3]].every(options => {
    const flags = options.split(',');
    return flags.includes('rw') && !flags.includes('ro');
  });
}

// Ordinary local development keeps its independent data root. The hosted image and
// any Railway runtime must fail before backup capture, SQLite, schedulers or HTTP.
export async function verifyStartupMount({ env = process.env, platform = process.platform,
  io = { access, lstat, readFile, realpath } } = {}) {
  const railway = railwayFields.some(key => env[key] !== undefined);
  if (env.JEFF_HOSTED_HARDENING !== 'true' && !railway) return { required: false, verified: false };
  if (platform !== 'linux' || env.JEFF_DATA_ROOT !== '/data'
    || (railway && (railwayIds.some(key => !uuid.test(env[key] || '')) || env.RAILWAY_VOLUME_MOUNT_PATH !== '/data')))
    throw new Error('JEFF_STORAGE_IDENTITY_INVALID');
  try {
    const stat = await io.lstat('/data');
    if (!stat.isDirectory() || stat.isSymbolicLink() || await io.realpath('/data') !== '/data')
      throw new Error('JEFF_STORAGE_PATH_INVALID');
    if (!writableDataMount(await io.readFile('/proc/self/mountinfo', 'utf8')))
      throw new Error('JEFF_STORAGE_MOUNT_REQUIRED');
    await io.access('/data', constants.W_OK | constants.X_OK);
  } catch (error) {
    if (/^JEFF_STORAGE_[A-Z_]+$/.test(error.message)) throw error;
    throw new Error('JEFF_STORAGE_MOUNT_UNAVAILABLE');
  }
  return { required: true, verified: true };
}
