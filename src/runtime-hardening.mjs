import { rm, readdir, lstat, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// Fixed paths in the hosted Linux container, never the workstation.
if (process.platform !== 'linux' || !['true'].includes(process.env.JEFF_IMAGE_BUILD || process.env.JEFF_HOSTED_HARDENING)) throw new Error('HOSTED_CONTAINER_ONLY');
for (const name of ['npm', 'corepack']) await rm(`/usr/local/lib/node_modules/${name}`, { recursive: true, force: true });
for (const name of ['npm', 'npx', 'corepack', 'yarn', 'yarnpkg', 'pnpm', 'pnpx']) await rm(`/usr/local/bin/${name}`, { force: true });
for (const name of await readdir('/opt')) if (/^yarn-v\d/.test(name)) await rm(resolve('/opt', name), { recursive: true, force: true });
for (const path of ['/usr/local/lib/node_modules/npm', '/usr/local/bin/npm', '/usr/local/bin/npx']) {
  try { await lstat(path); throw new Error('GLOBAL_NPM_REMAINED'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
const stub = JSON.parse(await readFile('/app/node_modules/npm/package.json', 'utf8'));
if (stub.name !== '@jeff/disabled-npm' || stub.jeffPackageManagementDisabled !== true || Object.keys(stub.dependencies || {}).length) throw new Error('DISABLED_NPM_REQUIRED');
console.log('JEFF_RUNTIME_PACKAGE_MANAGEMENT_DISABLED');
