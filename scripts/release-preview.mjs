// Explicit local development fixture. Never used by Docker or src/server.mjs.
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { resolve, dirname, sep } from 'node:path';
import { privateKeyToAccount } from 'viem/accounts';
import { createJeffApplication } from '../src/application.mjs';

const port = Number(process.env.JEFF_PREVIEW_PORT || 8421);
const origin = `http://127.0.0.1:${port}`;
const parent = resolve('.private');
await mkdir(parent, { recursive: true });
const root = await mkdtemp(resolve(parent, 'release-preview-'));
const publicRoot = resolve('public');
const account = privateKeyToAccount('0x' + '12'.repeat(32)); // Public disposable fixture; no live assets or RPC.
const owner = account.address.toLowerCase();
const collection = '0x' + '33'.repeat(20), tokenIds = ['35', '128', '207'];
const expiresAt = new Date(Date.now() + 86400000).toISOString();
process.env.JEFF_PILOT_NFTS = tokenIds.join(',');
process.env.JEFF_PILOT_EXPIRES_AT = expiresAt;
process.env.JEFF_PAID_CHECKOUT_ENABLED = 'false';
process.env.JEFF_FREE_PASS_ENABLED = 'false';
const app = await createJeffApplication({ origin, dataRoot: resolve(root, 'data'), publicRoot, fixture: true,
  env: { PORT: String(port), JEFF_PUBLIC_ORIGIN: origin, JEFF_CHAIN_ID: '4663', JEFF_COLLECTION: collection,
    JEFF_ALLOWED_MODELS: 'bankr/fixture-model', JEFF_CONTINUOUS_HOSTING: 'true' },
  resolveOwner: async scope => ({ owner, ownerEpoch: 0 }),
  discoverNfts: async ({ wallet }) => ({ chainId: 4663, collection, wallet: wallet.toLowerCase(), tokenIds: wallet.toLowerCase() === owner ? tokenIds : [],
    balance: wallet.toLowerCase() === owner ? tokenIds.length : 0, blockNumber: '100', complete: true }),
  runAgent: async ({ objective, executionContext, signal }) => {
    await new Promise((done, reject) => {
      if (signal.aborted) return reject(new Error('JEFF_OPENCLAW_CANCELLED'));
      const abort = () => { clearTimeout(timer); reject(new Error('JEFF_OPENCLAW_CANCELLED')); };
      const timer = setTimeout(() => { signal.removeEventListener('abort', abort); done(); }, 1400);
      signal.addEventListener('abort', abort, { once: true });
    });
    return { text: `Local verification result\n\nRequest: ${objective}\n\nThis response was produced by the development fixture. No AI provider was called.\n\nThe service supplied ${executionContext.memories.length} saved memory notes and ${executionContext.history.length} previous conversation turns. This job and its conversation are stored through the real persistence path.`, model: 'bankr/fixture-model' };
  },
});
const handler = app.server.listeners('request')[0];
app.server.removeAllListeners('request');
const walletScript = `(() => {const wallet='${owner}'; const listeners={}; window.ethereum={request:async({method,params})=>{if(method==='eth_accounts'||method==='eth_requestAccounts')return[wallet];if(method==='eth_chainId')return'0x1237';if(method==='personal_sign'){const r=await fetch('/__fixture/sign',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({message:params[0],wallet:params[1]})});if(!r.ok)throw Error('Fixture signature unavailable');return(await r.json()).signature;}throw Error('Method unavailable in local fixture');},on:(event,fn)=>{listeners[event]=fn;},removeListener:(event)=>{delete listeners[event];}};})();`;
app.server.on('request', async (request, response) => {
  if (request.method === 'GET' && ['/', '/index.html'].includes(request.url)) {
    const html = await readFile(resolve(publicRoot, 'index.html'), 'utf8');
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'" });
    response.end(html.replace('</head>', '<script src="/__fixture/wallet.js" defer></script></head>')); return;
  }
  if (!request.url.startsWith('/__fixture/')) return handler(request, response);
  response.setHeader('Cache-Control', 'no-store');
  if (request.headers.origin && request.headers.origin !== origin) { response.writeHead(403); response.end(); return; }
  if (request.method === 'GET' && request.url === '/__fixture/wallet.js') {
    response.writeHead(200, { 'Content-Type': 'text/javascript' }); response.end(walletScript); return;
  }
  if (request.method === 'POST' && request.url === '/__fixture/sign') {
    try {
      let body = ''; for await (const chunk of request) { body += chunk; if (Buffer.byteLength(body) > 8192) throw Error(); }
      const value = JSON.parse(body);
      if (value.wallet?.toLowerCase() !== owner || typeof value.message !== 'string' || !/^0x[0-9a-f]+$/i.test(value.message)) throw Error();
      const signature = await account.signMessage({ message: { raw: value.message } });
      response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ signature })); return;
    } catch { response.writeHead(400); response.end(); return; }
  }
  response.writeHead(404); response.end();
});
let stopping = false;
const close = async () => {
  if (stopping) return; stopping = true;
  try { await app.close(); }
  finally {
    if (dirname(root) !== parent || !root.startsWith(parent + sep + 'release-preview-')) throw Error('Unsafe fixture cleanup path');
    await rm(root, { recursive: true, force: true });
  }
};
process.on('SIGINT', () => close().then(() => process.exit(0)));
process.on('SIGTERM', () => close().then(() => process.exit(0)));
app.server.listen(port, '127.0.0.1', () => console.log(`JEFF development fixture: ${origin}\nDisposable signing wallet; simulated model; isolated storage. No live provider, money or chain calls.`));
