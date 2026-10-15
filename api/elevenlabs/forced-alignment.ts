/**
 * ElevenLabs Forced Alignment 代理（Vercel serverless）。
 * 客户端提交 Dialogue 音频 base64 + 实际说出口的纯文本；这里转换为官方要求的 multipart。
 * 不记录、不持久化 API Key、剧情文本或音频。
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

    let body = req.body || {};
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch { body = {}; }
    }
    const audioBase64 = typeof body.audio_base64 === 'string' ? body.audio_base64.trim() : '';
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (!audioBase64 || !text) {
      res.status(400).json({ error: 'audio_base64 and text are required' });
      return;
    }
    if (audioBase64.length > 24 * 1024 * 1024 || text.length > 10000) {
      res.status(413).json({ error: 'Forced alignment payload too large' });
      return;
    }

    let bytes: Uint8Array;
    try {
      bytes = Uint8Array.from(Buffer.from(audioBase64, 'base64'));
    } catch {
      res.status(400).json({ error: 'Invalid audio_base64' });
      return;
    }
    if (!bytes.length) {
      res.status(400).json({ error: 'Invalid audio_base64' });
      return;
    }

    const form = new FormData();
    form.append('file', new Blob([bytes], { type: 'audio/mpeg' }), 'dialogue.mp3');
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
