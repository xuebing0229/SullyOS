import type { APIConfig, CharacterProfile, DateObservation, GroupProfile, Message, UserProfile } from '../types';
import { DB } from './db';
import { buildChatRequestPayload } from './chatRequestPayload';
import { resolveApiExecutionPlan, executeOpenAiChatPlan } from './apiFailover';
import { getBuiltinImageMcpServers, loadBuiltinImageSettings } from './builtinImageMcp';
import { augmentImageToolSchema } from './imageToolPostAction';
import { callMcpTool, type McpServerConfig, type McpToolResult } from './mcpClient';
import {
    buildMcpRejectedToolsFallbackBody,
    extractTextFakedMcpCalls,
    shouldRetryMcpWithoutTools,
    type ResolvedMcpTool,
} from './mcpToolBridge';
import { normalizeToolCallsForCompat } from './toolCallCompat';
import { prepareBuiltinImageToolArguments } from './novelAiReference';
import { persistMcpGeneratedImages } from './mcpImagePersistence';
import { makeMeetingCgBackground, type MeetingCgBackground, type MeetingCgEngine } from './meetingCg';

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

const resolveDefaultImageTool = (): { engine: MeetingCgEngine; server: McpServerConfig; toolName: string } => {
    const settings = loadBuiltinImageSettings();
    const preferred = settings.preferredEngine;
    if (!preferred) throw new Error('请先在设置 → 内置生图引擎中选择默认生图模式。');
    const binding = settings.engines[preferred];
    if (!binding.enabled) throw new Error('当前默认生图模式尚未启用。');
    const serverId = `builtin_image_${preferred}`;
    const server = getBuiltinImageMcpServers().find(item => item.id === serverId && item.enabled);
    if (!server) throw new Error('当前默认生图工具不可用。');
    const toolName = preferred === 'gpt-image' ? 'generate_image' : 'novelai_generate_image';
    return { engine: preferred === 'gpt-image' ? 'gpt' : 'novelai', server, toolName };
};

const plannerInstruction = (sceneSummary: string, toolName: string): string => `
你正在后台为“线下模式”规划并生成一张剧情 CG。你不是在回复普通聊天。

必须以本次线下会话消息和下面的当前场景为最高优先级；不要改用主聊天近期消息：
${sceneSummary}

必须调用工具 ${toolName} 完成生图，不要只输出文字。工具参数应由你根据完整角色设定、用户档案、记忆宫殿、世界书和当前线下互动自行规划。

画面目标：
- story CG / character-focused illustration，而不是背景图或壁纸；
- 突出当前这一幕的角色互动、外貌、姿态、视线、表情和距离感；
- 场景与当下情绪明确，构图完整、自然、有剧情感；
- 不要求为 UI 留空白，不使用 suitable as a background / leave negative space for UI 之类导向；
- 不生成文字、对白框、水印、Logo 或 UI 元素。

请直接调用图像工具。`.trim();

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
    const selected = resolveDefaultImageTool();
    const [emojis, categories] = await Promise.all([DB.getEmojis(), DB.getEmojiCategories()]);
    const sceneSummary = buildMeetingSceneSummary(input);
    const recentMeetingMessages = input.meetingMessages.slice(-16);
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
        contextLimit: Math.max(16, recentMeetingMessages.length),
        stripImages: true,
        allowMcpChat: false,
        ephemeralMessages: [{ role: 'system', content: plannerInstruction(sceneSummary, selected.toolName) }],
    });
    const toolDef = (selected.server.tools || []).find(tool => tool.name === selected.toolName);
    if (!toolDef) throw new Error('默认生图工具缺少已发现的 schema。');
    const exposedName = selected.toolName.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
    const toolSpec = {
        type: 'function' as const,
        function: {
            name: exposedName,
            description: toolDef.description || 'Generate the planned story CG image.',
            parameters: augmentImageToolSchema(toolDef.inputSchema || { type: 'object', properties: {} }, selected.toolName),
        },
    };
    const body: Record<string, any> = {
        model: input.apiConfig.model,
        messages: payload.fullMessages,
        tools: [toolSpec],
        tool_choice: 'required',
        temperature: input.apiConfig.temperature ?? 0.85,
        max_tokens: 4000,
        stream: false,
    };
    const plan = resolveApiExecutionPlan('chat', input.apiConfig, true);
    let response;
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
    const message = response.value?.choices?.[0]?.message || {};
    const nativeCalls = normalizeToolCallsForCompat(message.tool_calls, 'meeting-cg');
    let rawArgs: Record<string, any> | null = null;
    const native = nativeCalls.find((call: any) => call?.function?.name === exposedName || call?.function?.name === selected.toolName);
    if (native) rawArgs = parseToolArgs(native);
    if (!rawArgs) {
        const resolve = new Map<string, ResolvedMcpTool>([[exposedName, { server: selected.server, toolName: selected.toolName, executionPolicy: 'single-shot' }]]);
        const faked = extractTextFakedMcpCalls(String(message.content || ''), resolve)[0];
        if (faked) rawArgs = faked.args;
    }
    if (!rawArgs) throw new Error('线下 CG Planner 没有调用生图工具。');
    const preparedArgs = await prepareBuiltinImageToolArguments({
        server: selected.server,
        toolName: selected.toolName,
        args: rawArgs,
        character: input.char,
        userProfile: input.userProfile,
    });
    const result: McpToolResult = await callMcpTool(selected.server, selected.toolName, preparedArgs);
    if (!result.success) throw new Error(result.error || '线下 CG 生成失败');
    const outcome = await persistMcpGeneratedImages({
        result,
        char: input.char,
        server: { id: selected.server.id, name: selected.server.name },
        toolName: selected.toolName,
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
        engine: selected.engine,
        promptSummary: sceneSummary.slice(0, 500),
        source: 'date-cg-planner',
        createdAt: asset.createdAt,
    });
}
