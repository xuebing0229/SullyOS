import type { APIConfig, CharacterProfile, DateObservation, GroupProfile, Message, UserProfile } from '../types';
import { DB } from './db';
import { buildChatRequestPayload } from './chatRequestPayload';
import { resolveApiExecutionPlan, executeOpenAiChatPlan } from './apiFailover';
import { parseImageToolClientOptions } from './imageToolPostAction';
import { callMcpTool, getMcpUseNativeTools, type McpToolResult } from './mcpClient';
import {
    buildMcpOpenAITools,
    buildMcpRejectedToolsFallbackBody,
    extractTextFakedMcpCalls,
    shouldRetryMcpWithoutTools,
    type ResolvedMcpTool,
} from './mcpToolBridge';
import {
    applyImageGenerationPresetById,
    isCharacterReferenceAllowedForActivePreset,
} from './imageGenerationPresets';
import { normalizeToolCallsForCompat } from './toolCallCompat';
import { prepareBuiltinImageToolArguments } from './novelAiReference';
import { persistMcpGeneratedImages } from './mcpImagePersistence';
import { makeMeetingCgBackground, type MeetingCgBackground } from './meetingCg';
import {
    augmentStoryImagePlanningParameters,
    composeStoryImagePromptArguments,
    type StoryImagePromptLayers,
} from './storyImagePromptLayers';

export interface GenerateMeetingCgInput {
    apiConfig: APIConfig;
    char: CharacterProfile;
    userProfile: UserProfile;
    groups: GroupProfile[];
    meetingMessages: Message[];
    observation?: DateObservation | null;
    peekStatus?: string;
    currentText?: string;
    regenerate?: boolean;
}

const compact = (value?: string): string => (value || '').replace(/\s+/g, ' ').trim();

export const buildMeetingSceneSummary = (input: Pick<GenerateMeetingCgInput, 'observation' | 'peekStatus' | 'currentText' | 'regenerate'>): string => {
    const obs = input.observation;
    return [
        '当前是线下见面场景。',
        obs?.place ? `地点：${compact(obs.place)}。` : '',
        obs?.time ? `时间：${compact(obs.time)}。` : '',
        obs?.state ? `当前状态与情绪：${compact(obs.state)}。` : '',
        obs?.detail ? `最近观测：${compact(obs.detail)}。` : '',
        !obs?.detail && input.currentText ? `当前台词或动作：${compact(input.currentText)}。` : '',
        !obs?.detail && !input.currentText && input.peekStatus ? `当前场景：${compact(input.peekStatus)}。` : '',
        input.regenerate
            ? '这是对当前线下场景 CG 的重新生成：保持同一场景、角色关系和互动语义，允许构图、机位、表情、姿态与局部细节合理变化。'
            : '',
    ].filter(Boolean).join('\n');
};

const IMAGE_TOOL_NAMES = new Set(['generate_image', 'novelai_generate_image']);

const isMeetingImageTool = (resolved: ResolvedMcpTool | undefined): resolved is ResolvedMcpTool =>
    Boolean(
        resolved
        && resolved.server.builtin === true
        && (
            resolved.server.id.startsWith('builtin_image_')
            || Boolean(resolved.server.imagePresetId)
        )
        && IMAGE_TOOL_NAMES.has(resolved.toolName),
    );

export const sanitizeMeetingMessageForCg = (message: Message): Message => {
    if (typeof message.content !== 'string') return message;
    const content = message.content
        .replace(/\[(?:speaker|s):\s*(?:char|user)\s*\]/ig, '')
        .replace(/\[v:\s*[a-zA-Z]+\s*\]/g, '')
        .split('\n')
        .map(line => line.replace(/^\s*\[(?:normal|happy|angry|sad|shy)\]\s*/i, ''))
        .join('\n')
        .trim();
    return { ...message, content };
};

export const resolveMeetingCgPlannerTools = (charId?: string) => {
    const built = buildMcpOpenAITools(charId, {
        allowCharacterReference: isCharacterReferenceAllowedForActivePreset(),
    });
    const resolve = new Map<string, ResolvedMcpTool>();
    const tools = built.tools.flatMap(tool => {
        const hit = built.resolve.get(tool.function.name);
        if (!isMeetingImageTool(hit)) return [];
        resolve.set(tool.function.name, hit);
        return [{
            ...tool,
            function: {
                ...tool.function,
                parameters: augmentStoryImagePlanningParameters(tool.function.parameters),
            },
        }];
    });
    if (!tools.length) {
        throw new Error('当前没有可用的内置生图工具。请先在设置 → 生图功能中启用并完成工具发现。');
    }
    return { tools, resolve };
};

export const buildMeetingCgPromptLayers = (char: CharacterProfile): StoryImagePromptLayers => ({
    character: compact(char.dateCgImagePrompt?.characterAnchors?.[char.id]),
    user: compact(char.dateCgImagePrompt?.userAnchor),
    style: compact(char.dateCgImagePrompt?.stylePrompt),
    negative: compact(char.dateCgImagePrompt?.negativePrompt),
});

export const composeMeetingCgImageArguments = (input: {
    args: Record<string, any>;
    parameters?: Record<string, any>;
    char: CharacterProfile;
    toolName: string;
}) => composeStoryImagePromptArguments({
    args: input.args,
    parameters: input.parameters,
    layers: buildMeetingCgPromptLayers(input.char),
    engineId: input.toolName === 'novelai_generate_image' ? 'novelai' : 'gpt-image',
    toolName: input.toolName,
});

const plannerToolSummary = (
    tools: ReturnType<typeof resolveMeetingCgPlannerTools>['tools'],
): string => tools.map(tool => {
    const desc = (tool.function.description || '').trim();
    return `- ${tool.function.name}${desc ? `：${desc}` : ''}`;
}).join('\n');

const plannerInstruction = (
    sceneSummary: string,
    tools: ReturnType<typeof resolveMeetingCgPlannerTools>['tools'],
    char: CharacterProfile,
    userProfile: UserProfile,
): string => {
    const layers = buildMeetingCgPromptLayers(char);
    return `
你正在后台为“线下模式”规划并生成一张剧情 CG。你不是在回复普通聊天。

必须以本次线下会话消息和下面的当前场景为最高优先级；不要改用主聊天近期消息：
${sceneSummary}

这次提供给你的生图工具、参数 schema 和参考图开关与主聊天/文游共用同一套规则。必须只调用一次下面的生图工具之一，不要只输出文字，也不要先做第二次聊天判断：
${plannerToolSummary(tools)}

如果出现多个“生图预设”工具，它们仍属于用户已经固定选择的同一个 NovelAI 引擎；请直接根据工具描述里的“用途”和当前这一帧选择最合适的预设，不要额外调用模型来选预设。

你还必须像文游配图一样明确决定这一帧谁真正入镜：
- story_include_character：当前角色 ${char.name} 是否真实出现在最终画面；
- story_include_user：用户 ${userProfile.name || '用户'} 是否真实出现在最终画面；
- story_character_dynamic_prompt / story_user_dynamic_prompt 只写各自在这一帧变化的动作、表情、姿势、位置、临时服装或状态；
- 不入镜的人对应 include 必须为 false，dynamic prompt 留空；
- 不要因为两个人都存在于剧情上下文，就把两个人都判定为入镜。

参考图也只按这一帧的真实画面判断：
- 当前角色（${char.name}）：${char.novelAiReference?.enabled ? '有可选精密参考图；只有角色真正入镜且本帧需要锁定外观时才可开启 use_character_reference。' : '没有启用精密参考图。'}
- 用户角色（${userProfile.name || '用户'}）：${userProfile.novelAiReference?.enabled ? '有可选精密参考图；只有用户真正入镜且本帧需要锁定外观时才可开启 use_user_reference。' : '没有启用精密参考图。'}
单人画面不得顺手带另一个人的参考图。双人画面若工具支持 character_prompts，由执行端根据双方固定锚点和动态状态生成原生多人字段；你不要自己填写 character_prompts。

以下固定层来自用户在“见面设置 → CG 配图提示词”保存的共享文游配图预设。它们会由客户端在你完成规划后确定性合并，你可以据此理解人物与画风，但不要复制进动态 prompt：
- 固定画风：${layers.style || '未设置'}
- ${userProfile.name || '用户'} 固定外观：${layers.user || '未设置'}
- ${char.name} 固定外观：${layers.character || '未设置'}
- 固定负面提示：${layers.negative || '未设置'}

工具 arguments 里的 prompt 只负责这一帧可变的场景、镜头、构图、光线、整体互动与环境。不要复述上面的固定人物外貌、固定画风或固定负面词；客户端会按 story_include_character / story_include_user 的结果自动合并。

画面目标：
- story CG / character-focused illustration，而不是背景图或壁纸；
- 突出当前这一幕真正发生的角色互动、姿态、视线、表情和距离感；
- 场景与当下情绪明确，构图完整、自然、有剧情感；
- 不要求为 UI 留空白，不使用 suitable as a background / leave negative space for UI 之类导向；
- 不生成文字、对白框、水印、Logo 或 UI 元素；
- after_generate_action 固定用 none；见面 CG 不需要生成后再追加一次聊天评价。

请直接调用一次图像工具。`.trim();
};

const parseToolArgs = (call: any): Record<string, any> => {
    const raw = call?.function?.arguments ?? call?.arguments;
    if (typeof raw === 'string') {
        try { return raw.trim() ? JSON.parse(raw) : {}; } catch { throw new Error('线下 CG Planner 返回了无法解析的工具参数'); }
    }
    return raw && typeof raw === 'object' ? raw : {};
};

export async function generateMeetingCgViaChatPlanner(input: GenerateMeetingCgInput): Promise<MeetingCgBackground> {
    if (!input.meetingMessages.length && !input.peekStatus && !input.currentText) {
        throw new Error('当前线下会话没有可用于规划 CG 的上下文。');
    }

    const toolSet = resolveMeetingCgPlannerTools(input.char.id);
    const [emojis, categories] = await Promise.all([DB.getEmojis(), DB.getEmojiCategories()]);
    const sceneSummary = buildMeetingSceneSummary(input);
    const recentMeetingMessages = input.meetingMessages.slice(-24).map(sanitizeMeetingMessageForCg);
    const payload = await buildChatRequestPayload({
        char: input.char,
        userProfile: input.userProfile,
        groups: input.groups,
        emojis,
        categories,
        historyMsgs: recentMeetingMessages,
        recentMsgsHint: recentMeetingMessages,
        worldbookQueryMessages: recentMeetingMessages,
        recallQueryHint: sceneSummary,
        contextLimit: Math.max(24, recentMeetingMessages.length),
        stripImages: true,
        allowMcpChat: false,
        ephemeralMessages: [{
            role: 'system',
            content: plannerInstruction(sceneSummary, toolSet.tools, input.char, input.userProfile),
        }],
    });

    const body: Record<string, any> = {
        model: input.apiConfig.model,
        messages: payload.fullMessages,
        tools: toolSet.tools,
        tool_choice: 'required',
        temperature: input.apiConfig.temperature ?? 0.85,
        max_tokens: 4000,
        stream: false,
    };

    const plan = resolveApiExecutionPlan('chat', input.apiConfig, true);
    let response;
    if (!getMcpUseNativeTools()) {
        response = await executeOpenAiChatPlan({
            plan,
            body: buildMcpRejectedToolsFallbackBody(body),
            meta: { appName: '线下见面', charId: input.char.id, charName: input.char.name, purpose: '线下 CG 生图规划兼容模式' },
            directMaxRetries: 2,
        });
    } else {
        try {
            response = await executeOpenAiChatPlan({
                plan,
                body,
                meta: { appName: '线下见面', charId: input.char.id, charName: input.char.name, purpose: '线下 CG 生图规划' },
                directMaxRetries: 2,
            });
        } catch (error) {
            if (!shouldRetryMcpWithoutTools(error)) throw error;
            response = await executeOpenAiChatPlan({
                plan,
                body: buildMcpRejectedToolsFallbackBody(body),
                meta: { appName: '线下见面', charId: input.char.id, charName: input.char.name, purpose: '线下 CG 生图规划兼容重试' },
                directMaxRetries: 0,
            });
        }
    }

    const message = response.value?.choices?.[0]?.message || {};
    const nativeCalls = normalizeToolCallsForCompat(message.tool_calls, 'meeting-cg');
    let chosen: { exposedName: string; resolved: ResolvedMcpTool; args: Record<string, any> } | null = null;

    for (const call of nativeCalls) {
        const exposedName = String(call?.function?.name || '');
        const resolved = toolSet.resolve.get(exposedName);
        if (!isMeetingImageTool(resolved)) continue;
        chosen = { exposedName, resolved, args: parseToolArgs(call) };
        break;
    }

    if (!chosen) {
        const faked = extractTextFakedMcpCalls(String(message.content || ''), toolSet.resolve)[0];
        if (faked && isMeetingImageTool({ server: faked.server, toolName: faked.toolName, executionPolicy: faked.executionPolicy })) {
            chosen = {
                exposedName: faked.exposedName,
                resolved: { server: faked.server, toolName: faked.toolName, executionPolicy: faked.executionPolicy },
                args: faked.args,
            };
        }
    }

    if (!chosen) {
        throw new Error('线下 CG 规划没有产出生图调用。当前聊天模型可能不支持工具调用，请在 MCP 设置里关闭“原生 tools”后重试。');
    }

    const { cleanedArgs } = parseImageToolClientOptions(chosen.args);
    const planningTool = toolSet.tools.find(tool => tool.function.name === chosen.exposedName);
    const composed = composeMeetingCgImageArguments({
        args: cleanedArgs,
        parameters: planningTool?.function.parameters,
        char: input.char,
        toolName: chosen.resolved.toolName,
    });

    if (chosen.resolved.server.imagePresetId) {
        await applyImageGenerationPresetById(chosen.resolved.server.imagePresetId);
    }

    const preparedArgs = await prepareBuiltinImageToolArguments({
        server: chosen.resolved.server,
        toolName: chosen.resolved.toolName,
        args: composed.arguments,
        character: input.char,
        userProfile: input.userProfile,
    });

    const result: McpToolResult = await callMcpTool(
        chosen.resolved.server,
        chosen.resolved.toolName,
        preparedArgs,
    );
    if (!result.success) throw new Error(result.error || '线下 CG 生成失败');

    const outcome = await persistMcpGeneratedImages({
        result,
        char: input.char,
        server: {
            id: chosen.resolved.server.id,
            name: chosen.resolved.server.name,
            imagePresetId: chosen.resolved.server.imagePresetId,
        },
        toolName: chosen.resolved.toolName,
        toolArgs: preparedArgs,
        recentMessages: recentMeetingMessages,
        ownerType: 'meeting-cg',
        allowTemporaryUrlFallback: false,
        extraGallerySourceMeta: {
            meetingCgGenerated: true,
            source: 'date-cg-planner',
            sceneSummary,
        },
    });
    const asset = outcome.assets[0];
    if (!asset) throw new Error(outcome.errors[0] || '线下 CG 保存到本机与相册失败');

    return makeMeetingCgBackground({
        id: `meeting_cg_${asset.createdAt.toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
        imageUrl: asset.blobRef,
        galleryImageId: asset.galleryImageId,
        engine: chosen.resolved.toolName === 'novelai_generate_image' ? 'novelai' : 'gpt',
        promptSummary: sceneSummary.slice(0, 500),
        source: 'date-cg-planner',
        createdAt: asset.createdAt,
    });
}
