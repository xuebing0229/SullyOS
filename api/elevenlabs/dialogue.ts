/**
 * ElevenLabs Text-to-Dialogue with timestamps 代理（Vercel serverless）。
 * Key 由客户端请求头或部署环境变量提供；代理只转发，不记录 Key 与剧情文本。
 */
const ELEVENLABS_DIALOGUE = 'https://api.elevenlabs.io/v1/text-to-dialogue/with-timestamps';
const DEFAULT_OUTPUT_FORMAT = 'mp3_44100_128';

function setCors(res: any) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,xi-api-key');
}

function normalizeApiKey(raw?: string): string {
  return (raw || '').trim();
}

function normalizeOutputFormat(raw: unknown): string {
  const value = typeof raw === 'string' ? raw.trim() : '';
  return /^[a-z0-9_]{3,32}$/.test(value) ? value : DEFAULT_OUTPUT_FORMAT;
}

export default async function handler(req: any, res: any) {
  setCors(res);

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method Not Allowed' });
    return;
  }

  try {
    const incomingKey = typeof req.headers['xi-api-key'] === 'string' ? req.headers['xi-api-key'] : '';
    const envKey = typeof process.env.ELEVENLABS_API_KEY === 'string' ? process.env.ELEVENLABS_API_KEY : '';
    const apiKey = normalizeApiKey(incomingKey) || normalizeApiKey(envKey);
    const outputFormat = normalizeOutputFormat(req.query?.output_format);

    if (!apiKey) {
      res.status(400).json({ error: 'Missing API key. Provide xi-api-key or ELEVENLABS_API_KEY.' });
      return;
    }

    const upstream = await fetch(
      `${ELEVENLABS_DIALOGUE}?output_format=${encodeURIComponent(outputFormat)}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'xi-api-key': apiKey,
        },
        body: typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {}),
      },
    );

    const contentType = upstream.headers.get('content-type') || 'application/json; charset=utf-8';
    const text = await upstream.text();
    res.status(upstream.status);
    res.setHeader('Content-Type', contentType);
    res.send(text);
  } catch (error: any) {
    res.status(500).json({ error: error?.message || 'ElevenLabs dialogue proxy request failed' });
  }
}
