import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { Lexer } from '../public/vendor/marked-18.0.11.esm.js';

export const WEB_RESEARCH_LIMITS = Object.freeze({ maxSources: 3, maxBytes: 131072, maxExcerptChars: 2400, timeoutMs: 8000 });
const error = code => new Error(`JEFF_RESEARCH_${code}`);
const cancelled = () => new Error('JEFF_OPENCLAW_CANCELLED');

export function publicIPv4(address) {
  if (isIP(address) !== 4) return false;
  const [a, b, c] = address.split('.').map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 0 || b === 168 || (b === 88 && c === 99)))
    || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
    || (a === 203 && b === 0 && c === 113));
}

export function publicPageUrl(value) {
  if (typeof value !== 'string' || value.length > 2048 || /[\s\\<>\u0000-\u001f\u007f]/.test(value)) throw error('URL_INVALID');
  let url;
  try { url = new URL(value); } catch { throw error('URL_INVALID'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || (url.port && url.port !== '443')
    || isIP(url.hostname) || /[\[\]:]/.test(url.hostname) || !url.hostname.includes('.') || /(?:^|\.)(?:localhost|local|internal|test|invalid|example|onion)\.?$/i.test(url.hostname)) throw error('URL_INVALID');
  return url;
}

export function researchRequest(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['urls', 'consent'].includes(key))
    || input.consent !== true || !Array.isArray(input.urls) || !input.urls.length || input.urls.length > WEB_RESEARCH_LIMITS.maxSources) throw error('CONSENT_INVALID');
  const urls = input.urls.map(value => publicPageUrl(value).href);
  if (new Set(urls).size !== urls.length) throw error('URL_INVALID');
  return { urls, consent: true };
}

function pageText(body, html) {
  let text = body;
  if (html) {
    const parts = []; let cursor = 0, hidden = null;
    while (cursor < body.length) {
      const opening = body.indexOf('<', cursor);
      if (opening < 0) { if (!hidden) parts.push(body.slice(cursor)); break; }
      if (!hidden) parts.push(body.slice(cursor, opening), ' ');
      if (body.startsWith('<!--', opening)) {
        const end = body.indexOf('-->', opening + 4);
        if (end < 0) break;
        cursor = end + 3; continue;
      }
      const closing = body.indexOf('>', opening + 1);
      if (closing < 0) break;
      const tag = /^\s*(\/?)\s*([a-z0-9]+)/i.exec(body.slice(opening + 1, Math.min(closing, opening + 256)));
      if (tag) {
        const name = tag[2].toLowerCase();
        if (hidden && tag[1] && name === hidden) hidden = null;
        else if (!hidden && !tag[1] && ['script', 'style', 'noscript', 'svg', 'template'].includes(name)) hidden = name;
      }
      cursor = closing + 1;
    }
    text = parts.join('');
  }
  text = text.replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (_, name) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' })[name]);
  return text.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function jsonText(bytes) {
  const body = new TextDecoder('utf-8', { fatal: true }).decode(bytes).trim();
  // Validate without reserializing: retain large integer and decimal spellings.
  // Bound structural depth before parsing, ignoring braces inside JSON strings.
  let depth = 0, quoted = false, escaped = false;
  for (const char of body) {
    if (quoted) { if (escaped) escaped = false; else if (char === '\\') escaped = true; else if (char === '"') quoted = false; }
    else if (char === '"') quoted = true;
    else if (char === '{' || char === '[') { if (++depth > 64) throw error('DATA_INVALID'); }
    else if (char === '}' || char === ']') depth--;
  }
  JSON.parse(body);
  return body.replace(/[\u0000-\u001f\u007f]+/g, ' ');
}

// Native HTTPS ignores proxy environment settings. Resolve and pin one public
// IPv4 address per request; no redirects, cookies, credentials or socket reuse.
export async function readPublicPage(value, { signal, lookup = dnsLookup, request = httpsRequest } = {}) {
  const url = publicPageUrl(value);
  if (signal?.aborted) throw cancelled();
  const deadline = AbortSignal.timeout(WEB_RESEARCH_LIMITS.timeoutMs);
  const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
  let abortLookup;
  let addresses;
  try {
    addresses = await Promise.race([lookup(url.hostname, { family: 4, all: true }), new Promise((_, reject) => {
      abortLookup = () => reject(signal?.aborted ? cancelled() : error('TIMEOUT'));
      combined.addEventListener('abort', abortLookup, { once: true });
      if (combined.aborted) abortLookup();
    })]);
  } catch (cause) {
    if (combined.aborted) throw signal?.aborted ? cancelled() : error('TIMEOUT');
    throw error('DNS_FAILED');
  } finally { if (abortLookup) combined.removeEventListener('abort', abortLookup); }
  if (!addresses?.length || addresses.some(item => item.family !== 4 || !publicIPv4(item.address))) throw error('ADDRESS_DENIED');
  if (combined.aborted) throw signal?.aborted ? cancelled() : error('TIMEOUT');
  const address = addresses[0].address;
  return new Promise((resolve, reject) => {
    let req, settled = false;
    const finish = (failure, result) => {
      if (settled) return;
      settled = true; combined.removeEventListener('abort', abort);
      failure ? reject(failure) : resolve(result);
    };
    const abort = () => { finish(signal?.aborted ? cancelled() : error('TIMEOUT')); req?.destroy(); };
    combined.addEventListener('abort', abort, { once: true });
    try {
      req = request(url, { agent: false, family: 4, maxHeaderSize: 8192,
        lookup: (_host, options, callback) => options?.all ? callback(null, [{ address, family: 4 }]) : callback(null, address, 4),
        headers: { Accept: 'text/html, application/json, application/*+json;q=0.9, text/plain;q=0.9', 'Accept-Encoding': 'identity', 'User-Agent': 'JEFF-PublicPageReader/1.0' } }, response => {
        const fail = code => { finish(error(code)); response.destroy(); req?.destroy(); };
        if (response.statusCode !== 200) return fail(response.statusCode >= 300 && response.statusCode < 400 ? 'REDIRECT_DENIED' : 'HTTP_FAILED');
        const mime = String(response.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
        const json = /^application\/(?:[a-z0-9!#$&^_.+-]+\+)?json$/.test(mime);
        if ((!json && !['text/html', 'text/plain', 'application/xhtml+xml'].includes(mime))
          || !['', 'identity'].includes(String(response.headers['content-encoding'] || '').toLowerCase())) return fail('CONTENT_DENIED');
        if (Number(response.headers['content-length']) > WEB_RESEARCH_LIMITS.maxBytes) return fail('PAGE_TOO_LARGE');
        const chunks = []; let bytes = 0;
        response.on('data', chunk => {
          bytes += chunk.length;
          if (bytes > WEB_RESEARCH_LIMITS.maxBytes) return fail('PAGE_TOO_LARGE');
          if (!settled) chunks.push(chunk);
        });
        response.on('error', () => finish(error('FETCH_FAILED')));
        response.on('aborted', () => finish(error('FETCH_FAILED')));
        response.on('end', () => {
          if (settled) return;
          let text;
          try { const body = Buffer.concat(chunks); text = json ? jsonText(body) : pageText(body.toString('utf8'), mime !== 'text/plain'); }
          catch { return finish(error('DATA_INVALID')); }
          if (!text) return finish(error('EMPTY_PAGE'));
          finish(null, { url: url.href, retrievedAt: new Date().toISOString(), bytes,
            format: json ? 'json' : mime === 'text/plain' ? 'text' : 'html',
            excerpt: text.slice(0, WEB_RESEARCH_LIMITS.maxExcerptChars), excerptTruncated: text.length > WEB_RESEARCH_LIMITS.maxExcerptChars });
        });
      });
      req.on('error', () => finish(signal?.aborted ? cancelled() : combined.aborted ? error('TIMEOUT') : error('FETCH_FAILED')));
      if (combined.aborted) abort(); else req.end();
    } catch { finish(error('FETCH_FAILED')); req?.destroy(); }
  });
}

export async function readResearchPages(urls, { signal, readPage = readPublicPage } = {}) {
  const sources = [], failures = [];
  for (const url of urls) {
    if (signal?.aborted) throw cancelled();
    try { sources.push(await readPage(url, { signal })); }
    catch (cause) {
      if (signal?.aborted || cause.message === 'JEFF_OPENCLAW_CANCELLED') throw cancelled();
      failures.push({ url, reason: /^JEFF_RESEARCH_[A-Z_]+$/.test(cause.message) ? cause.message : 'JEFF_RESEARCH_FETCH_FAILED' });
    }
  }
  if (!sources.length) throw error('NO_SOURCES');
  return { sources, failures };
}

export function researchAnswer(text, evidence) {
  if (typeof text !== 'string' || !text.trim() || text.length > 65536) throw error('ANSWER_INVALID');
  // The model supplies prose and numbered references, never authoritative URLs.
  // Use the same Markdown lexer as the UI, covering reference definitions,
  // entities, autolinks and mixed-case schemes rather than a URL regex.
  const links = [];
  const walk = (value, depth = 0) => {
    if (!value || typeof value !== 'object' || depth > 64) return;
    if (value.type === 'link' || value.type === 'image') links.push(value);
    for (const [key, child] of Object.entries(value)) if (key !== 'links') walk(child, depth + 1);
  };
  walk(Lexer.lex(text));
  let prose = text;
  for (const token of links.sort((a, b) => b.raw.length - a.raw.length)) {
    const label = String(token.text || 'Model reference').replace(/[\\`*_\[\]<>]/g, '\\$&').replace(/:/g, '&#58;');
    prose = prose.replaceAll(token.raw, label);
  }
  const linked = prose.replace(/\[(\d+)\]/g, (match, number) => {
    const source = evidence.sources[Number(number) - 1];
    return source ? `[${number}](<${source.url}>)` : '[unverified reference]';
  });
  const lines = [linked, '', '### Retrieved sources', '',
    'Coverage: '+(evidence.coverage||'supplied URLs only; bounded text or JSON excerpts, without following redirects, page links or API pagination.')];
  evidence.sources.forEach((source, index) => lines.push(`\n${index + 1}. [Source ${index + 1}](<${source.url}>) | Retrieved ${source.retrievedAt}${source.format === 'json' ? ' | JSON excerpt' : ''}${source.excerptTruncated ? ' | Excerpt truncated' : ''}`));
  if (evidence.failures.length) {
    lines.unshift('Partial coverage: some supplied pages could not be read.\n');
    lines.push('\n### Pages not retrieved');
    for (const failure of evidence.failures) lines.push(`\n${failure.url} | ${failure.reason}`);
  }
  const output = lines.join('\n');
  if (output.length > 65536) throw error('ANSWER_TOO_LARGE');
  return output;
}
