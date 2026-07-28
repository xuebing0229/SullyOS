import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
    buildSystemPromptParts,
    buildMessageHistory,
    injectMemoryPalace,
    isMcpChatAvailable,
} = vi.hoisted(() => ({
    buildSystemPromptParts: vi.fn(),
    buildMessageHistory: vi.fn(),
    injectMemoryPalace: vi.fn(),
    isMcpChatAvailable: vi.fn(),
}));

vi.mock('./chatPrompts', () => ({
    ChatPrompts: {
        buildSystemPromptParts,
        buildMessageHistory,
    },
}));

vi.mock('./memoryPalace/pipeline', () => ({
    injectMemoryPalace,
}));

vi.mock('./mcpClient', () => ({
    isMcpChatAvailable,
}));

vi.mock('./devDebug', () => ({
    isPromptBuildSkipped: () => false,
    isSystemMessageMergeEnabled: () => false,
}));

import { buildChatRequestPayload } from './chatRequestPayload';

const makeBaseInput = (overrides: Record<string, unknown> = {}) => ({
    char: {
        id: 'c1',
        name: '阿云',
        mountedWorldbooks: [],
    } as any,
    userProfile: { name: '小竹' } as any,
    groups: [],
    emojis: [],
    categories: [],
    historyMsgs: [
        {
            id: 1,
            charId: 'c1',
            role: 'user',
            type: 'text',
            content: '普通历史',
            timestamp: Date.now(),
        },
    ] as any[],
    contextLimit: 20,
    allowMcpChat: false,
    ...overrides,
});

describe('buildChatRequestPayload gallery extensions', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        buildSystemPromptParts.mockResolvedValue({
            stable: 'BASE',
            volatileState: 'STATE',
            recencyTail: 'TAIL',
        });
        buildMessageHistory.mockImplementation((history: any[]) => ({
            apiMessages: history.map(message => ({
                role: message.role,
                content: message.content,
            })),
        }));
        injectMemoryPalace.mockResolvedValue(undefined);
        isMcpChatAvailable.mockReturnValue(true);
    });

    it('appends ephemeral messages without adding them to normal callers', async () => {
        const normal = await buildChatRequestPayload(makeBaseInput() as any);
        const withGallery = await buildChatRequestPayload(makeBaseInput({
            ephemeralMessages: [
                { role: 'system', content: '历史快照：游乐园' },
                {
                    role: 'user',
                    content: [
                        { type: 'text', text: '看看这张图' },
                        {
                            type: 'image_url',
                            image_url: { url: 'data:image/png;base64,AAAA' },
                        },
                    ],
                },
            ],
        }) as any);

        expect(JSON.stringify(withGallery.fullMessages)).toContain('历史快照：游乐园');
        expect(JSON.stringify(withGallery.fullMessages)).toContain('data:image/png;base64,AAAA');
        expect(JSON.stringify(normal.fullMessages)).not.toContain('历史快照：游乐园');
    });

    it('strips historical images but keeps the reviewed photo', async () => {
        const result = await buildChatRequestPayload(makeBaseInput({
            historyMsgs: [
                {
                    id: 1,
                    charId: 'c1',
                    role: 'user',
                    type: 'image',
                    content: [
                        { type: 'text', text: '[图片]' },
                        {
                            type: 'image_url',
                            image_url: { url: 'data:image/png;base64,HISTORICAL_BASE64' },
                        },
                    ],
                    timestamp: Date.now(),
                },
            ],
            stripImages: true,
            ephemeralMessages: [
                {
                    role: 'user',
                    content: [
                        { type: 'text', text: '点评' },
                        {
                            type: 'image_url',
                            image_url: { url: 'data:image/png;base64,TARGET' },
                        },
                    ],
                },
            ],
        }) as any);

        const json = JSON.stringify(result.fullMessages);
        expect(json).toContain('data:image/png;base64,TARGET');
        expect(json).not.toContain('HISTORICAL_BASE64');
    });

    it('can disable MCP for gallery review', async () => {
        const result = await buildChatRequestPayload(makeBaseInput({
            allowMcpChat: false,
        }) as any);

        expect(isMcpChatAvailable).not.toHaveBeenCalled();
        expect(result.flags.mcpChatActive).toBe(false);
    });

    it('passes independent gallery snapshot messages to normal worldbook matching', async () => {
        const worldbookQueryMessages = [
            {
                id: -1,
                charId: 'c1',
                role: 'system',
                type: 'text',
                content: '历史快照：我们在摩天轮下面拍了照片。',
                timestamp: Date.now(),
            },
        ] as any[];

        await buildChatRequestPayload(makeBaseInput({
            worldbookQueryMessages,
        }) as any);

        const options = buildSystemPromptParts.mock.calls[0].at(-1);
        expect(options.worldbookMessages).toBe(worldbookQueryMessages);
    });
});
