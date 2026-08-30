import type { APIConfig, CharacterProfile, Message, StoryTheaterEntry, StoryTheaterImageFrame, UserProfile } from '../types';
import { resolveApiExecutionPlan, executeOpenAiChatPlan } from './apiFailover';
import { storyTheaterThreadId } from './storyTheater';
import { getBuiltinImageMcpServers, loadBuiltinImageSettings } from './builtinImageMcp';
import { augmentImageToolSchema } from './imageToolPostAction';
import { callMcpTool, type McpServerConfig } from './mcpClient';
import { extractTextFakedMcpCalls, type ResolvedMcpTool } from './mcpToolBridge';
import { normalizeToolCallsForCompat } from './toolCallCompat';
import { prepareBuiltinImageToolArguments } from './novelAiReference';
import { persistMcpGeneratedImages } from './mcpImagePersistence';

interface GenerateStoryImageInput {
    apiConfig: APIConfig;
    entry: StoryTheaterEntry;
    actors: CharacterProfile[];
    userProfile: UserProfile;
    userName: string;
    messages: Message[];
}

const compact = (value?: string): string => (value || '').replace(/\s+/g, ' ').trim();

const resolveImageTool = (): { server: McpServerConfig; toolName: string } => {
    const settings = loadBuiltinImageSettings();
    const preferred = settings.preferredEngine;
    if (!preferred) throw new Error('请先在设置 → 内置生图引擎中选择默认生图模式。');
    if (!settings.engines[preferred].enabled) throw new Error('当前默认生图模式尚未启用。');
    const server = getBuiltinImageMcpServers().find(item => item.enabled);
    if (!server) throw new Error('当前默认生图工具不可用。');
    return { server, toolName: preferred === 'gpt-image' ? 'generate_image' : 'novelai_generate_image' };
};

const parseToolArgs = (call: any): Record<string, any> => {
    const raw = call?.function?.arguments ?? call?.arguments;
    if (typeof raw === 'string') {
        try { return raw.trim() ? JSON.parse(raw) : {}; }
        catch { throw new Error('剧情配图规划器返回了无法解析的工具参数'); }
    }
    return raw && typeof raw === 'object' ? raw : {};
};

const buildPlannerInstruction = (input: GenerateStoryImageInput, toolName: string): string => {
    const config = input.entry.imageGeneration;
    const actorAnchors = input.actors.map(actor => `${actor.name}：${compact(config?.characterAnchors?.[actor.id]) || '根据正文与角色设定保持外貌一致'}`).join('\n');
    const transcript = input.messages.slice(-8).map(message => `${message.role === 'user' ? input.userName : '剧场正文'}：${compact(message.content).slice(0, 1800)}`).join('\n\n');
    return `你正在后台为剧情剧场生成一张本轮插图，不是在回复聊天。必须调用 ${toolName}，不要只输出文字。

剧情：${input.entry.title}
前提：${compact(input.entry.premise) || '沿用正文'}
当前身份 ${input.userName}：${compact(config?.userAnchor) || '根据正文保持一致'}
出场角色：
${actorAnchors}

最近剧情：
${transcript}

画面要求：只画最新一轮最有表现力的具体瞬间；保持人物数量、身份、动作、服装、地点与情绪一致；构图完整、有叙事感；不要文字、对白框、水印、Logo 或 UI。${config?.stylePrompt ? `\n额外画风：${config.stylePrompt}` : ''}${config?.negativePrompt ? `\n避免内容：${config.negativePrompt}` : ''}
目标画幅：${config?.width || 1216}×${config?.height || 832}。请按工具 schema 填写最接近的尺寸和参数，并直接调用工具。`;
};

export async function generateStoryTheaterImage(input: GenerateStoryImageInput): Promise<StoryTheaterImageFrame> {
    if (!input.actors.length) throw new Error('剧情没有可用于配图的出场角色。');
    const selected = resolveImageTool();
    const toolDef = (selected.server.tools || []).find(tool => tool.name === selected.toolName);
    if (!toolDef) throw new Error('默认生图工具缺少已发现的参数定义。');
    const exposedName = selected.toolName.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
    const body = {
        model: input.apiConfig.model,
        messages: [{ role: 'system', content: buildPlannerInstruction(input, selected.toolName) }, { role: 'user', content: '请为上面最新一轮剧情生成插图。' }],
        tools: [{ type: 'function', function: { name: exposedName, description: toolDef.description || 'Generate a story illustration.', parameters: augmentImageToolSchema(toolDef.inputSchema || { type: 'object', properties: {} }, selected.toolName) } }],
        tool_choice: 'required',
        temperature: 0.4,
        max_tokens: 3000,
        stream: false,
    };
    const response = await executeOpenAiChatPlan({
        plan: resolveApiExecutionPlan('chat', input.apiConfig, true),
        body,
        meta: { appName: '剧情剧场', purpose: '剧情自动配图规划' },
        directMaxRetries: 1,
    });
    const message = response.value?.choices?.[0]?.message || {};
    const nativeCalls = normalizeToolCallsForCompat(message.tool_calls, 'story-theater-image');
    const native = nativeCalls.find((call: any) => call?.function?.name === exposedName || call?.function?.name === selected.toolName);
    let rawArgs: Record<string, any> | null = native ? parseToolArgs(native) : null;
    if (!rawArgs) {
        const tools = new Map<string, ResolvedMcpTool>([[exposedName, { server: selected.server, toolName: selected.toolName, executionPolicy: 'single-shot' }]]);
        rawArgs = extractTextFakedMcpCalls(String(message.content || ''), tools)[0]?.args || null;
    }
    if (!rawArgs) throw new Error('剧情配图规划器没有调用生图工具。');
    const preparedArgs = await prepareBuiltinImageToolArguments({ server: selected.server, toolName: selected.toolName, args: rawArgs, character: input.actors[0], userProfile: input.userProfile });
    const result = await callMcpTool(selected.server, selected.toolName, preparedArgs);
    if (!result.success) throw new Error(result.error || '剧情配图生成失败');
    const galleryOwner: CharacterProfile = { ...input.actors[0], id: storyTheaterThreadId(input.entry.id), name: input.entry.title || '剧情剧场' };
    const outcome = await persistMcpGeneratedImages({
        result,
        char: galleryOwner,
        server: { id: selected.server.id, name: selected.server.name },
        toolName: selected.toolName,
        toolArgs: preparedArgs,
        recentMessages: input.messages.slice(-8),
        ownerType: 'meeting-cg',
        allowTemporaryUrlFallback: false,
        extraGallerySourceMeta: { source: 'story-theater', theaterId: input.entry.id, theaterTitle: input.entry.title },
    });
    const asset = outcome.assets[0];
    if (!asset) throw new Error(outcome.errors[0] || '剧情配图保存到本机与相册失败');
    return { imageRef: asset.blobRef, galleryImageId: asset.galleryImageId, prompt: asset.prompt, engine: asset.engine, generatedAt: asset.createdAt };
}
