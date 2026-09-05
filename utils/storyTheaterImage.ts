import type { APIConfig, ApiPreset, CharacterProfile, Message, StoryTheaterEntry, StoryTheaterImageFrame, UserProfile } from '../types';
import { resolveApiExecutionPlan, executeOpenAiChatPlan } from './apiFailover';
import { storyTheaterThreadId } from './storyTheater';
import { callMcpTool, getMcpUseNativeTools } from './mcpClient';
import { adoptBackgroundImageJob, callMcpToolWithBackgroundImage } from './backgroundImageJobs';
import {
    buildMcpOpenAITools,
    buildMcpRejectedToolsFallbackBody,
    extractTextFakedMcpCalls,
    shouldRetryMcpWithoutTools,
    type OpenAIMcpTool,
    type ResolvedMcpTool,
} from './mcpToolBridge';
import { normalizeToolCallsForCompat } from './toolCallCompat';
import { prepareBuiltinImageToolArguments } from './novelAiReference';
import {
    applyImageGenerationPresetById,
    getImageGenerationPresets,
    isCharacterReferenceAllowedForActivePreset,
} from './imageGenerationPresets';
import { persistMcpGeneratedImages } from './mcpImagePersistence';

export interface StoryInlineImagePlan {
    tool: string;
    arguments: Record<string, any>;
}

interface GenerateStoryImageInput {
    /** 当前主 API；只作为旧数据/未单独选择规划器时的兜底。 */
    apiConfig: APIConfig;
    /** 已按本剧情“快速规划模型”解析好的独立规划 API。 */
    plannerApiConfig?: APIConfig;
    entry: StoryTheaterEntry;
    actors: CharacterProfile[];
    userProfile: UserProfile;
    userName: string;
    messages: Message[];
    /**
     * 主剧情模型已经在同一次 completion 尾部给出的生图计划。
     * 存在且工具名仍有效时直接执行，不再额外调用“快速规划模型”。
     */
    inlinePlan?: StoryInlineImagePlan;
    /** 要把本次配图挂回的剧情正文楼层。存在时优先走可恢复后台 /jobs。 */
    targetMessageId?: number;
}

export interface StoryTheaterImageGenerationResult {
    frame?: StoryTheaterImageFrame;
    queued?: {
        localJobId: string;
        clientRequestId: string;
    };
}

const compact = (value?: string): string => (value || '').replace(/\s+/g, ' ').trim();
const INLINE_PLAN_OPEN = '<story_image_plan>';
const INLINE_PLAN_CLOSE = '</story_image_plan>';

export const resolveStoryImagePlannerApiConfig = (
    entry: StoryTheaterEntry,
    fallbackApi: APIConfig,
    presets: ApiPreset[],
): APIConfig => {
    const presetId = String(entry.imageGeneration?.plannerApiPresetId || '').trim();
    if (!presetId) return fallbackApi;

    const preset = presets.find(item => item.id === presetId);
    if (!preset) return fallbackApi;

    const configuredModel = String(entry.imageGeneration?.plannerModel || '').trim();
    return {
        ...fallbackApi,
        ...preset.config,
        model: configuredModel || preset.config.model,
        // 规划器只返回一次工具调用，不需要占用流式连接。
        stream: false,
    };
};

const isBuiltinImageTool = (hit: ResolvedMcpTool): boolean =>
    hit.server.builtin === true
    && hit.server.id.startsWith('builtin_image_')
    && (hit.toolName === 'generate_image' || hit.toolName === 'novelai_generate_image');

const withStoryReferenceActorSelector = (
    tool: OpenAIMcpTool,
    hit: ResolvedMcpTool,
    actors: CharacterProfile[],
): OpenAIMcpTool => {
    if (hit.toolName !== 'novelai_generate_image') return tool;
    const candidates = actors.filter(actor => actor.novelAiReference?.enabled);
    if (candidates.length <= 1) return tool;
    const parameters = (() => {
        try { return structuredClone(tool.function.parameters || { type: 'object', properties: {} }); }
        catch { return JSON.parse(JSON.stringify(tool.function.parameters || { type: 'object', properties: {} })); }
    })();
    if (!parameters.properties || typeof parameters.properties !== 'object') parameters.properties = {};
    parameters.properties.story_reference_actor_id = {
        type: 'string',
        enum: candidates.map(actor => actor.id),
        description: `剧情剧场客户端专用，不会发给生图服务。只有本次决定使用角色精密参考图时才需要选择：${candidates.map(actor => `${actor.id}=${actor.name}`).join('；')}。选择画面中最需要锁定外貌的那位；不使用角色参考图时可省略。`,
    };
    return {
        ...tool,
        function: {
            ...tool.function,
            parameters,
        },
    };
};

const resolveStoryImageTools = (
    actors: CharacterProfile[],
): { tools: OpenAIMcpTool[]; resolve: Map<string, ResolvedMcpTool> } => {
    const built = buildMcpOpenAITools(actors[0]?.id, {
        allowCharacterReference: isCharacterReferenceAllowedForActivePreset(),
    });
    const resolve = new Map<string, ResolvedMcpTool>();
    for (const [name, hit] of built.resolve) {
        if (isBuiltinImageTool(hit)) resolve.set(name, hit);
    }
    const tools = built.tools
        .filter(tool => resolve.has(tool.function.name))
        .map(tool => withStoryReferenceActorSelector(tool, resolve.get(tool.function.name)!, actors));
    if (!tools.length) {
        throw new Error('当前主聊天生图策略没有可用的内置生图工具，请先检查生图引擎/预设和工具发现状态。');
    }
    return { tools, resolve };
};

const normalizeInlinePlan = (value: unknown): StoryInlineImagePlan | undefined => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const raw = value as Record<string, unknown>;
    const tool = String(raw.tool || raw.tool_name || '').trim();
    const args = raw.arguments ?? raw.args;
    if (!tool || !args || typeof args !== 'object' || Array.isArray(args)) return undefined;
    return { tool, arguments: args as Record<string, any> };
};

/**
 * 从剧情正文末尾剥离隐藏生图计划。正文永远不把控制块落到楼层里。
 * 若模型只吐出半截控制块，也先把已开始的标签藏掉，避免 UI/记忆被协议污染。
 */
export const parseStoryInlineImagePlan = (
    value: string,
): { content: string; plan?: StoryInlineImagePlan } => {
    const source = String(value || '');
    const openIndex = source.lastIndexOf(INLINE_PLAN_OPEN);
    if (openIndex < 0) return { content: source.trim() };

    const visible = source.slice(0, openIndex).trim();
    const closeIndex = source.indexOf(INLINE_PLAN_CLOSE, openIndex + INLINE_PLAN_OPEN.length);
    if (closeIndex < 0) return { content: visible };

    const rawPlan = source.slice(openIndex + INLINE_PLAN_OPEN.length, closeIndex).trim();
    try {
        const plan = normalizeInlinePlan(JSON.parse(rawPlan));
        return plan ? { content: visible, plan } : { content: visible };
    } catch {
        return { content: visible };
    }
};

/** 流式预览专用：隐藏完整控制块，也吃掉正在逐字出现的标签前缀。 */
export const storyInlineImageVisibleText = (value: string): string => {
    const source = String(value || '');
    const openIndex = source.indexOf(INLINE_PLAN_OPEN);
    if (openIndex >= 0) return source.slice(0, openIndex).trimEnd();

    const maxPrefix = Math.min(source.length, INLINE_PLAN_OPEN.length - 1);
    for (let size = maxPrefix; size > 0; size -= 1) {
        if (source.endsWith(INLINE_PLAN_OPEN.slice(0, size))) {
            return source.slice(0, -size).trimEnd();
        }
    }
    return source;
};

/**
 * 让“写正文的同一次模型调用”顺手给出本轮生图工具与参数。
 * 这里把当前真实可用的工具 schema 原样压进 system 指令，因此仍保留：
 * - 多生图预设由 AI 按用途选择；
 * - 角色/用户/Vibe 参考图开关由 AI 自主判断；
 * - NovelAI 多角色时可明确挑要锁脸的角色。
 */
export const buildStoryInlineImagePlanInstruction = (input: {
    entry: StoryTheaterEntry;
    actors: CharacterProfile[];
    userProfile: UserProfile;
    userName: string;
}): string => {
    const imageTools = resolveStoryImageTools(input.actors);
    const config = input.entry.imageGeneration;
    const actorAnchors = input.actors.map(actor => {
        const referenceState = actor.novelAiReference?.enabled ? '（有角色精密参考图可按需使用）' : '';
        return `${actor.id}=${actor.name}${referenceState}：${compact(config?.characterAnchors?.[actor.id]) || '按角色设定与本轮正文保持一致'}`;
    }).join('\n');
    const toolSchemas = imageTools.tools.map(tool => JSON.stringify({
        name: tool.function.name,
        description: tool.function.description || '',
        parameters: tool.function.parameters || { type: 'object', properties: {} },
    })).join('\n');

    return `【剧情自动配图隐藏协议】\n本轮正常剧情正文全部写完以后，再额外输出且只输出一个隐藏控制块。这个控制块不是给读者看的，不属于正文、幕后、小剧场、选项或任何剧情格式。不要为了配图改变剧情走向，也不要在正文中解释它。\n\n你刚刚写出的这一轮正文就是配图依据。请从其中挑最有表现力、最具体、最值得成为插图的一个瞬间，并从下列真实可用生图工具中选择且只选择一个。多预设时根据工具 description 的用途和本轮画面自行选择，不要固定使用第一项。工具 schema 里的 use_character_reference / use_user_reference / use_vibe_reference 等开关都由你按画面需要判断；有参考图不等于必须使用。\n\n剧情：${input.entry.title}\n前提：${compact(input.entry.premise) || '沿用当前正文'}\n当前用户侧身份：${input.userName}${input.userProfile.novelAiReference?.enabled ? '（有用户精密参考图可按需使用）' : ''}\n用户外观锚点：${compact(config?.userAnchor) || '按已有设定与正文保持一致'}\n角色外观锚点：\n${actorAnchors || '无'}\n额外画风：${compact(config?.stylePrompt) || '沿用所选生图预设'}\n避免内容：${compact(config?.negativePrompt) || '遵循所选工具自身负面规则'}\n目标画幅：${config?.width || 1216}×${config?.height || 832}\n\n可用工具（每行一项，parameters 必须严格遵守）：\n${toolSchemas}\n\n最终控制块严格使用下面格式，禁止 Markdown 代码块，禁止在闭合标签后继续输出任何文字：\n${INLINE_PLAN_OPEN}\n{"tool":"上面某个真实工具名","arguments":{"严格按该工具 parameters 填参数"}}\n${INLINE_PLAN_CLOSE}\n\n特别要求：arguments 里应直接给出可执行的最终生图参数；画面人物数量、身份、动作、服装、地点与情绪必须和你这一轮刚写出的正文一致；不要文字、对白框、水印、Logo 或 UI。`;
};

export interface StoryCloudImageToolHandoff {
    exposedName: string;
    toolName: string;
    engineId: 'gpt-image' | 'novelai';
    controlBaseUrl: string;
    token: string;
    preset?: {
        remoteConfig: Record<string, unknown>;
        apiKey: string;
    };
    references?: {
        actors?: Record<string, Record<string, unknown>>;
        user?: Record<string, unknown>;
        vibe?: Record<string, unknown>;
    };
}

export interface StoryCloudImageHandoffSpec {
    version: 1;
    tools: StoryCloudImageToolHandoff[];
}

export interface StoryCloudImageHandoffResult {
    state: 'submitted' | 'skipped' | 'failed';
    exposedTool?: string;
    toolName?: string;
    clientRequestId?: string;
    remoteJobId?: string;
    arguments?: Record<string, any>;
    uncertain?: boolean;
    error?: string;
}

const MANAGED_REFERENCE_KEYS = new Set([
    'reference_id',
    'reference_type',
    'reference_strength',
    'reference_fidelity',
    'user_reference_id',
    'user_reference_type',
    'user_reference_strength',
    'user_reference_fidelity',
    'vibe_reference_id',
    'vibe_reference_strength',
    'vibe_reference_information_extracted',
]);

const pickManagedReferenceFragment = (args: Record<string, any>): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(args || {})) {
        if (MANAGED_REFERENCE_KEYS.has(key)) out[key] = value;
    }
    return out;
};

/**
 * 在正文 story job 提交前冻结“这轮可能会选到的生图服务”。
 * 凭据只进入加密 story request，不会回显；NovelAI 参考图也在这里先确保远端槽位存在，
 * 这样用户提交正文后立刻锁屏，Worker 仍有足够信息独立把图片 /jobs 接上。
 */
export const buildStoryCloudImageHandoffSpec = async (input: {
    actors: CharacterProfile[];
    userProfile: UserProfile;
}): Promise<StoryCloudImageHandoffSpec | undefined> => {
    if (!input.actors.length) return undefined;
    const imageTools = resolveStoryImageTools(input.actors);
    const presets = getImageGenerationPresets();
    const tools: StoryCloudImageToolHandoff[] = [];

    for (const [exposedName, hit] of imageTools.resolve) {
        const controlBaseUrl = String(hit.server.controlBaseUrl || '').trim().replace(/\/+$/, '');
        if (!/^https?:\/\//i.test(controlBaseUrl)) continue;
        const engineId = hit.server.imagePresetEngineId === 'novelai' || hit.toolName === 'novelai_generate_image'
            ? 'novelai'
            : 'gpt-image';
        const preset = hit.server.imagePresetId
            ? presets.find(item => item.id === hit.server.imagePresetId)
            : undefined;
        const descriptor: StoryCloudImageToolHandoff = {
            exposedName,
            toolName: hit.toolName,
            engineId,
            controlBaseUrl,
            token: String(hit.server.token || ''),
            ...(preset ? {
                preset: {
                    remoteConfig: JSON.parse(JSON.stringify(preset.remoteConfig || {})),
                    apiKey: String(preset.apiKey || ''),
                },
            } : {}),
        };

        if (engineId === 'novelai') {
            const references: NonNullable<StoryCloudImageToolHandoff['references']> = {};
            const actorFragments: Record<string, Record<string, unknown>> = {};
            // 这些检查彼此独立；旧版逐个 await 会把每个远端 HEAD/上传延迟线性相加，
            // 多角色 + 用户 + Vibe 时很容易在正文真正提交前白等几分钟。
            const actorChecks = input.actors
                .filter(actor => actor.novelAiReference?.enabled)
                .map(async actor => {
                    try {
                        const prepared = await prepareBuiltinImageToolArguments({
                            server: hit.server,
                            toolName: hit.toolName,
                            args: {
                                prompt: '__story_cloud_reference_probe__',
                                use_character_reference: true,
                                use_user_reference: false,
                                use_vibe_reference: false,
                            },
                            character: actor,
                            userProfile: input.userProfile,
                        });
                        const fragment = pickManagedReferenceFragment(prepared);
                        if (Object.keys(fragment).length) actorFragments[actor.id] = fragment;
                    } catch (error) {
                        console.warn('[StoryTheater] cloud image actor reference preflight skipped', actor.id, error);
                    }
                });

            const userCheck = input.userProfile.novelAiReference?.enabled
                ? (async () => {
                    try {
                        const prepared = await prepareBuiltinImageToolArguments({
                            server: hit.server,
                            toolName: hit.toolName,
                            args: {
                                prompt: '__story_cloud_user_reference_probe__',
                                use_character_reference: false,
                                use_user_reference: true,
                                use_vibe_reference: false,
                            },
                            character: input.actors[0],
                            userProfile: input.userProfile,
                        });
                        const fragment = pickManagedReferenceFragment(prepared);
                        if (Object.keys(fragment).length) references.user = fragment;
                    } catch (error) {
                        console.warn('[StoryTheater] cloud image user reference preflight skipped', error);
                    }
                })()
                : Promise.resolve();

            const vibeCheck = (async () => {
                try {
                    const prepared = await prepareBuiltinImageToolArguments({
                        server: hit.server,
                        toolName: hit.toolName,
                        args: {
                            prompt: '__story_cloud_vibe_reference_probe__',
                            use_character_reference: false,
                            use_user_reference: false,
                            use_vibe_reference: true,
                        },
                        character: input.actors[0],
                        userProfile: input.userProfile,
                    });
                    const fragment = pickManagedReferenceFragment(prepared);
                    if (Object.keys(fragment).some(key => key.startsWith('vibe_'))) references.vibe = fragment;
                } catch (error) {
                    console.warn('[StoryTheater] cloud image vibe reference preflight skipped', error);
                }
            })();

            await Promise.all([...actorChecks, userCheck, vibeCheck]);
            if (Object.keys(actorFragments).length) references.actors = actorFragments;
            if (Object.keys(references).length) descriptor.references = references;
        }
        tools.push(descriptor);
    }
    return tools.length ? { version: 1, tools } : undefined;
};

export const adoptStoryCloudImageHandoff = async (input: {
    entry: StoryTheaterEntry;
    actors: CharacterProfile[];
    handoff: StoryCloudImageHandoffResult;
    inlinePlan?: StoryInlineImagePlan;
    targetMessageId: number;
}): Promise<StoryTheaterImageGenerationResult> => {
    if (input.handoff.state !== 'submitted' || !input.handoff.clientRequestId) {
        throw new Error('云端没有可接回的生图任务');
    }
    const imageTools = resolveStoryImageTools(input.actors);
    const exposedName = String(input.handoff.exposedTool || input.inlinePlan?.tool || '').trim();
    const selected = imageTools.resolve.get(exposedName);
    if (!selected) throw new Error('云端已经提交配图，但本机已找不到对应生图预设；为避免重复扣费不会重新生成');
    const toolName = String(input.handoff.toolName || selected.toolName);
    const args = input.handoff.arguments && typeof input.handoff.arguments === 'object'
        ? input.handoff.arguments
        : (input.inlinePlan?.arguments || {});
    const result = await adoptBackgroundImageJob(
        selected.server,
        toolName,
        args,
        {
            clientRequestId: input.handoff.clientRequestId,
            remoteJobId: input.handoff.remoteJobId,
        },
        {
            charId: storyTheaterThreadId(input.entry.id),
            ownerType: 'story-theater',
            storyTheaterTarget: {
                entryId: input.entry.id,
                messageId: input.targetMessageId,
                title: input.entry.title || '剧情剧场',
            },
        },
    );
    if (!result.success || !result.backgroundJob) {
        throw new Error(result.error || '云端生图任务接回失败');
    }
    return {
        queued: {
            localJobId: result.backgroundJob.localJobId,
            clientRequestId: result.backgroundJob.clientRequestId,
        },
    };
};

const parseToolArgs = (call: any): Record<string, any> => {
    const raw = call?.function?.arguments ?? call?.arguments;
    if (typeof raw === 'string') {
        try { return raw.trim() ? JSON.parse(raw) : {}; }
        catch { throw new Error('剧情配图规划器返回了无法解析的工具参数'); }
    }
    return raw && typeof raw === 'object' ? raw : {};
};

const extractPlannerSelection = (
    responseValue: any,
    imageTools: { resolve: Map<string, ResolvedMcpTool> },
): { selectedName: string; rawArgs: Record<string, any> } | null => {
    const message = responseValue?.choices?.[0]?.message || {};
    const nativeCalls = normalizeToolCallsForCompat(message.tool_calls, 'story-theater-image');
    for (const call of nativeCalls) {
        const name = String((call as any)?.function?.name || '');
        if (!imageTools.resolve.has(name)) continue;
        try {
            return { selectedName: name, rawArgs: parseToolArgs(call) };
        } catch {
            // 工具名已经对了但 arguments 被模型写坏：交给下面的纠错规划重做，不能直接执行半截参数。
        }
    }

    const faked = extractTextFakedMcpCalls(String(message.content || ''), imageTools.resolve)[0];
    return faked
        ? { selectedName: faked.exposedName, rawArgs: faked.args }
        : null;
};

const buildPlannerRepairBody = (
    nativeBody: Record<string, any>,
    textFallback: boolean,
): Record<string, any> => {
    const body = textFallback
        ? buildMcpRejectedToolsFallbackBody(nativeBody)
        : { ...nativeBody };
    body.temperature = 0;
    body.parallel_tool_calls = false;
    body.messages = [
        ...(body.messages || []),
        {
            role: 'system',
            content: textFallback
                ? '纠错重试：上一轮没有产生客户端可执行的生图调用。你现在只允许输出一个生图工具调用，严格使用上面 MCP 文字兼容格式 tool_name({JSON})；禁止解释、分析、道歉、代码块、自然语言前后缀，也禁止返回空白。'
                : '纠错重试：上一轮没有返回可执行的 tool_calls。你现在必须调用且只能调用一个本轮提供的生图工具；禁止只输出文字，禁止返回空白，禁止同时调用多个工具。',
        },
    ];
    return body;
};

const buildPlannerInstruction = (input: GenerateStoryImageInput, toolNames: string[]): string => {
    const config = input.entry.imageGeneration;
    const actorAnchors = input.actors.map(actor => {
        const referenceState = actor.novelAiReference?.enabled ? '（有角色精密参考图可供 AI 按需选择）' : '';
        return `${actor.name}${referenceState}：${compact(config?.characterAnchors?.[actor.id]) || '根据正文与角色设定保持外貌一致'}`;
    }).join('\n');
    const transcript = input.messages.slice(-8).map(message => `${message.role === 'user' ? input.userName : '剧场正文'}：${compact(message.content).slice(0, 1800)}`).join('\n\n');
    return `你正在后台为剧情剧场生成一张本轮插图，不是在回复聊天。必须从本轮提供的生图工具中选择最合适的一项并调用，不要只输出文字，也不要同时调用多个生图工具。\n\n这里故意复用主聊天现有的生图决策链：当前可选工具是 ${toolNames.join('、')}。如果出现多个“生图预设”工具，必须结合每个工具描述里的“用途”和当前剧情画面自行选择；不要因为在剧情剧场就固定到某个模型/预设。工具 schema 若提供 use_character_reference / use_user_reference / use_vibe_reference 等开关，也由你根据本轮画面自主判断是否使用，不能因为参考图存在就强制带上。\n\n剧情：${input.entry.title}\n前提：${compact(input.entry.premise) || '沿用正文'}\n当前身份 ${input.userName}${input.userProfile.novelAiReference?.enabled ? '（用户也有精密参考图可按需选择）' : ''}：${compact(config?.userAnchor) || '根据正文保持一致'}\n出场角色：\n${actorAnchors}\n\n最近剧情：\n${transcript}\n\n画面要求：只画最新一轮最有表现力的具体瞬间；保持人物数量、身份、动作、服装、地点与情绪一致；构图完整、有叙事感；不要文字、对白框、水印、Logo 或 UI。${config?.stylePrompt ? `\n额外画风：${config.stylePrompt}` : ''}${config?.negativePrompt ? `\n避免内容：${config.negativePrompt}` : ''}\n目标画幅：${config?.width || 1216}×${config?.height || 832}。剧情剧场只补充这些场景要求，其余模型/预设/参考图策略遵循主聊天现有生图工具与 schema。请直接调用一个工具。`;
};

export async function generateStoryTheaterImage(input: GenerateStoryImageInput): Promise<StoryTheaterImageGenerationResult> {
    if (!input.actors.length) throw new Error('剧情没有可用于配图的出场角色。');

    const imageTools = resolveStoryImageTools(input.actors);
    let selection: { selectedName: string; rawArgs: Record<string, any> } | null = null;

    if (input.inlinePlan) {
        const selectedName = String(input.inlinePlan.tool || '').trim();
        if (selectedName && imageTools.resolve.has(selectedName)) {
            selection = {
                selectedName,
                rawArgs: input.inlinePlan.arguments && typeof input.inlinePlan.arguments === 'object'
                    ? input.inlinePlan.arguments
                    : {},
            };
        } else {
            console.warn('[StoryTheater] inline image plan selected unavailable tool; falling back to legacy planner', {
                selectedName,
                availableTools: imageTools.tools.map(tool => tool.function.name),
            });
        }
    }

    if (!selection) {
        const plannerApiConfig = input.plannerApiConfig || input.apiConfig;
        const toolNames = imageTools.tools.map(tool => tool.function.name);
        const forcedToolChoice = imageTools.tools.length === 1
            ? {
                type: 'function',
                function: { name: imageTools.tools[0].function.name },
            }
            : 'required';
        const nativeBody = {
            model: plannerApiConfig.model,
            messages: [
                { role: 'system', content: buildPlannerInstruction(input, toolNames) },
                { role: 'user', content: '请为上面最新一轮剧情生成插图。' },
            ],
            tools: imageTools.tools,
            // 只有一个可用生图工具时不要再让模型“决定要不要调用”，直接指定函数；
            // 多工具时 required 只负责强制“必须选一个”，具体预设仍交给规划器判断。
            tool_choice: forcedToolChoice,
            parallel_tool_calls: false,
            temperature: 0.4,
            max_tokens: 3000,
            stream: false,
        };

        const runPlanner = async (body: Record<string, any>) => executeOpenAiChatPlan({
            // 旧兼容兜底：只有主剧情模型没产出合法 inline plan 时才会走到这里。
            plan: resolveApiExecutionPlan('chat', plannerApiConfig, false),
            body,
            meta: { appName: '剧情剧场', purpose: '剧情自动配图规划' },
            directMaxRetries: 1,
        });

        let response;
        let plannerUsedTextFallback = !getMcpUseNativeTools();
        if (plannerUsedTextFallback) {
            response = await runPlanner(buildMcpRejectedToolsFallbackBody(nativeBody));
        } else {
            try {
                response = await runPlanner(nativeBody);
            } catch (error) {
                if (!shouldRetryMcpWithoutTools(error)) throw error;
                plannerUsedTextFallback = true;
                response = await runPlanner(buildMcpRejectedToolsFallbackBody(nativeBody));
            }
        }

        selection = extractPlannerSelection(response.value, imageTools);
        if (!selection) {
            // 规划器偶发“明明有工具却只回正文”。真正生图尚未发生，所以这里补一次规划不会重复出图。
            console.warn('[StoryTheater] image planner omitted tool call; retrying planner once', {
                plannerModel: plannerApiConfig.model,
                mode: plannerUsedTextFallback ? 'text-fallback' : 'native-tools',
                toolCount: imageTools.tools.length,
            });
            const repairBody = buildPlannerRepairBody(nativeBody, plannerUsedTextFallback);
            const repairResponse = await runPlanner(repairBody);
            selection = extractPlannerSelection(repairResponse.value, imageTools);

            if (!selection && !plannerUsedTextFallback) {
                const repairMessage = repairResponse.value?.choices?.[0]?.message || {};
                const faked = extractTextFakedMcpCalls(String(repairMessage.content || ''), imageTools.resolve)[0];
                if (faked) selection = { selectedName: faked.exposedName, rawArgs: faked.args };
            }
        }
    }

    if (!selection) {
        throw new Error('剧情配图规划器连续两次没有返回可执行的生图工具调用。');
    }
    const { selectedName, rawArgs } = selection;

    const selected = imageTools.resolve.get(selectedName);
    if (!selected) throw new Error('剧情配图规划器选择了未知的生图工具。');

    if (selected.server.imagePresetId) {
        // 与主聊天一致：AI 选中哪个 NovelAI 生图预设，就先把那套预设真实应用到内置服务。
        await applyImageGenerationPresetById(selected.server.imagePresetId);
    }

    const clientArgs = { ...rawArgs };
    const requestedActorId = typeof clientArgs.story_reference_actor_id === 'string'
        ? clientArgs.story_reference_actor_id
        : '';
    delete clientArgs.story_reference_actor_id;

    const referenceActor =
        input.actors.find(actor => actor.id === requestedActorId)
        || input.actors.find(actor => actor.novelAiReference?.enabled)
        || input.actors[0];

    const preparedArgs = await prepareBuiltinImageToolArguments({
        server: selected.server,
        toolName: selected.toolName,
        args: clientArgs,
        character: referenceActor,
        userProfile: input.userProfile,
    });

    const result = input.targetMessageId
        ? await callMcpToolWithBackgroundImage(
            selected.server,
            selected.toolName,
            preparedArgs,
            {
                charId: storyTheaterThreadId(input.entry.id),
                ownerType: 'story-theater',
                storyTheaterTarget: {
                    entryId: input.entry.id,
                    messageId: input.targetMessageId,
                    title: input.entry.title || '剧情剧场',
                },
            },
        )
        : await callMcpTool(selected.server, selected.toolName, preparedArgs);
    if (!result.success) throw new Error(result.error || '剧情配图生成失败');

    // 新版内置生图服务会先把任务交给服务器 /jobs。此时“成功”表示已可靠接单，
    // 不是“没有图”；全局后台任务监视器会在完成后把图片挂回 targetMessageId。
    if (result.backgroundJob) {
        return {
            queued: {
                localJobId: result.backgroundJob.localJobId,
                clientRequestId: result.backgroundJob.clientRequestId,
            },
        };
    }

    // 老服务不支持 /jobs 时，callMcpToolWithBackgroundImage 会安全回退到原直连路径。
    const galleryOwner: CharacterProfile = {
        ...input.actors[0],
        id: storyTheaterThreadId(input.entry.id),
        name: input.entry.title || '剧情剧场',
    };
    const outcome = await persistMcpGeneratedImages({
        result,
        char: galleryOwner,
        server: { id: selected.server.id, name: selected.server.name },
        toolName: selected.toolName,
        toolArgs: preparedArgs,
        recentMessages: input.messages.slice(-8),
        ownerType: 'meeting-cg',
        allowTemporaryUrlFallback: false,
        extraGallerySourceMeta: {
            source: 'story-theater',
            theaterId: input.entry.id,
            theaterTitle: input.entry.title,
            imagePresetId: selected.server.imagePresetId,
            referenceActorId: referenceActor?.id,
        },
    });

    const asset = outcome.assets[0];
    if (!asset) throw new Error(outcome.errors[0] || '剧情配图保存到本机与相册失败');
    return {
        frame: {
            imageRef: asset.blobRef,
            galleryImageId: asset.galleryImageId,
            prompt: asset.prompt,
            engine: asset.engine,
            generatedAt: asset.createdAt,
        },
    };
}
