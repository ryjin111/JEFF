import { createHash, createHmac } from 'node:crypto';
const sha = value => createHash('sha256').update(value).digest('hex');
const mac = (key, value) => createHmac('sha256', key).update(value).digest();
const encode = value => encodeURIComponent(value).replace(/[!'()*]/g, value => '%' + value.charCodeAt(0).toString(16).toUpperCase());

// S3/R2 SigV4. Only encrypted objects cross this boundary.
export function createBackupObjectStore({ endpoint, bucket, region, accessKeyId, secretAccessKey, prefix = 'jeff', urlStyle = 'path' }, { fetchImpl = fetch, now = () => new Date() } = {}) {
  let base;
  try { base = new URL(endpoint); } catch { throw new Error('JEFF_BACKUP_STORE_CONFIG_INVALID'); }
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash || base.pathname !== '/'
    || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket || '') || !/^[a-z0-9-]{1,40}$/.test(region || '')
    || !/^[A-Za-z0-9_-]{8,128}$/.test(accessKeyId || '') || typeof secretAccessKey !== 'string' || secretAccessKey.length < 16
    || /[\r\n]/.test(secretAccessKey) || !/^[a-zA-Z0-9/_-]{1,120}$/.test(prefix)
    || !['path', 'virtual-host'].includes(urlStyle) || (urlStyle === 'virtual-host' && bucket.includes('.'))) throw new Error('JEFF_BACKUP_STORE_CONFIG_INVALID');
  if (urlStyle === 'virtual-host') base.hostname = bucket + '.' + base.hostname;
  async function request(method, key, bytes = Buffer.alloc(0)) {
    if (!/^[a-zA-Z0-9._-]{1,160}$/.test(key)) throw new Error('JEFF_BACKUP_OBJECT_INVALID');
    const path = '/' + [...(urlStyle === 'path' ? [bucket] : []), ...prefix.split('/'), key].map(encode).join('/');
    const at = now().toISOString().replace(/[:-]|\.\d{3}/g, ''), day = at.slice(0, 8), digest = sha(bytes);
    const headers = { host: base.host, 'x-amz-content-sha256': digest, 'x-amz-date': at };
    const signed = 'host;x-amz-content-sha256;x-amz-date';
    const canonical = [method, path, '', Object.entries(headers).map(([name, value]) => `${name}:${value}\n`).join(''), signed, digest].join('\n');
    const scope = `${day}/${region}/s3/aws4_request`;
    const signing = mac(mac(mac(mac('AWS4' + secretAccessKey, day), region), 's3'), 'aws4_request');
    headers.authorization = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signed}, Signature=${mac(signing, `AWS4-HMAC-SHA256\n${at}\n${scope}\n${sha(canonical)}`).toString('hex')}`;
    return fetchImpl(base.origin + path, { method, headers, redirect: 'error', signal: AbortSignal.timeout(30000),
      ...(method === 'PUT' ? { body: bytes } : {}) });
  }
  return Object.freeze({ async putVerified(key, bytes) {
    if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > 128 * 1024 * 1024) throw new Error('JEFF_BACKUP_OBJECT_INVALID');
    const put = await request('PUT', key, bytes);
    if (!put.ok) { await put.body?.cancel(); throw new Error('JEFF_BACKUP_UPLOAD_FAILED'); }
    await put.body?.cancel();
    const get = await request('GET', key);
    if (!get.ok) { await get.body?.cancel(); throw new Error('JEFF_BACKUP_READBACK_FAILED'); }
    const reader = get.body?.getReader(); if (!reader) throw new Error('JEFF_BACKUP_READBACK_FAILED');
    const hash = createHash('sha256'); let size = 0;
    try { for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length;
      if (size > bytes.length) throw new Error('JEFF_BACKUP_READBACK_FAILED'); hash.update(value); }
    } finally { await reader.cancel().catch(() => {}); }
    if (size !== bytes.length || hash.digest('hex') !== sha(bytes)) throw new Error('JEFF_BACKUP_READBACK_FAILED');
    return { key, bytes: size, sha256: sha(bytes), readbackVerified: true };
  } });
}
