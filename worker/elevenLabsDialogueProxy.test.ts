import { afterEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error central worker is a plain JS module
import worker from './index.js';

const API_KEY = 'xi-test-key-not-real';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('ElevenLabs dialogue proxy', () => {
  it('forwards dialogue payload and returns timestamp JSON without logging the key', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({
        audio_base64: 'YWJj',
        voice_segments: [{
          voice_id: 'voiceA123',
          start_time_seconds: 0,
          end_time_seconds: 1,
          dialogue_input_index: 0,
        }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    const payload = {
      model_id: 'eleven_v4',
      inputs: [
        { text: '[softly] 你好', voice_id: 'voiceA123' },
        { text: '[laughs] 我在', voice_id: 'voiceB123' },
      ],
    };
    const res = await worker.fetch(new Request(
      'https://proxy.test/elevenlabs/dialogue?output_format=mp3_44100_128',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'xi-api-key': API_KEY },
        body: JSON.stringify(payload),
      },
    ), {}, { waitUntil: () => {} });

    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.elevenlabs.io/v1/text-to-dialogue/with-timestamps?output_format=mp3_44100_128');
    expect((calls[0].init.headers as Record<string, string>)['xi-api-key']).toBe(API_KEY);
    expect(JSON.parse(String(calls[0].init.body))).toEqual(payload);
    expect(await res.json()).toMatchObject({ audio_base64: 'YWJj' });

    const logged = log.mock.calls.flat().join(' ');
    expect(logged).not.toContain(API_KEY);
    expect(logged).not.toContain('[softly] 你好');
  });

  it('rejects missing keys and invalid output formats without upstream fetch', async () => {
    const upstream = vi.fn();
    vi.stubGlobal('fetch', upstream);

    const noKey = await worker.fetch(new Request(
      'https://proxy.test/elevenlabs/dialogue',
      { method: 'POST', body: '{}' },
    ), {}, { waitUntil: () => {} });
    expect(noKey.status).toBe(401);

    const invalidFormat = await worker.fetch(new Request(
      'https://proxy.test/elevenlabs/dialogue?output_format=../../bad',
      { method: 'POST', headers: { 'xi-api-key': API_KEY }, body: '{}' },
    ), {}, { waitUntil: () => {} });
    expect(invalidFormat.status).toBe(400);
    expect(upstream).not.toHaveBeenCalled();
  });
});
