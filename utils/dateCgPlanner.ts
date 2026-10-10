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
    const tools = built.tools.filter(tool => {
        const hit = built.resolve.get(tool.function.name);
        if (!isMeetingImageTool(hit)) return false;
        resolve.set(tool.function.name, hit);
        return true;
    });
    if (!tools.length) {
        throw new Error('当前没有可用的内置生图工具。请先在设置 → 生图功能中启用并完成工具发现。');
    }
    return { tools, resolve };
};

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
): string => `
你正在后台为“线下模式”规划并生成一张剧情 CG。你不是在回复普通聊天。

必须以本次线下会话消息和下面的当前场景为最高优先级；不要改用主聊天近期消息：
${sceneSummary}

这次提供给你的生图工具、参数 schema 和参考图开关与主聊天共用同一套规则。必须只调用一次下面的生图工具之一，不要只输出文字，也不要先做第二次聊天判断：
${plannerToolSummary(tools)}

如果出现多个“生图预设”工具，它们仍属于用户已经固定选择的同一个 NovelAI 引擎；请直接根据工具描述里的“用途”在本次调用中选一个最适合当前 CG 的预设，不要额外调用模型来选预设。

参考图可用性：
- 当前角色（${char.name}）：${char.novelAiReference?.enabled ? '有可选精密参考图；仅当画面确实需要锁定该角色外观时使用。' : '没有启用精密参考图。'}
- 用户角色（${userProfile.name || '用户'}）：${userProfile.novelAiReference?.enabled ? '有可选精密参考图；仅当画面确实需要锁定用户角色外观时使用。' : '没有启用精密参考图。'}
多人构图若工具支持 character_prompts，应像主聊天一样用原生多人字段隔离每个人的外观与动作，不要把两个人的身份特征混进同一人物。

画面目标：
- story CG / character-focused illustration，而不是背景图或壁纸；
- 突出当前这一幕真正发生的角色互动、外貌、姿态、视线、表情和距离感；
- 场景与当下情绪明确，构图完整、自然、有剧情感；
- 不要求为 UI 留空白，不使用 suitable as a background / leave negative space for UI 之类导向；
- 不生成文字、对白框、水印、Logo 或 UI 元素；
- after_generate_action 固定用 none；见面 CG 不需要生成后再追加一次聊天评价。

请直接调用一次图像工具。`.trim();

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
    if (chosen.resolved.server.imagePresetId) {
        await applyImageGenerationPresetById(chosen.resolved.server.imagePresetId);
    }

    const preparedArgs = await prepareBuiltinImageToolArguments({
        server: chosen.resolved.server,
        toolName: chosen.resolved.toolName,
        args: cleanedArgs,
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
