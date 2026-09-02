import type { APIConfig, ApiPreset, CharacterProfile, Message, StoryTheaterEntry, StoryTheaterImageFrame, UserProfile } from '../types';
import { resolveApiExecutionPlan, executeOpenAiChatPlan } from './apiFailover';
import { storyTheaterThreadId } from './storyTheater';
import { callMcpTool, getMcpUseNativeTools } from './mcpClient';
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

export async function generateStoryTheaterImage(input: GenerateStoryImageInput): Promise<StoryTheaterImageFrame> {
    if (!input.actors.length) throw new Error('剧情没有可用于配图的出场角色。');

    const plannerApiConfig = input.plannerApiConfig || input.apiConfig;
    const imageTools = resolveStoryImageTools(input.actors);
    const toolNames = imageTools.tools.map(tool => tool.function.name);
    const nativeBody = {
        model: plannerApiConfig.model,
        messages: [
            { role: 'system', content: buildPlannerInstruction(input, toolNames) },
            { role: 'user', content: '请为上面最新一轮剧情生成插图。' },
        ],
        tools: imageTools.tools,
        tool_choice: 'required',
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
    if (!getMcpUseNativeTools()) {
        response = await runPlanner(buildMcpRejectedToolsFallbackBody(nativeBody));
    } else {
        try {
            response = await runPlanner(nativeBody);
        } catch (error) {
            if (!shouldRetryMcpWithoutTools(error)) throw error;
            response = await runPlanner(buildMcpRejectedToolsFallbackBody(nativeBody));
        }
    }

    const message = response.value?.choices?.[0]?.message || {};
    const nativeCalls = normalizeToolCallsForCompat(message.tool_calls, 'story-theater-image');
    const native = nativeCalls.find((call: any) => imageTools.resolve.has(String(call?.function?.name || '')));

    let selectedName = native ? String(native?.function?.name || '') : '';
    let rawArgs: Record<string, any> | null = native ? parseToolArgs(native) : null;
    if (!rawArgs) {
        const faked = extractTextFakedMcpCalls(String(message.content || ''), imageTools.resolve)[0];
        if (faked) {
            selectedName = faked.exposedName;
            rawArgs = faked.args;
        }
    }
    if (!rawArgs || !selectedName) throw new Error('剧情配图规划器没有调用生图工具。');

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

    const result = await callMcpTool(selected.server, selected.toolName, preparedArgs);
    if (!result.success) throw new Error(result.error || '剧情配图生成失败');

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
        imageRef: asset.blobRef,
        galleryImageId: asset.galleryImageId,
        prompt: asset.prompt,
        engine: asset.engine,
        generatedAt: asset.createdAt,
    };
}
