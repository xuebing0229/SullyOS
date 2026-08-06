import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
    APIConfig,
    CharacterProfile,
    DailySchedule,
    UserProfile,
} from '../types';

const mocks = vi.hoisted(() => ({
    resolveApiExecutionPlan: vi.fn(),
    executeOpenAiChatPlan: vi.fn(),
    buildCoreContext: vi.fn(),
    getScheduleCoverImage: vi.fn(),
    getEmojis: vi.fn(),
    saveDailySchedule: vi.fn(),
    getDailyScheduleForChar: vi.fn(),
    loadCharacterContextRange: vi.fn(),
    injectMemoryPalace: vi.fn(),
}));

vi.mock('./apiFailover', () => ({
    resolveApiExecutionPlan: mocks.resolveApiExecutionPlan,
    executeOpenAiChatPlan: mocks.executeOpenAiChatPlan,
}));
vi.mock('./context', () => ({
    ContextBuilder: { buildCoreContext: mocks.buildCoreContext },
}));
vi.mock('./db', () => ({
    DB: {
        getScheduleCoverImage: mocks.getScheduleCoverImage,
        getEmojis: mocks.getEmojis,
        saveDailySchedule: mocks.saveDailySchedule,
    },
}));
vi.mock('./dailySchedule', () => ({
    getDailyScheduleForChar: mocks.getDailyScheduleForChar,
}));
vi.mock('./chatContextRange', () => ({
    loadCharacterContextRange: mocks.loadCharacterContextRange,
}));
vi.mock('./memoryPalace/pipeline', () => ({
    injectMemoryPalace: mocks.injectMemoryPalace,
}));

import {
    evolveFlowNarrative,
    generateDailyScheduleForChar,
} from './scheduleGenerator';

const apiConfig: APIConfig = {
    baseUrl: 'https://main.example/v1',
    apiKey: 'test-key',
    model: 'claude-opus-4-6',
    stream: false,
    temperature: 0.85,
};
const char = {
    id: 'char-1',
    name: '测试角色',
    scheduleFeatureEnabled: true,
    scheduleStyle: 'lifestyle',
    contextLimit: 20,
} as CharacterProfile;
const user = { name: '测试用户' } as UserProfile;
const route = {
    presetId: 'preset-a',
    presetName: '线路 A',
    api: apiConfig,
    routeIndex: 0,
};
const plan = {
    mode: 'failover',
    scope: 'chat',
    primaryApi: apiConfig,
    routes: [route],
    cacheIdentity: 'test-plan',
};

beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveApiExecutionPlan.mockReturnValue(plan);
    mocks.buildCoreContext.mockResolvedValue('core context');
    mocks.getScheduleCoverImage.mockResolvedValue(undefined);
    mocks.getEmojis.mockResolvedValue([]);
    mocks.getDailyScheduleForChar.mockResolvedValue(null);
    mocks.loadCharacterContextRange.mockResolvedValue({ messages: [] });
    mocks.injectMemoryPalace.mockResolvedValue(undefined);
    mocks.saveDailySchedule.mockResolvedValue(undefined);
    mocks.executeOpenAiChatPlan.mockResolvedValue({
        value: {
            choices: [{
                message: {
                    content: JSON.stringify({
                        slots: [{
                            startTime: '08:00',
                            activity: '起床',
                            description: '开始新的一天',
                            emoji: '🌤️',
                        }],
                        flowNarrative: {
                            morning: '早上的意识流内容足够长。',
                        },
                    }),
                },
            }],
        },
        route,
        attempts: [],
        requestId: 'request-1',
    });
});

describe('scheduleGenerator failover routing', () => {
    it('生成日程时复用主聊天 chat 故障转移组', async () => {
        const result = await generateDailyScheduleForChar(
            char, user, apiConfig, true,
        );

        expect(result?.slots[0]?.activity).toBe('起床');
        expect(mocks.resolveApiExecutionPlan)
            .toHaveBeenCalledWith('chat', apiConfig, true);
        expect(mocks.executeOpenAiChatPlan).toHaveBeenCalledWith(
            expect.objectContaining({
                plan,
                directMaxRetries: 2,
                meta: expect.objectContaining({
                    appName: '日程系统',
                    charId: char.id,
                    charName: char.name,
                    purpose: '生成当日日程',
                }),
                body: expect.objectContaining({
                    model: apiConfig.model,
                    stream: false,
                    max_tokens: 8000,
                }),
            }),
        );
        expect(mocks.saveDailySchedule).toHaveBeenCalledTimes(1);
    });

    it('进化意识流时也复用主聊天 chat 故障转移组', async () => {
        mocks.executeOpenAiChatPlan.mockResolvedValueOnce({
            value: {
                choices: [{
                    message: {
                        content: '刚才的对话让我慢慢放松下来，手头的事情还悬着，但此刻更想把这份安静留久一点。',
                    },
                }],
            },
            route,
            attempts: [],
            requestId: 'request-2',
        });
        const schedule = {
            id: 'char-1_2026-08-06',
            charId: char.id,
            date: '2026-08-06',
            slots: [{ startTime: '08:00', activity: '整理房间' }],
            generatedAt: Date.now(),
        } as DailySchedule;

        const result = await evolveFlowNarrative(
            char, user, schedule, [], '原来的意识流内容。', apiConfig,
        );

        expect(result).toContain('慢慢放松');
        expect(mocks.resolveApiExecutionPlan)
            .toHaveBeenCalledWith('chat', apiConfig, true);
        expect(mocks.executeOpenAiChatPlan).toHaveBeenCalledWith(
            expect.objectContaining({
                plan,
                directMaxRetries: 2,
                meta: expect.objectContaining({
                    appName: '日程系统',
                    purpose: '进化意识流',
                }),
                body: expect.objectContaining({
                    model: apiConfig.model,
                    stream: false,
                    max_tokens: 500,
                }),
            }),
        );
    });
});
