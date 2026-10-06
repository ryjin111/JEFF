import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { createJeffOpenClawNftBridge } from 'jeff-agent-nft/openclaw';
import { createOwnershipResolver } from './chain.mjs';
import { createHolderSessions } from './auth.mjs';
import { createOpenClawRunner } from './openclaw-runner.mjs';

const port = Number(process.env.PORT || 8788);
const origin = process.env.JEFF_PUBLIC_ORIGIN || `http://127.0.0.1:${port}`;
const chainId = Number(process.env.JEFF_CHAIN_ID || 4663);
const collection = (process.env.JEFF_COLLECTION || '0xf4127ac7e73a807060cbdd08fc2c776b2e78ce67').toLowerCase();
const rpcUrl = process.env.JEFF_RPC_URL || 'https://rpc.mainnet.chain.robinhood.com';
const resolveOwner = createOwnershipResolver({ chainId, collection, rpcUrl });
const sessions = createHolderSessions({ origin, chainId, collection, resolveOwner });
const bridge = createJeffOpenClawNftBridge({ dataRoot: resolve(process.env.JEFF_DATA_ROOT || 'data'), resolveOwner, runAgent: createOpenClawRunner() });
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
  try {
    if (request.headers.origin && request.headers.origin !== origin) return send(response, 403, { error: 'JEFF_ORIGIN_DENIED' });
    const url = new URL(request.url, origin);
    const method = request.method;
    if (method === 'GET' && url.pathname === '/api/config') return send(response, 200, { product: 'Simple JEFF', stage: 'local-runtime-pilot',
      chainId, collection, modelConfigured: Boolean(process.env.BANKR_LLM_API_KEY), billingEnabled: false, continuousHosting: false, toolsEnabled: false });
    if (method === 'POST' && url.pathname === '/api/auth/challenge') return send(response, 200, await sessions.challenge(await body(request)));
    if (method === 'POST' && url.pathname === '/api/auth/verify') return send(response, 200, await sessions.verify(await body(request)));
    if (method === 'POST' && url.pathname === '/api/auth/logout') { sessions.logout(token(request)); return send(response, 200, { loggedOut: true }); }
    if (url.pathname.startsWith('/api/')) {
      const scope = await sessions.authenticate(token(request));
      if (method === 'POST' && url.pathname === '/api/jobs') {
        if (!process.env.BANKR_LLM_API_KEY) return send(response, 503, { error: 'JEFF_MODEL_NOT_CONFIGURED' });
        const input = await body(request);
        if (typeof input.objective !== 'string' || !input.objective.trim() || input.objective.length > 4000) return send(response, 400, { error: 'JEFF_OBJECTIVE_INVALID' });
        // The durable bridge record owns the job ID. This request remains open for
        // the first slice; its result can always be fetched again after reconnect.
        return send(response, 200, await bridge.run(scope, input.objective));
      }
      if (method === 'GET' && /^\/api\/jobs\/[a-f0-9-]{36}$/.test(url.pathname)) return send(response, 200, await bridge.retrieve(scope, url.pathname.split('/').at(-1)));
      return send(response, 404, { error: 'JEFF_ROUTE_NOT_FOUND' });
    }
    if (method !== 'GET' && method !== 'HEAD') return send(response, 405, { error: 'JEFF_METHOD_DENIED' });
    const path = resolve(publicRoot, `.${decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)}`);
    if (!path.startsWith(publicRoot + sep)) return send(response, 403, { error: 'JEFF_PATH_DENIED' });
    const content = await readFile(path);
    const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };
    response.writeHead(200, { 'Content-Type': mime[extname(path)] || 'application/octet-stream' });
    response.end(method === 'HEAD' ? undefined : content);
  } catch (error) {
    const message = /^JEFF_[A-Z_]+$/.test(error.message) ? error.message : 'JEFF_SERVICE_UNAVAILABLE';
    const status = /SESSION|OWNER|SIGNATURE|CHALLENGE/.test(message) ? 401 : /NOT_FOUND/.test(message) ? 404 : /INVALID|TOO_LARGE/.test(message) ? 400 : /BUSY/.test(message) ? 409 : 503;
    send(response, status, { error: message });
  }
});
server.listen(port, process.env.JEFF_BIND || '127.0.0.1', () => console.log(`Simple JEFF local pilot: ${origin}`));
