import type { APIConfig, ApiPreset, CharacterProfile, Message, StoryTheaterEntry, StoryTheaterImageFrame, UserProfile } from '../types';
import { resolveApiExecutionPlan, executeOpenAiChatPlan } from './apiFailover';
import { storyTheaterThreadId } from './storyTheater';
import { callMcpTool, getMcpUseNativeTools } from './mcpClient';
import { callMcpToolWithBackgroundImage } from './backgroundImageJobs';
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
    isCharacterReferenceAllowedForActivePreset,
} from './imageGenerationPresets';
import { persistMcpGeneratedImages } from './mcpImagePersistence';

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
    return `你正在后台为剧情剧场生成一张本轮插图，不是在回复聊天。必须从本轮提供的生图工具中选择最合适的一项并调用，不要只输出文字，也不要同时调用多个生图工具。

这里故意复用主聊天现有的生图决策链：当前可选工具是 ${toolNames.join('、')}。如果出现多个“生图预设”工具，必须结合每个工具描述里的“用途”和当前剧情画面自行选择；不要因为在剧情剧场就固定到某个模型/预设。工具 schema 若提供 use_character_reference / use_user_reference / use_vibe_reference 等开关，也由你根据本轮画面自主判断是否使用，不能因为参考图存在就强制带上。

剧情：${input.entry.title}
前提：${compact(input.entry.premise) || '沿用正文'}
当前身份 ${input.userName}${input.userProfile.novelAiReference?.enabled ? '（用户也有精密参考图可按需选择）' : ''}：${compact(config?.userAnchor) || '根据正文保持一致'}
出场角色：
${actorAnchors}

最近剧情：
${transcript}

画面要求：只画最新一轮最有表现力的具体瞬间；保持人物数量、身份、动作、服装、地点与情绪一致；构图完整、有叙事感；不要文字、对白框、水印、Logo 或 UI。${config?.stylePrompt ? `\n额外画风：${config.stylePrompt}` : ''}${config?.negativePrompt ? `\n避免内容：${config.negativePrompt}` : ''}
目标画幅：${config?.width || 1216}×${config?.height || 832}。剧情剧场只补充这些场景要求，其余模型/预设/参考图策略遵循主聊天现有生图工具与 schema。请直接调用一个工具。`;
};

export async function generateStoryTheaterImage(input: GenerateStoryImageInput): Promise<StoryTheaterImageGenerationResult> {
    if (!input.actors.length) throw new Error('剧情没有可用于配图的出场角色。');

    const plannerApiConfig = input.plannerApiConfig || input.apiConfig;
    const imageTools = resolveStoryImageTools(input.actors);
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
        // 用户明确选的是“规划器快速模型”，这里固定走这一条，不借主聊天/剧情故障转移改线。
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

    let selection = extractPlannerSelection(response.value, imageTools);
    if (!selection) {
        // 规划器偶发“明明有工具却只回正文”。真正生图尚未发生，所以这里补一次规划不会重复出图。
        // Native FC 路径先用更严格的 tool_choice/temperature=0 纠错；若本来就是文字兼容模式，
        // 则严格要求只输出一行可解析的假调用。只补这一轮，避免规划器自己无限循环扣费。
        console.warn('[StoryTheater] image planner omitted tool call; retrying planner once', {
            plannerModel: plannerApiConfig.model,
            mode: plannerUsedTextFallback ? 'text-fallback' : 'native-tools',
            toolCount: imageTools.tools.length,
        });
        const repairBody = buildPlannerRepairBody(nativeBody, plannerUsedTextFallback);
        const repairResponse = await runPlanner(repairBody);
        selection = extractPlannerSelection(repairResponse.value, imageTools);

        // 有些“OpenAI 兼容”中转接受 tools 却静默无视 tool_choice。纠错轮仍没 FC 时，
        // 不再发第三次模型请求；直接检查这次正文有没有按兼容调用格式输出。
        if (!selection && !plannerUsedTextFallback) {
            const repairMessage = repairResponse.value?.choices?.[0]?.message || {};
            const faked = extractTextFakedMcpCalls(String(repairMessage.content || ''), imageTools.resolve)[0];
            if (faked) selection = { selectedName: faked.exposedName, rawArgs: faked.args };
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
