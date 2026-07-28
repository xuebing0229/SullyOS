import type {
    APIConfig,
    CharacterProfile,
    GalleryImage,
    GroupProfile,
    Message,
    RealtimeConfig,
    UserProfile,
} from '../types';

import type {
    MusicPlaybackSnapshot,
} from '../context/MusicContext';

import {
    ChatPrompts,
} from './chatPrompts';

import {
    buildChatRequestPayload,
    type ChatPayloadMessage,
} from './chatRequestPayload';

import {
    loadCharacterContextRange,
} from './chatContextRange';

import {
    DB,
} from './db';

import {
    resolveRefToDataUrl,
} from './blobRef';

import {
    runAiRequest,
} from './aiRequestManager';

import {
    safeFetchJson,
} from './safeApi';

import {
    recordApiCall,
} from './apiCallLog';

import {
    buildRegeneratedReviewInstruction,
} from './galleryReview';

export interface GenerateGalleryReviewInput {
    image: GalleryImage;
    char: CharacterProfile;
    userProfile: UserProfile;
    groups: GroupProfile[];
    apiConfig: APIConfig;
    realtimeConfig?: RealtimeConfig;
    musicSnapshot?: MusicPlaybackSnapshot | null;

    /**
     * 重新点评时为 true：
     * - 绕过 IndexedDB 响应缓存；
     * - 仍保留同请求的 in-flight 防重逻辑。
     */
    forceRefresh?: boolean;

    /**
     * 正常聊天的上下文断点若已越过最大范围，
     * 由 Gallery 调用 OSContext.updateCharacter 清理。
     */
    onContextBreakpointExpired?:
        () => void;
}

export interface GenerateGalleryReviewResult {
    text: string;
    source:
        | 'network'
        | 'memory-dedupe'
        | 'indexeddb-cache';
    networkRequest: boolean;
}

const GALLERY_REVIEW_PROMPT_VERSION =
    'gallery-review-normal-context-v1';

const GALLERY_REVIEW_MAX_TOKENS =
    800;

const SNAPSHOT_MAX_LINES =
    12;

const SNAPSHOT_LINE_MAX_CHARS =
    500;

const SNAPSHOT_TOTAL_MAX_CHARS =
    4_000;

const replaceLegacySpeaker = (
    line: string,
    userName: string,
    charName: string,
): string =>
    line
        .replace(
            /^用户\s*[：:]\s*/,
            `${userName}：`,
        )
        .replace(
            /^角色\s*[：:]\s*/,
            `${charName}：`,
        );

const clampText = (
    value: string,
    max: number,
): string => {
    const normalized =
        value
            .replace(
                /\u0000/g,
                '',
            )
            .trim();

    if (
        normalized.length
        <= max
    ) {
        return normalized;
    }

    return (
        normalized.slice(
            0,
            max,
        )
        + '…'
    );
};

export function buildGallerySnapshotBlock(
    image: GalleryImage,
    char: CharacterProfile,
    userProfile: UserProfile,
): string | null {
    const source =
        Array.isArray(
            image.chatContext,
        )
            ? image.chatContext
            : [];

    const lines =
        source
            .slice(
                -SNAPSHOT_MAX_LINES,
            )
            .map(value =>
                replaceLegacySpeaker(
                    clampText(
                        String(
                            value
                            ?? '',
                        ),
                        SNAPSHOT_LINE_MAX_CHARS,
                    ),
                    userProfile.name
                    || '用户',
                    char.name,
                ),
            )
            .filter(Boolean);

    if (
        lines.length === 0
    ) {
        return null;
    }

    const dateLabel =
        image.savedDate
        || (
            Number.isFinite(
                image.timestamp,
            )
                ? new Date(
                    image.timestamp,
                )
                    .toLocaleDateString(
                        'zh-CN',
                    )
                : '未知日期'
        );

    const body =
        clampText(
            lines.join('\n'),
            SNAPSHOT_TOTAL_MAX_CHARS,
        );

    return `## 这张照片保存时的历史聊天快照

[照片保存时间：${dateLabel}]

以下内容是这张照片保存时固化下来的过去聊天背景。
它只用于帮助你理解照片当时发生了什么、双方当时在聊什么。

重要：
- 这是过去的历史材料，不是当前正在发生的对话；
- 当前事实、当前关系和当前状态，以现在的聊天上下文为准；
- 不要把这段快照误认成用户刚刚重复说了一遍；
- 只有自然相关时才提起快照里的内容，不要机械复述。

${body}`;
}

function imagePromptSummary(
    image: GalleryImage,
): string {
    const meta = image.sourceMeta as
        | Record<string, unknown>
        | undefined;

    const value =
        meta?.promptSummary
        ?? meta?.prompt
        ?? meta?.imagePrompt;

    return typeof value
        === 'string'
        ? clampText(
            value,
            1_200,
        )
        : '';
}

export function buildGalleryRecallHint(
    image: GalleryImage,
    snapshotBlock:
        string
        | null,
): string {
    const pieces = [
        '当前任务：角色正在相册里重新查看并点评一张旧照片。',
        image.savedDate
            ? `照片保存日期：${image.savedDate}`
            : '',
        imagePromptSummary(image)
            ? (
                '照片生成或内容摘要：'
                + imagePromptSummary(
                    image,
                )
            )
            : '',
        snapshotBlock
            ? (
                '照片历史背景：\n'
                + snapshotBlock
            )
            : '',
    ].filter(Boolean);

    return clampText(
        pieces.join('\n\n'),
        3_500,
    );
}

function makeWorldbookSnapshotMessage(
    image: GalleryImage,
    char: CharacterProfile,
    snapshotBlock:
        string
        | null,
): Message | null {
    if (!snapshotBlock) {
        return null;
    }

    return {
        /*
         * 只用于内存中的世界书关键词匹配，
         * 不写 DB，所以负 ID 安全。
         */
        id: -1,
        charId:
            char.id,
        role: 'system',
        type: 'text',
        content:
            snapshotBlock,
        timestamp:
            image.timestamp
            || Date.now(),
    } as Message;
}

function buildReviewUserText(
    image: GalleryImage,
): string {
    const dateText =
        image.savedDate
            ? (
                `这是相册里 ${image.savedDate} 保存的照片。`
            )
            : '这是相册里以前保存的一张照片。';

    return `${dateText}

我现在重新把这张照片拿给你看。请结合：
- 你现在完整的人设和状态；
- 你现在记得的事情；
- 我们现在的聊天关系与最近对话；
- 上面单独标注的照片历史快照；

像正常聊天里看到这张照片一样，自然地回应我。

不要把历史快照说成刚刚发生的事。`;
}

const REVIEW_OUTPUT_CONTRACT = `## 本次相册点评的输出规则

这是相册详情页中的一次照片点评，不是普通聊天气泡回合。

请遵守：
- 只输出角色本人对这张照片的自然回应；
- 通常 1–3 句，确有必要时可以稍长，但不要写成长文；
- 可以自然联系现在的关系、记忆和照片当时的背景；
- 不要解释你读取了什么上下文；
- 不要复述系统提示；
- 不要输出分析过程或思考过程；
- 不要调用工具；
- 不要生成图片；
- 不要输出 HTML；
- 不要输出 [[SEND_EMOJI:...]]、[[QUOTE:...]] 等控制命令；
- 不要输出 <语音>、<thinking> 等控制标签；
- 只返回最终点评正文。`;

function replaceImageForCache(
    messages:
        ChatPayloadMessage[],
    image: GalleryImage,
): ChatPayloadMessage[] {
    const stableRef =
        `gallery-image:`
        + `${image.id}:`
        + `${image.timestamp}`;

    return messages.map(
        message => {
            if (
                !Array.isArray(
                    message.content,
                )
            ) {
                return message;
            }

            return {
                ...message,
                content:
                    message.content.map(
                        (part: any) => {
                            if (
                                part?.type
                                !== 'image_url'
                            ) {
                                return part;
                            }

                            return {
                                ...part,
                                image_url: {
                                    ...(
                                        part
                                            .image_url
                                        ?? {}
                                    ),
                                    /*
                                     * 缓存键不哈希整段 Base64。
                                     * 图片 ID 在本机唯一，timestamp 防旧对象复用。
                                     */
                                    url:
                                        stableRef,
                                },
                            };
                        },
                    ),
            };
        },
    );
}

function extractReviewText(
    data: any,
): string {
    const choice =
        data?.choices?.[0];

    if (
        choice?.finish_reason
        === 'content_filter'
    ) {
        throw new Error(
            'AI 拒绝回复，图片可能包含敏感内容',
        );
    }

    const content =
        choice?.message?.content;

    let text = '';

    if (
        typeof content
        === 'string'
    ) {
        text = content;
    } else if (
        Array.isArray(content)
    ) {
        text =
            content
                .map(
                    (part: any) =>
                        typeof part
                            === 'string'
                            ? part
                            : (
                                part?.type
                                === 'text'
                                ? part.text
                                : ''
                            ),
                )
                .filter(Boolean)
                .join('\n');
    }

    if (!text) {
        text =
            choice
                ?.message
                ?.reasoning_content
            || choice?.text
            || choice
                ?.delta
                ?.content
            || '';
    }

    const normalized =
        String(text)
            .trim();

    if (!normalized) {
        throw new Error(
            'AI 返回内容为空',
        );
    }

    return clampText(
        normalized,
        4_000,
    );
}

export async function generateGalleryReview(
    input:
        GenerateGalleryReviewInput,
): Promise<
    GenerateGalleryReviewResult
> {
    const {
        image,
        char,
        userProfile,
        groups,
        apiConfig,
        realtimeConfig,
        musicSnapshot,
    } = input;

    if (
        !apiConfig.baseUrl
        || !apiConfig.model
    ) {
        throw new Error(
            '请先配置聊天 API 地址和模型',
        );
    }

    if (!apiConfig.apiKey) {
        throw new Error(
            '请先配置聊天 API Key',
        );
    }

    const imageDataUrl =
        await resolveRefToDataUrl(
            image.url,
        );

    if (!imageDataUrl) {
        throw new Error(
            '本机图片数据已丢失',
        );
    }

    /*
     * 和正常聊天使用同一套最大上下文范围：
     * adaptive/manual、HWM、用户断点全部一致。
     */
    const contextRange =
        await loadCharacterContextRange(
            char,
        );

    if (
        contextRange
            .userBreakpointExpired
    ) {
        input
            .onContextBreakpointExpired
            ?.();
    }

    const historyMsgs =
        contextRange.messages;

    /*
     * 正常聊天的 recentMsgsHint 来自 React 近窗，
     * Gallery 没有那份组件 state，取当前范围末尾 200 条等价近似。
     */
    const recentMsgsHint =
        historyMsgs.slice(-200);

    await DB.initializeEmojiData();

    const [
        allEmojis,
        allCategories,
    ] = await Promise.all([
        DB.getEmojis(),
        DB.getEmojiCategories(),
    ]);

    const visible =
        ChatPrompts
            .filterVisibleEmojis(
                allEmojis,
                allCategories,
                char.id,
            );

    const snapshotBlock =
        buildGallerySnapshotBlock(
            image,
            char,
            userProfile,
        );

    const worldbookSnapshot =
        makeWorldbookSnapshotMessage(
            image,
            char,
            snapshotBlock,
        );

    const worldbookQueryMessages =
        worldbookSnapshot
            ? [
                ...recentMsgsHint,
                worldbookSnapshot,
            ]
            : recentMsgsHint;

    const ephemeralMessages:
    ChatPayloadMessage[] = [];

    if (snapshotBlock) {
        ephemeralMessages.push({
            role: 'system',
            content:
                snapshotBlock,
        });
    }

    ephemeralMessages.push({
        role: 'user',
        content: [
            {
                type: 'text',
                text:
                    buildReviewUserText(
                        image,
                    ),
            },
            {
                type: 'image_url',
                image_url: {
                    url:
                        imageDataUrl,
                    detail: 'auto',
                },
            },
        ],
    });

    const payload =
        await buildChatRequestPayload({
            char,
            userProfile,
            groups,
            emojis:
                visible.emojis,
            categories:
                visible.categories,

            historyMsgs,
            recentMsgsHint,
            contextLimit:
                Math.max(
                    1,
                    historyMsgs.length,
                ),

            realtimeConfig,

            /*
             * Gallery 不持有 useChatAI 内部只活一轮的 evolvedNarrative。
             * 持久化的 activeBuffs / buffInjection 仍会由正常 system builder 注入。
             * 不要在这里伪造或复活过期 innerState。
             */
            innerState:
                undefined,

            musicSnapshot:
                musicSnapshot
                ?? undefined,

            /*
             * 相册点评复用语义上下文，
             * 不开启聊天输出/工具模式。
             */
            translationConfig:
                undefined,

            htmlMode: {
                enabled: false,
            },

            thinkingChain: {
                enabled: false,
            },

            stripImages: true,
            allowMcpChat: false,

            recallQueryHint:
                buildGalleryRecallHint(
                    image,
                    snapshotBlock,
                ),

            worldbookQueryMessages,
            ephemeralMessages,
        });

    const requestMessages:
    ChatPayloadMessage[] = [
        ...payload.fullMessages,
        {
            role: 'system',
            content:
                REVIEW_OUTPUT_CONTRACT
                + buildRegeneratedReviewInstruction(
                    image.review,
                ),
        },
    ];

    const baseUrl =
        apiConfig.baseUrl
            .replace(
                /\/+$/,
                '',
            );

    const requestBody: any = {
        model:
            apiConfig.model,
        messages:
            requestMessages,
        temperature:
            apiConfig.temperature
            ?? 0.7,
        max_tokens:
            GALLERY_REVIEW_MAX_TOKENS,
        stream: false,
    };

    const cacheBody = {
        ...requestBody,
        messages:
            replaceImageForCache(
                requestMessages,
                image,
            ),
    };

    const purpose =
        image.review
            ? '相册重新点评'
            : '相册点评';

    const startedAt =
        performance.now();

    const managed =
        await runAiRequest({
            /*
             * 仍属于 chat completion。
             * 用独立 promptVersion 防止和普通聊天缓存碰撞。
             */
            kind: 'chat',

            request: {
                provider:
                    baseUrl,
                body:
                    cacheBody,
                imageId:
                    image.id,
                imageTimestamp:
                    image.timestamp,
                promptVersion:
                    GALLERY_REVIEW_PROMPT_VERSION,
            },

            provider:
                baseUrl,

            model:
                apiConfig.model,

            promptVersion:
                GALLERY_REVIEW_PROMPT_VERSION,

            forceRefresh:
                input.forceRefresh
                ?? Boolean(
                    image.review,
                ),

            metadata: {
                charId:
                    char.id,
                imageId:
                    image.id,
                purpose,
            },

            shouldCache:
                (response: any) =>
                    Boolean(
                        response
                            ?.choices
                            ?.[0]
                            ?.message,
                    ),

            execute: () =>
                safeFetchJson(
                    `${baseUrl}/chat/completions`,
                    {
                        method: 'POST',
                        headers: {
                            'Content-Type':
                                'application/json',
                            Authorization:
                                `Bearer ${apiConfig.apiKey}`,
                        },
                        body:
                            JSON.stringify(
                                requestBody,
                            ),
                    },
                    2,
                    180_000,
                    {
                        appId:
                            'gallery',
                        appName:
                            '相册',
                        charId:
                            char.id,
                        charName:
                            char.name,
                        purpose,
                    },
                ),
        });

    /*
     * 真实网络调用由全局 fetch 拦截器记录。
     * 本地缓存 / 并发复用没有 fetch，需要手动写同一本调用账。
     */
    if (!managed.networkRequest) {
        recordApiCall({
            url:
                `${baseUrl}/chat/completions`,
            body:
                requestBody,
            ok: true,
            response:
                managed.value,
            durationMs:
                Math.round(
                    performance.now()
                    - startedAt,
                ),
            source:
                managed.source,
            cacheHit: true,
            networkRequest: false,
            requestHash:
                managed.key,
            requestChars:
                JSON.stringify(
                    cacheBody,
                ).length,
            meta: {
                appId:
                    'gallery',
                appName:
                    '相册',
                charId:
                    char.id,
                charName:
                    char.name,
                purpose,
            },
        });
    }

    return {
        text:
            extractReviewText(
                managed.value,
            ),
        source:
            managed.source,
        networkRequest:
            managed.networkRequest,
    };
}
