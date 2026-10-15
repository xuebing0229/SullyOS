/**
 * ElevenLabs Forced Alignment 代理（Vercel serverless）。
 * 客户端传 JSON(base64 音频 + 纯文本)，这里转换成官方要求的 multipart/form-data。
 * Key、音频和剧情文本只做请求转发，不记录、不持久化。
 */
const ELEVENLABS_FORCED_ALIGNMENT = 'https://api.elevenlabs.io/v1/forced-alignment';

function setCors(res: any) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,xi-api-key');
}

function normalizeApiKey(raw?: string): string {
  return (raw || '').trim();
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
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
    if (!apiKey) {
      res.status(400).json({ error: 'Missing API key. Provide xi-api-key or ELEVENLABS_API_KEY.' });
      return;
    }

    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const audioBase64 = typeof body.audio_base64 === 'string' ? body.audio_base64.trim() : '';
    const text = typeof body.text === 'string' ? body.text : '';
    const mimeType = typeof body.mime_type === 'string' && /^audio\/[a-z0-9.+-]+$/i.test(body.mime_type)
      ? body.mime_type
      : 'audio/mpeg';
    if (!audioBase64 || !text.trim()) {
      res.status(400).json({ error: 'Missing audio_base64 or text' });
      return;
    }

    const form = new FormData();
    form.append('file', new Blob([base64ToBytes(audioBase64)], { type: mimeType }), 'dialogue.mp3');
    form.append('text', text);

    const upstream = await fetch(ELEVENLABS_FORCED_ALIGNMENT, {
      method: 'POST',
      headers: { 'xi-api-key': apiKey, Accept: 'application/json' },
      body: form,
    });
    const responseText = await upstream.text();
    res.status(upstream.status);
    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/json; charset=utf-8');
    res.send(responseText);
  } catch (error: any) {
    res.status(500).json({ error: error?.message || 'ElevenLabs forced alignment proxy request failed' });
  }
}
