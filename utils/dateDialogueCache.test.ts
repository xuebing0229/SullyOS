import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockedDb = vi.hoisted(() => ({
  getAssetRaw: vi.fn(),
  saveAssetRaw: vi.fn(),
}));

vi.mock('./db', () => ({ DB: mockedDb }));

import {
  dateDialoguePersistentCacheKey,
  getCachedDateDialogue,
  markDateDialogueForcedSingles,
  saveCachedDateDialogue,
} from './dateDialogueCache';

const segments = [
  { lineId: 'live:0', speaker: 'char' as const, startTime: 0.1, endTime: 1.2 },
  { lineId: 'live:1', speaker: 'user' as const, startTime: 1.3, endTime: 2.4 },
];

describe('见面整轮 Dialogue 持久缓存', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedDb.getAssetRaw.mockResolvedValue(null);
    mockedDb.saveAssetRaw.mockResolvedValue(undefined);
  });

  it('同一个批次生成稳定的短磁盘 key', () => {
    const a = dateDialoguePersistentCacheKey('same-batch');
    const b = dateDialoguePersistentCacheKey('same-batch');
    const c = dateDialoguePersistentCacheKey('different-batch');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^date_dialogue_v1_[0-9a-f]{16}$/);
  });

  it('保存整轮音频和时间轴后可跨 DateSession 重新读取', async () => {
    const blob = new Blob(['audio'], { type: 'audio/mpeg' });
    await saveCachedDateDialogue('batch', blob, segments);
    expect(mockedDb.saveAssetRaw).toHaveBeenCalledTimes(1);
    const [key, saved] = mockedDb.saveAssetRaw.mock.calls[0];
    expect(key).toBe(dateDialoguePersistentCacheKey('batch'));
    expect(saved).toMatchObject({ kind: 'audio', blob, segments });

    mockedDb.getAssetRaw.mockResolvedValue(saved);
    const restored = await getCachedDateDialogue('batch');
    expect(restored).toMatchObject({ kind: 'audio', blob, segments });
    // 命中后只更新时间，不重新合成语音。
    expect(mockedDb.saveAssetRaw).toHaveBeenCalledTimes(2);
  });

  it('时间轴失败标记也持久化，重新进入不会再次购买同一轮整轮音频', async () => {
    await markDateDialogueForcedSingles('bad-batch');
    const [, saved] = mockedDb.saveAssetRaw.mock.calls[0];
    expect(saved).toMatchObject({ kind: 'forced-singles' });

    mockedDb.getAssetRaw.mockResolvedValue(saved);
    await expect(getCachedDateDialogue('bad-batch')).resolves.toMatchObject({ kind: 'forced-singles' });
  });

  it('损坏的音频缓存不参与播放', async () => {
    mockedDb.getAssetRaw.mockResolvedValue({
      kind: 'audio',
      blob: new Blob([]),
      segments,
      createdAt: 1,
      lastUsedAt: 1,
    });
    await expect(getCachedDateDialogue('broken')).resolves.toBeNull();
  });
});
