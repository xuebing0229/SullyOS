import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: () => true,
    getPlatform: () => 'android',
  },
}));

import { minimaxFetch } from './minimaxEndpoint';

describe('minimaxFetch native diagnostics', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('does not report successful request diagnostics as errors', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ base_resp: { status_code: 0 } }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )));

    const response = await minimaxFetch('/api/minimax/get-voice', {
      method: 'POST',
      headers: { Authorization: 'Bearer test-key' },
      body: JSON.stringify({ voice_type: 'all' }),
    });

    expect(response.ok).toBe(true);
    expect(error).not.toHaveBeenCalled();
    expect(debug).toHaveBeenCalledWith('[MM-NATIVE-5] HTTP=200');
  });

  it('still reports real transport failures without leaking the API key', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));

    await expect(minimaxFetch('/api/minimax/get-voice', {
      headers: { Authorization: 'Bearer secret-key' },
    })).rejects.toThrow('MiniMax 标准 fetch 请求失败');

    const output = error.mock.calls.flat().join(' ');
    expect(output).toContain('[MM-NATIVE-ERR-1]');
    expect(output).not.toContain('secret-key');
  });
});
