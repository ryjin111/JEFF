import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { createJeffOpenClawNftBridge, createJeffOpenClawAccountBridge } from 'jeff-agent-nft/openclaw';
import { createOwnershipResolver } from './chain.mjs';
import { createHolderSessions } from './auth.mjs';
import { createAccountSessions } from './account-auth.mjs';
import { createOpenClawRunner } from './openclaw-runner.mjs';
import { createHostingLedger } from './hosting.mjs';
import { createClockersPaymentVerifier } from './payment.mjs';
import { createMaintenanceGate, createDurableJobReader, waitForDurableJob } from './maintenance.mjs';

const maintenance = createMaintenanceGate({
  markerPath: process.env.JEFF_MAINTENANCE_MARKER || (process.platform === 'win32' ? resolve('.private/simple-jeff-maintenance.json') : '/tmp/simple-jeff-maintenance.json'),
  releaseSha: process.env.JEFF_RELEASE_SHA || null,
});
process.on('SIGUSR2', () => {
  maintenance.pause().then(marker => {
    if (marker) console.log(JSON.stringify({ event: 'JEFF_MAINTENANCE_READY', ...marker }));
  }).catch(() => console.error('JEFF_MAINTENANCE_DRAIN_FAILED'));
});
process.on('SIGCONT', () => {
  maintenance.resume().catch(() => console.error('JEFF_MAINTENANCE_RESUME_FAILED'));
});

const port = Number(process.env.PORT || 8788);
const origin = process.env.JEFF_PUBLIC_ORIGIN || `http://127.0.0.1:${port}`;
const chainId = Number(process.env.JEFF_CHAIN_ID || 4663);
const collection = (process.env.JEFF_COLLECTION || '0xf4127ac7e73a807060cbdd08fc2c776b2e78ce67').toLowerCase();
const rpcUrl = process.env.JEFF_RPC_URL || 'https://rpc.mainnet.chain.robinhood.com';
const resolveOwner = createOwnershipResolver({ chainId, collection, rpcUrl });
const dataRoot = resolve(process.env.JEFF_DATA_ROOT || 'data');
const sessions = createHolderSessions({ origin, chainId, collection, resolveOwner });
const accountSessions = createAccountSessions({ origin, chainId, dataRoot });
const bridge = createJeffOpenClawNftBridge({ dataRoot, resolveOwner, runAgent: createOpenClawRunner() });
const accountBridge = createJeffOpenClawAccountBridge({ dataRoot, resolveAccount: accountSessions.registered, runAgent: createOpenClawRunner() });
const hosting = createHostingLedger({ dataRoot, verifyPayment: createClockersPaymentVerifier({ rpcUrl, chainId }) });
const trackJob = (scope, id) => maintenance.track(waitForDurableJob({ readRecord: createDurableJobReader({ dataRoot, scope, id }) }), `job:${id}`);
const usage = new Map();
const publicRoot = resolve('public');
const token = request => request.headers.authorization?.replace(/^Bearer /, '');
async function body(request) {
  let data = ''; let size = 0;
  for await (const chunk of request) { size += chunk.length; if (size > 8192) throw new Error('JEFF_REQUEST_TOO_LARGE'); data += chunk; }
  try { return JSON.parse(data); } catch { throw new Error('JEFF_REQUEST_INVALID'); }
}
const send = (response, status, value) => { response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(value)); };
const server = createServer(async (request, response) => {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  const finishRequest = maintenance.beginRequest();
  if (!finishRequest) return send(response, 503, { error: 'JEFF_SERVICE_MAINTENANCE' });
  try {
    if (request.headers.origin && request.headers.origin !== origin) return send(response, 403, { error: 'JEFF_ORIGIN_DENIED' });
    const url = new URL(request.url, origin);
    const method = request.method;
    if (method === 'GET' && url.pathname === '/health') return send(response, 200, { status: 'ready', runtime: 'openclaw' });
    if (method === 'GET' && url.pathname === '/api/config') return send(response, 200, { product: 'Simple JEFF', stage: process.env.JEFF_CONTINUOUS_HOSTING === 'true' ? 'hosted-pilot' : 'local-runtime-pilot',
      chainId, collection, releaseSha: process.env.JEFF_RELEASE_SHA || null, modelConfigured: Boolean(process.env.BANKR_LLM_API_KEY), billingEnabled: hosting.enabled,
      continuousHosting: process.env.JEFF_CONTINUOUS_HOSTING === 'true', standaloneAccounts: true, toolsEnabled: false });
    if (method === 'POST' && url.pathname === '/api/account/auth/challenge') return send(response, 200, await accountSessions.challenge(await body(request)));
    if (method === 'POST' && url.pathname === '/api/account/auth/verify') return send(response, 200, await accountSessions.verify(await body(request)));
    if (method === 'POST' && url.pathname === '/api/auth/challenge') return send(response, 200, await sessions.challenge(await body(request)));
    if (method === 'POST' && url.pathname === '/api/auth/verify') return send(response, 200, await sessions.verify(await body(request)));
    if (method === 'POST' && url.pathname === '/api/auth/logout') { sessions.logout(token(request)); accountSessions.logout(token(request)); return send(response, 200, { loggedOut: true }); }
    if (url.pathname.startsWith('/api/')) {
      const scope = await (accountSessions.has(token(request)) ? accountSessions : sessions).authenticate(token(request));
      const activeBridge = scope.kind === 'account' ? accountBridge : bridge;
      if (method === 'GET' && url.pathname === '/api/hosting') return send(response, 200, await hosting.status(scope));
      if (method === 'POST' && url.pathname === '/api/hosting/invoice') return send(response, 200, await hosting.invoice(scope));
      if (method === 'POST' && url.pathname === '/api/hosting/activate') return send(response, 200, await hosting.activate(scope, await body(request)));
      if (method === 'POST' && url.pathname === '/api/jobs') {
        await hosting.requireActive(scope);
        if (!process.env.BANKR_LLM_API_KEY) return send(response, 503, { error: 'JEFF_MODEL_NOT_CONFIGURED' });
        const input = await body(request);
        if (typeof input.objective !== 'string' || !input.objective.trim() || input.objective.length > 4000) return send(response, 400, { error: 'JEFF_OBJECTIVE_INVALID' });
        const hour = Math.floor(Date.now()/3600000); const meterKey = `${scope.owner}:${hour}`;
        for (const key of usage.keys()) if (!key.endsWith(`:${hour}`)) usage.delete(key);
        if ((usage.get(meterKey) || 0) >= 10) throw new Error('JEFF_USAGE_LIMIT_REACHED');
        usage.set(meterKey, (usage.get(meterKey) || 0) + 1);
        const record = await activeBridge.start(scope, input.objective);
        trackJob(scope, record.id);
        return send(response, 202, record);
      }
      if (method === 'GET' && url.pathname === '/api/jobs') return send(response, 200, { jobs: await activeBridge.list(scope) });
      if (method === 'POST' && /^\/api\/jobs\/[a-f0-9-]{36}\/retry-save$/.test(url.pathname)) {
        const id = url.pathname.split('/')[3];
        const record = await activeBridge.retrySave(scope, id);
        trackJob(scope, id);
        return send(response, 200, record);
      }
      if (method === 'GET' && /^\/api\/jobs\/[a-f0-9-]{36}$/.test(url.pathname)) return send(response, 200, await activeBridge.retrieve(scope, url.pathname.split('/').at(-1)));
      return send(response, 404, { error: 'JEFF_ROUTE_NOT_FOUND' });
    }
    if (method !== 'GET' && method !== 'HEAD') return send(response, 405, { error: 'JEFF_METHOD_DENIED' });
    const path = resolve(publicRoot, `.${decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)}`);
    if (!path.startsWith(publicRoot + sep)) return send(response, 403, { error: 'JEFF_PATH_DENIED' });
    const content = await readFile(path);
    const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.woff': 'font/woff' };
    response.writeHead(200, { 'Content-Type': mime[extname(path)] || 'application/octet-stream' });
    response.end(method === 'HEAD' ? undefined : content);
  } catch (error) {
    const message = /^JEFF_[A-Z_]+$/.test(error.message) ? error.message : 'JEFF_SERVICE_UNAVAILABLE';
    const status = /SESSION|OWNER|SIGNATURE|CHALLENGE/.test(message) ? 401 : /NOT_FOUND/.test(message) ? 404 : /INVALID|TOO_LARGE/.test(message) ? 400 : /BUSY/.test(message) ? 409 : 503;
    send(response, status, { error: message });
  } finally { finishRequest(); }
});
if (process.env.JEFF_VERIFY_RUNTIME === 'true') {
  const verification = import('./operator-smoke.mjs').then(module => module.verifyHostedRuntime());
  maintenance.track(verification, 'operator-verification')
    .then(proof => console.log(JSON.stringify({ event: 'JEFF_HOSTED_RUNTIME_VERIFIED', ...proof })))
    .catch(() => console.error('JEFF_HOSTED_RUNTIME_VERIFICATION_FAILED'));
}
await maintenance.resume();
server.listen(port, process.env.JEFF_BIND || '127.0.0.1', () => {
  console.log(`Simple JEFF: ${origin}`);
});
