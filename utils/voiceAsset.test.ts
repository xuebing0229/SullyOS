import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { APIConfig, CharacterProfile } from '../types';

const mocks = vi.hoisted(() => ({
  getAssetRaw: vi.fn(),
  saveAssetRaw: vi.fn(),
  deleteAsset: vi.fn(),
  synthesizeSpeechDetailed: vi.fn(),
}));

vi.mock('./db', () => ({
  DB: {
    getAssetRaw: mocks.getAssetRaw,
    saveAssetRaw: mocks.saveAssetRaw,
    deleteAsset: mocks.deleteAsset,
  },
}));

vi.mock('./ttsRouter', () => ({
  synthesizeSpeechDetailed: mocks.synthesizeSpeechDetailed,
}));

import {
  ensureVoiceAsset,
  storyVoiceAssetKey,
} from './voiceAsset';

const char = { id: 'char-1', name: '云' } as CharacterProfile;
const apiConfig = { model: 'test' } as APIConfig;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('shared persistent voice assets', () => {
  it('builds story keys from story, message and dialogue identity instead of text', () => {
    expect(storyVoiceAssetKey('story-a', 42, 3)).toBe('voice_story_story-a_42_3');
  });

  it('replays a matching persisted asset without calling TTS again', async () => {
    const blob = new Blob(['cached'], { type: 'audio/mpeg' });
    mocks.getAssetRaw.mockResolvedValue({ blob, originalText: '“好。”' });

    const result = await ensureVoiceAsset({
      key: 'voice_story_s_1_0',
      text: '“好。”',
      char,
      apiConfig,
    });

    expect(result.generated).toBe(false);
    expect(result.blob).toBe(blob);
    expect(mocks.synthesizeSpeechDetailed).not.toHaveBeenCalled();
    expect(mocks.saveAssetRaw).not.toHaveBeenCalled();
    URL.revokeObjectURL(result.url);
  });

  it('treats edited dialogue text as invalid and replaces the binding after synthesis', async () => {
    mocks.getAssetRaw.mockResolvedValue({
      blob: new Blob(['old'], { type: 'audio/mpeg' }),
      originalText: '“旧台词。”',
    });
    const freshBlob = new Blob(['new'], { type: 'audio/mpeg' });
    mocks.synthesizeSpeechDetailed.mockResolvedValue({ url: 'blob:fresh', blob: freshBlob });
    mocks.saveAssetRaw.mockResolvedValue(undefined);

    const result = await ensureVoiceAsset({
      key: 'voice_story_s_2_0',
      text: '“新台词。”',
      char,
      apiConfig,
    });

    expect(result.generated).toBe(true);
    expect(mocks.synthesizeSpeechDetailed).toHaveBeenCalledTimes(1);
    expect(mocks.saveAssetRaw).toHaveBeenCalledWith(
      'voice_story_s_2_0',
      expect.objectContaining({ blob: freshBlob, originalText: '“新台词。”' }),
    );
    expect(mocks.deleteAsset).not.toHaveBeenCalled();
  });

  it('does not destroy the old asset when an explicit refresh fails', async () => {
    mocks.getAssetRaw.mockResolvedValue({
      blob: new Blob(['old'], { type: 'audio/mpeg' }),
      originalText: '“别动。”',
    });
    mocks.synthesizeSpeechDetailed.mockRejectedValue(new Error('provider down'));

    await expect(ensureVoiceAsset({
      key: 'voice_story_s_3_0',
      text: '“别动。”',
      char,
      apiConfig,
      force: true,
    })).rejects.toThrow('provider down');

    expect(mocks.saveAssetRaw).not.toHaveBeenCalled();
    expect(mocks.deleteAsset).not.toHaveBeenCalled();
  });

  it('deduplicates concurrent synthesis for the same concrete segment', async () => {
    mocks.getAssetRaw.mockResolvedValue(null);
    let release!: (value: { url: string; blob: Blob }) => void;
    const pending = new Promise<{ url: string; blob: Blob }>(resolve => { release = resolve; });
    mocks.synthesizeSpeechDetailed.mockReturnValue(pending);
    mocks.saveAssetRaw.mockResolvedValue(undefined);

    const options = {
      key: 'voice_story_s_4_1',
      text: '“同一句。”',
      char,
      apiConfig,
    };
    const first = ensureVoiceAsset(options);
    const second = ensureVoiceAsset(options);

    await Promise.resolve();
    await Promise.resolve();
    expect(mocks.synthesizeSpeechDetailed).toHaveBeenCalledTimes(1);

    release({ url: 'blob:one', blob: new Blob(['one'], { type: 'audio/mpeg' }) });
    const [a, b] = await Promise.all([first, second]);
    expect(a.url).toBe('blob:one');
    expect(b.url).toBe('blob:one');
    expect(mocks.saveAssetRaw).toHaveBeenCalledTimes(1);
  });
});
