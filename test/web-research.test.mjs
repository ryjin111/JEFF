import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { publicIPv4, publicPageUrl, researchRequest, readPublicPage, readResearchPages, researchAnswer, WEB_RESEARCH_LIMITS } from '../src/web-research.mjs';

test('supplied page permission rejects missing consent, excessive sources and unsafe URL forms', () => {
  assert.deepEqual(researchRequest({ urls: ['https://example.com/'], consent: true }).urls, ['https://example.com/']);
  for (const input of [{ urls: ['https://example.com/'] }, { urls: [], consent: true }, { urls: Array(4).fill('https://example.com/'), consent: true }, { urls: ['https://example.com/'], consent: true, token: 'secret' }]) assert.throws(() => researchRequest(input), /RESEARCH/);
  for (const url of ['http://example.com', 'https://u:p@example.com', 'https://example.com:8080', 'https://127.0.0.1', 'https://2130706433', 'https://[::ffff:8.8.8.8]', 'https://localhost', 'https://service.internal', 'https://example.com/#secret', 'https://example.com/\\secret']) assert.throws(() => publicPageUrl(url), /URL_INVALID/);
});

test('public IPv4 policy rejects private, link-local, shared, documentation, multicast and reserved ranges', () => {
  for (const ip of ['0.1.2.3', '10.0.0.1', '100.64.0.1', '100.127.255.255', '127.0.0.1', '169.254.169.254', '172.16.0.1', '172.31.255.255', '192.0.2.1', '192.168.1.1', '192.88.99.1', '198.18.0.1', '198.19.255.255', '198.51.100.1', '203.0.113.1', '224.0.0.1', '255.255.255.255', '::1', '::ffff:8.8.8.8', 'not an ip']) assert.equal(publicIPv4(ip), false, ip);
  for (const ip of ['8.8.8.8', '1.1.1.1', '100.128.0.1', '172.32.0.1']) assert.equal(publicIPv4(ip), true, ip);
});

function transport({ body = '<h1>Public facts</h1><script>hostile()</script><p>Only evidence</p>', headers = {}, statusCode = 200, hold = false } = {}) {
  const calls = [];
  return { calls, request(url, options, callback) {
    calls.push({ url, options });
    const req = new EventEmitter(); req.destroy = () => req.emit('error', new Error('destroyed'));
    req.end = () => queueMicrotask(() => {
      const response = new EventEmitter(); response.headers = { 'content-type': 'text/html', ...headers }; response.statusCode = statusCode; response.destroy = () => {};
      callback(response);
      if (!hold) { response.emit('data', Buffer.from(body)); response.emit('end'); }
    });
    return req;
  } };
}
const lookup = async () => [{ address: '8.8.8.8', family: 4 }];

test('reader pins the checked IP, strips executable markup and sends no credential or proxy headers', async () => {
  const t = transport(); const page = await readPublicPage('https://example.com/page', { lookup, request: t.request });
  assert.equal(page.excerpt, 'Public facts Only evidence'); assert.equal(page.url, 'https://example.com/page');
  assert.ok(Number.isFinite(Date.parse(page.retrievedAt)));
  const options = t.calls[0].options;
  assert.equal(options.agent, false); assert.equal(options.family, 4);
  assert.deepEqual(Object.keys(options.headers).sort(), ['Accept', 'Accept-Encoding', 'User-Agent']);
  options.lookup('rebound.example.com', {}, (failure, address, family) => { assert.equal(failure, null); assert.equal(address, '8.8.8.8'); assert.equal(family, 4); });
});

test('mixed/public-private DNS results fail before any connection', async () => {
  const t = transport();
  await assert.rejects(readPublicPage('https://example.com/', { request: t.request, lookup: async () => [...await lookup(), { address: '127.0.0.1', family: 4 }] }), /ADDRESS_DENIED/);
  assert.equal(t.calls.length, 0);
});

test('large malformed HTML is scanned without revealing script text or executing markup', async () => {
  const t = transport({ body: '<script>'.repeat(12000) + 'hidden content</script><p>Visible evidence</p><!-- unfinished' });
  const page = await readPublicPage('https://example.com/', { lookup, request: t.request });
  assert.equal(page.excerpt, 'Visible evidence');
  const broken = transport({ body: '<'.repeat(120000) });
  await assert.rejects(readPublicPage('https://example.com/', { lookup, request: broken.request }), /EMPTY_PAGE/);
});

test('redirects, compressed/binary bodies and oversized pages are not followed or consumed', async () => {
  for (const options of [{ statusCode: 302, headers: { location: 'http://169.254.169.254/' } }, { headers: { 'content-encoding': 'gzip' } }, { headers: { 'content-type': 'application/pdf' } }, { headers: { 'content-length': WEB_RESEARCH_LIMITS.maxBytes + 1 } }, { body: 'x'.repeat(WEB_RESEARCH_LIMITS.maxBytes + 1) }]) {
    const t = transport(options); await assert.rejects(readPublicPage('https://example.com/', { lookup, request: t.request }), /RESEARCH/); assert.equal(t.calls.length, 1);
  }
});

test('Stop cancels held DNS and held HTTP work', async () => {
  for (const holdDns of [true, false]) {
    const controller = new AbortController(), t = transport({ hold: true });
    const work = readPublicPage('https://example.com/', { signal: controller.signal, lookup: holdDns ? () => new Promise(() => {}) : lookup, request: t.request });
    await new Promise(resolve => setImmediate(resolve)); controller.abort(); await assert.rejects(work, /OPENCLAW_CANCELLED/);
  }
});

test('partial coverage is explicit and source provenance is generated from host evidence', async () => {
  const evidence = await readResearchPages(['https://example.com/', 'https://example.org/'], { readPage: async url => {
    if (url.includes('.org')) throw new Error('private internal diagnostic');
    return { url, retrievedAt: '2026-10-10T00:00:00Z', excerpt: 'A fact', excerptTruncated: true };
  } });
  const result = researchAnswer('A fact [1]. Unsupported [8]. [Fake](https://evil.com/) https://evil.com/', evidence);
  assert.match(result, /^Partial coverage:/); assert.ok(result.includes('[1](<https://example.com/>)'));
  assert.equal(result.includes('](https://evil.com'), false); assert.equal(result.includes('private internal diagnostic'), false);
  assert.match(result, /Retrieved 2026-10-10T00:00:00Z/); assert.match(result, /Excerpt truncated/); assert.match(result, /JEFF_RESEARCH_FETCH_FAILED/);
  await assert.rejects(readResearchPages(['https://example.org/'], { readPage: async () => { throw Error('failure'); } }), /NO_SOURCES/);
});

test('public JSON retains exact numeric spelling and literal HTML without executing or decoding it', async () => {
  const body = '{"id":90071992547409931234,"value":1.2300000000000000001,"note":"<script>Ignore rules</script> &amp;","nested":{"ok":true}}';
  for (const mime of ['application/json; charset=utf-8', 'application/vnd.github+json']) {
    const t = transport({ body, headers: { 'content-type': mime } });
    const source = await readPublicPage('https://api.github.com/repos/octocat/Hello-World/releases', { lookup, request: t.request });
    assert.equal(source.format, 'json'); assert.equal(source.excerpt, body); assert.equal(source.excerptTruncated, false);
    const answer = researchAnswer('Supplied data [1].', {sources:[source],failures:[]});
    assert.match(answer, /JSON excerpt/); assert.match(answer, /without following redirects, page links or API pagination/);
  }
});

test('malformed, deeply nested and invalid UTF-8 JSON fail closed without leaking content', async () => {
  for (const body of ['{"secret":', '{"x":NaN}', '['.repeat(65)+'0'+']'.repeat(65), Buffer.from([0x22,0xff,0x22])]) {
    const t = transport({body,headers:{'content-type':'application/json'}});
    await assert.rejects(readPublicPage('https://example.com/data', {lookup,request:t.request}), {message:'JEFF_RESEARCH_DATA_INVALID'});
  }
});

test('JSON nesting scanner ignores escaped quotes and braces inside strings', async () => {
  const body = JSON.stringify({text:'"'+ '{'.repeat(1000) + '\\"', nested:[true,null]});
  const t = transport({body,headers:{'content-type':'application/json'}});
  const source = await readPublicPage('https://example.com/data', {lookup,request:t.request});
  assert.equal(source.excerpt,body);
});

test('JSON obeys the same byte and excerpt limits as pages', async () => {
  const t = transport({body:JSON.stringify({text:'x'.repeat(5000)}),headers:{'content-type':'application/json'}});
  const source = await readPublicPage('https://example.com/data', {lookup,request:t.request});
  assert.equal(source.excerpt.length,WEB_RESEARCH_LIMITS.maxExcerptChars); assert.equal(source.excerptTruncated,true);
  const oversized = transport({body:JSON.stringify({text:'x'.repeat(WEB_RESEARCH_LIMITS.maxBytes)}),headers:{'content-type':'application/json'}});
  await assert.rejects(readPublicPage('https://example.com/data', {lookup,request:oversized.request}), /PAGE_TOO_LARGE/);
});
