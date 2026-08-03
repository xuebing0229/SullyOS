import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./db', () => ({
    DB: {
        getMessagesByCharId: vi.fn(),
        deleteMessages: vi.fn(),
    },
}));

import { DB } from './db';
import {
    cleanupLegacyMcpImageStatusMessages,
    isLegacyMcpImageStatusMessage,
} from './mcpImageStatusCleanup';

const mockedDB = vi.mocked(DB);

describe('mcpImageStatusCleanup', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('只识别 assistant text 的旧版生图状态占位消息', () => {
        expect(isLegacyMcpImageStatusMessage({
            role: 'assistant',
            type: 'text',
            content: '图片已经开始在后台生成，完成后会自动出现在聊天和相册里。',
        } as any)).toBe(true);

        expect(isLegacyMcpImageStatusMessage({
            role: 'user',
            type: 'text',
            content: '图片已经开始在后台生成，完成后会自动出现在聊天和相册里。',
        } as any)).toBe(false);

        expect(isLegacyMcpImageStatusMessage({
            role: 'assistant',
            type: 'image',
            content: '图片已经开始在后台生成，完成后会自动出现在聊天和相册里。',
        } as any)).toBe(false);
    });

    it('仅删除精确命中的旧占位消息', async () => {
        mockedDB.getMessagesByCharId.mockResolvedValue([
            {
                id: 1,
                charId: 'char-1',
                role: 'assistant',
                type: 'text',
                content: '图片已经开始在后台生成，完成后会自动出现在聊天和相册里。',
                timestamp: 1,
            },
            {
                id: 2,
                charId: 'char-1',
                role: 'assistant',
                type: 'text',
                content: '我给你画好了。',
                timestamp: 2,
            },
        ] as any);
        mockedDB.deleteMessages.mockResolvedValue(undefined);

        await expect(cleanupLegacyMcpImageStatusMessages('char-1')).resolves.toBe(1);
        expect(mockedDB.getMessagesByCharId).toHaveBeenCalledWith('char-1', true);
        expect(mockedDB.deleteMessages).toHaveBeenCalledWith([1]);
    });
});
