import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

import type { ApiExecutionPlan } from './apiFailover';
import { clearAiCache } from './aiRequestManager';

const mocks = vi.hoisted(() => ({
    executeOpenAiChatPlan: vi.fn(),
    recordApiCall: vi.fn(),
}));

vi.mock('./apiFailover', async () => {
    const actual = await vi.importActual<
        typeof import('./apiFailover')
    >('./apiFailover');

    return {
        ...actual,
        executeOpenAiChatPlan:
            mocks.executeOpenAiChatPlan,
    };
});

vi.mock('./apiCallLog', async () => {
    const actual = await vi.importActual<
        typeof import('./apiCallLog')
    >('./apiCallLog');

    return {
        ...actual,
        recordApiCall: mocks.recordApiCall,
    };
});

import {
    executeCachedChatCompletion,
    executeCachedEmotionCompletion,
} from './aiCompletionPipeline';

const api = {
    baseUrl: 'https://api.example.test/v1',
    apiKey: 'secret-for-test-only',
    model: 'test-model',
    stream: false,
};

const route = {
    presetId: 'preset-primary',
    presetName: '主线路',
    api,
    routeIndex: 0,
};

const chatPlan: ApiExecutionPlan = {
    mode: 'direct',
    scope: 'chat',
    primaryApi: api,
    routes: [route],
    cacheIdentity:
        'direct:https://api.example.test/v1:test-model',
};

const emotionPlan: ApiExecutionPlan = {
    ...chatPlan,
    scope: 'emotion',
    cacheIdentity:
        'emotion:https://api.example.test/v1:test-model',
};

const finalResponse = {
    model: 'test-model',
    choices: [{
        finish_reason: 'stop',
        message: {
            role: 'assistant',
            content: '正常最终回复',
        },
    }],
    usage: {
        prompt_tokens: 10,
        completion_tokens: 4,
        total_tokens: 14,
    },
};

function networkResult(value: any) {
    return {
        value,
        route,
        attempts: [],
        requestId: 'request-test',
    };
}

describe('aiCompletionPipeline', () => {
    beforeEach(async () => {
        mocks.executeOpenAiChatPlan.mockReset();
        mocks.recordApiCall.mockReset();
        await clearAiCache();
    });

    it('缓存普通最终回复，第二次不联网', async () => {
        mocks.executeOpenAiChatPlan.mockResolvedValue(
            networkResult(finalResponse),
        );

        const options = {
            plan: chatPlan,
            body: {
                model: 'test-model',
                messages: [{
                    role: 'user',
                    content: '你好',
                }],
            },
            meta: {
                appName: '消息',
                charId: 'char-1',
                charName: '角色',
                purpose: '聊天回复',
            },
        };

        const first =
            await executeCachedChatCompletion(options);
        const second =
            await executeCachedChatCompletion(options);

        expect(first.networkRequest).toBe(true);
        expect(second.networkRequest).toBe(false);
        expect(second.source).toBe('indexeddb-cache');
        expect(
            mocks.executeOpenAiChatPlan,
        ).toHaveBeenCalledTimes(1);
        expect(mocks.recordApiCall).toHaveBeenCalledWith(
            expect.objectContaining({
                networkRequest: false,
                cacheHit: true,
                source: 'indexeddb-cache',
            }),
        );
    });

    it('原生 tool_calls 响应永不进入持久缓存', async () => {
        const toolResponse = {
            choices: [{
                finish_reason: 'tool_calls',
                message: {
                    role: 'assistant',
                    content: '',
                    tool_calls: [{
                        id: 'tc-1',
                        type: 'function',
                        function: {
                            name: 'generate_image',
                            arguments: '{"prompt":"cat"}',
                        },
                    }],
                },
            }],
        };

        mocks.executeOpenAiChatPlan.mockResolvedValue(
            networkResult(toolResponse),
        );

        const options = {
            plan: chatPlan,
            body: {
                model: 'test-model',
                messages: [{
                    role: 'user',
                    content: '画一只猫',
                }],
                tools: [{
                    type: 'function',
                    function: {
                        name: 'generate_image',
                    },
                }],
            },
            meta: {
                appName: '消息',
                charId: 'char-1',
                purpose: '聊天回复',
            },
            knownTextToolNames: ['generate_image'],
        };

        await executeCachedChatCompletion(options);
        await executeCachedChatCompletion(options);

        expect(
            mocks.executeOpenAiChatPlan,
        ).toHaveBeenCalledTimes(2);
    });

    it('正文兼容工具调用永不进入持久缓存', async () => {
        const textToolResponse = {
            choices: [{
                finish_reason: 'stop',
                message: {
                    role: 'assistant',
                    content:
                        'generate_image({"prompt":"cat"})',
                },
            }],
        };

        mocks.executeOpenAiChatPlan.mockResolvedValue(
            networkResult(textToolResponse),
        );

        const options = {
            plan: chatPlan,
            body: {
                model: 'test-model',
                messages: [{
                    role: 'user',
                    content: '画一只猫',
                }],
            },
            meta: {
                appName: '消息',
                charId: 'char-1',
                purpose: '聊天回复',
            },
            knownTextToolNames: ['generate_image'],
        };

        await executeCachedChatCompletion(options);
        await executeCachedChatCompletion(options);

        expect(
            mocks.executeOpenAiChatPlan,
        ).toHaveBeenCalledTimes(2);
    });

    it('forceRefresh 强制重新生成并覆盖同键缓存', async () => {
        mocks.executeOpenAiChatPlan.mockResolvedValue(
            networkResult(finalResponse),
        );

        const base = {
            plan: chatPlan,
            body: {
                model: 'test-model',
                messages: [{
                    role: 'user',
                    content: '重新生成',
                }],
            },
            meta: {
                appName: '消息',
                charId: 'char-1',
                purpose: '聊天回复',
            },
        };

        await executeCachedChatCompletion(base);
        await executeCachedChatCompletion({
            ...base,
            forceRefresh: true,
        });

        expect(
            mocks.executeOpenAiChatPlan,
        ).toHaveBeenCalledTimes(2);
    });

    it('同一用户/助手回合的情绪评估复用缓存', async () => {
        mocks.executeOpenAiChatPlan.mockResolvedValue(
            networkResult({
                choices: [{
                    message: {
                        role: 'assistant',
                        content:
                            '{"changed":false,"buffs":[]}',
                    },
                }],
            }),
        );

        const options = {
            plan: emotionPlan,
            body: {
                model: 'test-model',
                messages: [{
                    role: 'user',
                    content: '评估当前情绪',
                }],
            },
            meta: {
                appName: '消息',
                charId: 'char-1',
                purpose: '情绪评估',
            },
            round: {
                conversationId: 'char-1',
                userMessageId: 'u-1',
                assistantMessageId: 'a-1',
            },
        };

        const first =
            await executeCachedEmotionCompletion(options);
        const second =
            await executeCachedEmotionCompletion(options);

        expect(first.networkRequest).toBe(true);
        expect(second.networkRequest).toBe(false);
        expect(
            mocks.executeOpenAiChatPlan,
        ).toHaveBeenCalledTimes(1);
    });

    it('不同助手回复不能共用旧情绪结果', async () => {
        mocks.executeOpenAiChatPlan.mockResolvedValue(
            networkResult({
                choices: [{
                    message: {
                        role: 'assistant',
                        content:
                            '{"changed":true,"buffs":[]}',
                    },
                }],
            }),
        );

        const base = {
            plan: emotionPlan,
            body: {
                model: 'test-model',
                messages: [{
                    role: 'user',
                    content: '评估当前情绪',
                }],
            },
            meta: {
                appName: '消息',
                charId: 'char-1',
                purpose: '情绪评估',
            },
            round: {
                conversationId: 'char-1',
                userMessageId: 'u-1',
                assistantMessageId: 'a-1',
            },
        };

        await executeCachedEmotionCompletion(base);
        await executeCachedEmotionCompletion({
            ...base,
            round: {
                ...base.round,
                assistantMessageId: 'a-2',
            },
        });

        expect(
            mocks.executeOpenAiChatPlan,
        ).toHaveBeenCalledTimes(2);
    });
});
