/** ElevenLabs 只读订阅额度代理；只使用请求的 Key，不回退到服务端账号。 */
export default async function handler(req: any, res: any) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'xi-api-key, Accept');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'GET') { res.status(405).json({ error: 'Method not allowed' }); return; }
  const apiKey = typeof req.headers['xi-api-key'] === 'string' ? req.headers['xi-api-key'].trim() : '';
  if (!apiKey) { res.status(401).json({ error: 'Missing xi-api-key header' }); return; }
  try {
    const upstream = await fetch('https://api.elevenlabs.io/v1/user/subscription', {
      method: 'GET',
      headers: { 'xi-api-key': apiKey, 'Accept': 'application/json' },
    });
    res.setHeader('Content-Type', upstream.headers.get('Content-Type') || 'application/json; charset=utf-8');
    res.status(upstream.status).send(await upstream.text());
  } catch {
    res.status(502).json({ error: 'ElevenLabs subscription request failed' });
  }
}
