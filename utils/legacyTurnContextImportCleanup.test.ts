import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DB } from './db';

describe('backup import cleans legacy aiTurnContext snapshots', () => {
  beforeEach(async () => {
    await DB.clearMessages('legacy-clean-char').catch(() => {});
  });

  it('removes only aiTurnContext after import and preserves other metadata', async () => {
    const onCleaned = vi.fn();
    await DB.importFullData({
      messages: [{
        id: 910001,
        charId: 'legacy-clean-char',
        role: 'user',
        type: 'text',
        content: '正文保留',
        timestamp: Date.now(),
        metadata: {
          aiTurnContext: '应被清除的旧快照',
          customFlag: '必须保留',
        },
      }],
    } as any, { onLegacyTurnContextCleaned: onCleaned });

    const restored = (await DB.getMessagesByCharId('legacy-clean-char', true))[0] as any;
    expect(restored.content).toBe('正文保留');
    expect(restored.metadata?.aiTurnContext).toBeUndefined();
    expect(restored.metadata?.customFlag).toBe('必须保留');
    expect(onCleaned).toHaveBeenCalledWith(1);
  });

  it('is idempotent when imported messages contain no legacy snapshot', async () => {
    const onCleaned = vi.fn();
    await DB.importFullData({
      messages: [{
        id: 910002,
        charId: 'legacy-clean-char',
        role: 'assistant',
        type: 'text',
        content: '普通消息',
        timestamp: Date.now(),
        metadata: { customFlag: 'ok' },
      }],
    } as any, { onLegacyTurnContextCleaned: onCleaned });

    expect(onCleaned).toHaveBeenCalledWith(0);
    const cleanedAgain = await DB.cleanupLegacyTurnContextSnapshots();
    expect(cleanedAgain).toBe(0);
  });
});
