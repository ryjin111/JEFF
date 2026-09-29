const cleanBaseUrl = (value) => String(value ?? '').replace(/\/$/, '');

function endpointFor(baseUrl, allowRemote) {
  const parsed = new URL(cleanBaseUrl(baseUrl));
  if (parsed.username || parsed.password) throw new Error('JEFF_OPEN_WEIGHTS_ENDPOINT_CREDENTIALS_DENIED');
  const local = ['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname);
  if (!allowRemote && !local) throw new Error('JEFF_OPEN_WEIGHTS_REMOTE_ENDPOINT_DENIED');
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('JEFF_OPEN_WEIGHTS_ENDPOINT_INVALID');
  return `${parsed.href.replace(/\/$/, '').replace(/\/v1$/, '')}/v1/chat/completions`;
}

function parseObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  const raw = String(value ?? '').replace(/```(?:json)?/gi, '').replace(/```/g, '').trim();
  const first = raw.indexOf('{');
  const last = raw.lastIndexOf('}');
  if (first < 0 || last <= first) throw new Error('JEFF_OPEN_WEIGHTS_OUTPUT_INVALID_JSON');
  try {
    const parsed = JSON.parse(raw.slice(first, last + 1));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    return parsed;
  } catch {
    throw new Error('JEFF_OPEN_WEIGHTS_OUTPUT_INVALID_JSON');
  }
}

export function createJeffOpenWeightsProvider({
  baseUrl = 'http://127.0.0.1:11434',
  model,
  apiKey,
  allowRemote = false,
  fetcher = fetch,
  timeoutMs = 60_000,
  responseFormat = true,
} = {}) {
  if (typeof model !== 'string' || !model.trim()) throw new Error('JEFF_OPEN_WEIGHTS_MODEL_REQUIRED');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 300_000) {
    throw new Error('JEFF_OPEN_WEIGHTS_TIMEOUT_INVALID');
  }
  const endpoint = endpointFor(baseUrl, allowRemote);
  const selectedModel = model.trim();
  return Object.freeze({
    model: selectedModel,
    endpoint,
    async complete({ phase, system, prompt }) {
      const response = await fetcher(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: selectedModel,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: prompt },
          ],
          temperature: 0,
          ...(responseFormat ? { response_format: { type: 'json_object' } } : {}),
          metadata: { jeffPhase: phase },
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) throw new Error(`JEFF_OPEN_WEIGHTS_HTTP_${response.status}`);
      return parseObject((await response.json())?.choices?.[0]?.message?.content);
    },
  });
}
