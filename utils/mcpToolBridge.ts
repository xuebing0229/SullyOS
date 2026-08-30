/**
 * 通用 MCP → 聊天工具循环 的桥接层（对标 luckinToolBridge 的角色分工）
 *
 * 职责：
 * 1. 把所有启用 MCP 服务器的已发现工具聚合成 OpenAI function-calling 格式
 * 2. 生成注入 systemPrompt 的说明块与尾部提醒
 * 3. 中转不认 function calling 时的兼容兜底（降级请求体、前置气泡粗洗）
 * 重名映射和正文假调用解析住在 mcpFireCore（浏览器与 amsg worker 共用）。
 * 工具循环本体在 hooks/useChatAI.ts（对标 luckinChat 循环）。
 */

import { getEnabledMcpServers, type McpServerConfig, type McpToolDef, type McpToolResult } from './mcpClient';
import { resolveMcpExecutionPolicy, type McpExecutionPolicy } from './mcpExecutionPolicy';
import { augmentImageToolSchema } from './imageToolPostAction';
import {
    getCharacterAutoImageMcpServers,
} from './imageGenerationPresets';

export interface OpenAIMcpTool {
    type: 'function';
    function: {
        name: string;
        description?: string;
        parameters?: any;
    };
}

export interface ResolvedMcpTool {
    server: McpServerConfig;
    toolName: string;
    executionPolicy: McpExecutionPolicy;
}

/** 多步工具任务沿用上游循环预算；single-shot 生图仍由 executionPolicy 提前收束。 */
export const MCP_CHAT_MAX_TOOL_LOOPS = 12;
export const MCP_CHAT_MAX_STALLED_ROUNDS = 2;

const sanitizeToolName = (name: string): string =>
    (name || 'tool').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64) || 'tool';
const serverSlug = (server: McpServerConfig): string => server.imagePresetId
    ? sanitizeToolName(`preset_${server.imagePresetId.slice(-10)}`).slice(0, 20)
    : sanitizeToolName(server.name).slice(0, 20) || 'srv';

const isBuiltinImageServer = (server: McpServerConfig): boolean =>
    server.builtin === true && server.id.startsWith('builtin_image_');

export const getMcpServersForChat = (charId?: string): McpServerConfig[] => {
    const regular = getEnabledMcpServers(charId);
    const autoPresetServers = getCharacterAutoImageMcpServers();
    if (!autoPresetServers.length) return regular;
    // 只有“当前手动选中的引擎 = NovelAI 且 NovelAI 预设 = 角色决定”时，
    // 才用多个 NovelAI 预设工具替换那一个固定 NovelAI 内置工具。
    // GPT 永远由 preferredEngine 决定，不进入角色预设选择。
    const nonBuiltinImages = regular.filter(server => !isBuiltinImageServer(server));
    return [...autoPresetServers, ...nonBuiltinImages];
};

export const hasMcpToolsForChat = (charId?: string): boolean =>
    getMcpServersForChat(charId).length > 0;

/**
 * 聚合启用服务器的工具，返回 OpenAI 工具数组 + 暴露名→真实工具 的映射。
 * 暴露名（含重名前缀、非法字符替换）统一由 mcpFireCore.buildMcpNameMap 算，
 * 保证前台聊天和 amsg worker 后台 fire 看到的是同一套工具名。
 * charId：只聚合对该角色可见的服务器（通用 + 绑定了该角色的）。
 */
export const buildMcpOpenAITools = (
    charId?: string,
    options: { allowCharacterReference?: boolean } = {},
): { tools: OpenAIMcpTool[]; resolve: Map<string, ResolvedMcpTool> } => {
    const servers = getMcpServersForChat(charId);
    const tools: OpenAIMcpTool[] = [];
    const resolve = new Map<string, ResolvedMcpTool>();
    for (const server of servers) {
        for (const t of server.tools || []) {
            let exposed = server.imagePresetId
                ? sanitizeToolName(`image_${server.imagePresetId.slice(-10)}_${t.name}`)
                : sanitizeToolName(t.name);
            if (resolve.has(exposed)) {
                exposed = sanitizeToolName(`${serverSlug(server)}_${t.name}`);
                let i = 2;
                while (resolve.has(exposed)) exposed = sanitizeToolName(`${serverSlug(server)}_${t.name}_${i++}`);
            }
            resolve.set(exposed, {
                server,
                toolName: t.name,
                executionPolicy: resolveMcpExecutionPolicy(server, t),
            });
            tools.push({
                type: 'function',
                function: {
                    name: exposed,
                    description: buildToolDescription(server, t, servers.length > 1),
                    parameters: resolveMcpExecutionPolicy(server, t) === 'single-shot'
                    ? augmentImageToolSchema(
                        t.inputSchema || { type: 'object', properties: {} },
                        t.name,
                        {
                            ...options,
                            allowCharacterReference: server.imagePresetId
                                ? server.imagePresetAllowCharacterReference !== false
                                : options.allowCharacterReference,
                        },
                    )
                    : (t.inputSchema || { type: 'object', properties: {} }),
                },
            });
        }
    }
    return { tools, resolve };
};

const buildToolDescription = (server: McpServerConfig, t: McpToolDef, multi: boolean): string => {
    const desc = (t.description || '').trim();
    if (server.imagePresetId) {
        const purpose = (server.imagePresetPurpose || '').trim();
        return [
            `[${server.name}]`,
            purpose ? `用途：${purpose}。` : '用途：用户尚未填写；请根据该预设名称与工具能力判断。',
            desc,
        ].filter(Boolean).join(' ');
    }
    // 多服务器时在描述里带上来源，帮模型区分同类工具
    return multi ? `[${server.name}] ${desc}` : desc;
};

// ========== 工具结果回填 ==========

/**
 * MCP 结果（记忆检索、网页抓取等）体量远超瑞幸商品列表，1500 字符会把一条
 * 完整结果拦腰截断。上限放到 20000 只防病态超长结果炸上下文——工具循环每轮
 * 会全量重发消息，真有兆级 JSON 混进来会直接 4xx 或 token 起飞。
 */
export const MCP_RESULT_MAX_CHARS = 20000;
export const formatMcpToolResult = (data: any): string => {
    let s: string;
    try { s = typeof data === 'string' ? data : JSON.stringify(data); } catch { s = String(data); }
    return s.length > MCP_RESULT_MAX_CHARS
        ? `${s.slice(0, MCP_RESULT_MAX_CHARS)}…[结果过长已截断, 全文共 ${s.length} 字符]`
        : s;
};

/** MCP 图片候选：可信结构化 URL 或标准 base64 图片。 */
export type McpImageCandidate =
    | { kind: 'url'; url: string; mimeType?: string; trusted: boolean }
    | { kind: 'base64'; data: string; mimeType: string; trusted: true };

const IMAGE_URL_EXT_RE = /\.(?:png|jpe?g|webp|gif|avif|bmp)(?:[?#].*)?$/i;
const HTTP_URL_RE = /^https?:\/\/[^\s<>"']+$/i;
const DATA_IMAGE_RE = /^data:(image\/[^;,]+);base64,(.+)$/i;

const isExplicitImageKey = (key: string): boolean =>
    /^(?:image|img|picture|photo)(?:_?url|_?uri|_?src)?$/i.test(key)
    || /^(?:imageUrl|imageURL|image_url|imageUri|image_uri)$/i.test(key);
const isImageMime = (value: unknown): value is string =>
    typeof value === 'string' && /^image\//i.test(value);

const candidateKey = (candidate: McpImageCandidate): string => candidate.kind === 'url'
    ? `url:${candidate.url}`
    : `b64:${candidate.mimeType}:${candidate.data.length}:${candidate.data.slice(0, 48)}:${candidate.data.slice(-48)}`;
export const getMcpImageCandidateKey = candidateKey;

const pushCandidate = (out: McpImageCandidate[], seen: Set<string>, candidate: McpImageCandidate): void => {
    const key = candidateKey(candidate);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(candidate);
};

const scanTextForConservativeUrls = (text: string, out: McpImageCandidate[], seen: Set<string>): void => {
    const markdownImageRe = /!\[[^\]]*]\((https?:\/\/[^)\s]+)\)/gi;
    let match: RegExpExecArray | null;
    while ((match = markdownImageRe.exec(text))) {
        pushCandidate(out, seen, { kind: 'url', url: match[1], trusted: true });
    }
    const urlRe = /https?:\/\/[^\s<>"')\]]+/gi;
    while ((match = urlRe.exec(text))) {
        const url = match[0].replace(/[.,;:!?]+$/, '');
        if (!IMAGE_URL_EXT_RE.test(url)) continue;
        pushCandidate(out, seen, { kind: 'url', url, trusted: false });
    }
};

const walkStructuredImageValues = (
    value: unknown,
    out: McpImageCandidate[],
    seenCandidates: Set<string>,
    visited: WeakSet<object>,
    keyHint = '',
    parentMime?: string,
): void => {
    if (typeof value === 'string') {
        const dataMatch = DATA_IMAGE_RE.exec(value);
        if (dataMatch) {
            pushCandidate(out, seenCandidates, { kind: 'base64', mimeType: dataMatch[1], data: dataMatch[2], trusted: true });
            return;
        }
        if (HTTP_URL_RE.test(value)) {
            const trusted = isExplicitImageKey(keyHint) || isImageMime(parentMime) || IMAGE_URL_EXT_RE.test(value);
            if (trusted) {
                pushCandidate(out, seenCandidates, {
                    kind: 'url', url: value,
                    mimeType: isImageMime(parentMime) ? parentMime : undefined,
                    trusted: isExplicitImageKey(keyHint) || isImageMime(parentMime),
                });
            }
            return;
        }
        scanTextForConservativeUrls(value, out, seenCandidates);
        return;
    }
    if (!value || typeof value !== 'object') return;
    if (value instanceof Blob || value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return;
    if (visited.has(value as object)) return;
    visited.add(value as object);
    if (Array.isArray(value)) {
        value.forEach(item => walkStructuredImageValues(item, out, seenCandidates, visited, keyHint, parentMime));
        return;
    }
    const record = value as Record<string, unknown>;
    const mime = (isImageMime(record.mimeType) && record.mimeType)
        || (isImageMime(record.mime_type) && record.mime_type)
        || (isImageMime(record.contentType) && record.contentType)
        || (isImageMime(record.content_type) && record.content_type)
        || parentMime;
    if (record.type === 'image' && typeof record.data === 'string' && record.data.length > 0) {
        pushCandidate(out, seenCandidates, { kind: 'base64', data: record.data, mimeType: mime || 'image/png', trusted: true });
    }
    for (const [key, child] of Object.entries(record)) {
        walkStructuredImageValues(child, out, seenCandidates, visited, key, mime);
    }
};

export function extractMcpImageCandidates(result: McpToolResult): McpImageCandidate[] {
    const out: McpImageCandidate[] = [];
    const seenCandidates = new Set<string>();
    for (const image of result.images || []) {
        pushCandidate(out, seenCandidates, { kind: 'base64', data: image.data, mimeType: image.mimeType || 'image/png', trusted: true });
    }
    const visited = new WeakSet<object>();
    if (result.structuredContent !== undefined) walkStructuredImageValues(result.structuredContent, out, seenCandidates, visited);
    if (result.data !== undefined) walkStructuredImageValues(result.data, out, seenCandidates, visited);
    if (result.rawText) scanTextForConservativeUrls(result.rawText, out, seenCandidates);
    return out;
}

/** 旧接口保留给已有调用方。 */
export function extractMcpImageUrls(data: any): string[] {
    return extractMcpImageCandidates({ success: true, data, rawText: typeof data === 'string' ? data : undefined })
        .filter((candidate): candidate is Extract<McpImageCandidate, { kind: 'url' }> => candidate.kind === 'url')
        .map(candidate => candidate.url);
}

// ========== 提示词 ==========

/**
 * MCP 工具模式的 systemPrompt 说明块。
 * 与瑞幸不同：这里的工具是用户自配的、内容未知，所以只讲纪律，不讲业务流程。
 * charId：只列对该角色可见的服务器，与 buildMcpOpenAITools 的过滤保持一致。
 */
export interface NovelAiReferenceAvailability {
    character?: { enabled: boolean; sourceName?: string; type?: string };
    user?: { enabled: boolean; sourceName?: string; type?: string };
    allowCharacterReference?: boolean;
}

export const buildMcpSystemBlock = (
    userName: string = '用户',
    charId?: string,
    referenceAvailability?: NovelAiReferenceAvailability,
): string => {
    const servers = getMcpServersForChat(charId);
    if (!servers.length) return '';
    const lines = servers.map(s => {
        const names = (s.tools || []).map(t => t.name).join('、');
        const purpose = s.imagePresetId && s.imagePresetPurpose?.trim()
            ? `（用途：${s.imagePresetPurpose.trim()}）`
            : '';
        return `- ${s.name}${purpose}: ${names}`;
    });
    const hasGptImage = servers.some(s => (s.tools || []).some(t => t.name === 'generate_image'));
    const hasNovelAi = servers.some(s => (s.tools || []).some(t => t.name === 'novelai_generate_image'));
    const refLine = (label: string, value?: { enabled: boolean; sourceName?: string; type?: string }) => value?.enabled
        ? `- ${label}：已开启，可选${value.sourceName ? `（${value.sourceName}）` : ''}${value.type ? `，参照类型 ${value.type}` : ''}`
        : `- ${label}：未开启，不可用`;
    const characterReferenceAllowed = referenceAvailability?.allowCharacterReference !== false;
    const availableReferenceLines = [
        characterReferenceAllowed ? refLine('当前角色参考图', referenceAvailability?.character) : '',
        refLine(`${userName}的用户参考图`, referenceAvailability?.user),
    ].filter(Boolean).join('\n');
    const selectionRule = characterReferenceAllowed
        ? '- “已开启”仅表示可选，不代表必须发送。每次调用都根据画面中实际出现的人物决定：用 `use_character_reference` 和 `use_user_reference` 分别选择，可两张都不用、任选一张或两张都用。'
        : '- 用户参考图“已开启”仅表示可选，不代表必须发送。用 `use_user_reference` 决定本次是否选择；不要因为参考图可用就强行让用户入镜。';
    const autoPresetServers = servers.filter(server => Boolean(server.imagePresetId));
    const autoPresetRules = autoPresetServers.length ? `
**当前 NovelAI 预设模式：角色决定**:
- 生图引擎已经由用户在设置中手动选定为 NovelAI；你**不要在 GPT 与 NovelAI 之间做选择**。
- 上面每个“生图预设”工具都只是同一个 NovelAI 引擎下的不同保存预设；“用途”是用户亲手填写给你看的选择说明。
- 当你已经决定这轮要生图时，直接在**这一次主聊天的 function calling** 里选择最适合当前画面用途的那个 NovelAI 预设工具；不要先做一次额外判断请求。
- 一次只选一个 NovelAI 预设。用户明确点名某个预设时优先遵从；未点名时再按用途自行判断。
` : '';
    const referenceRules = hasNovelAi ? `
**NovelAI 本轮可选精密参照**:
${availableReferenceLines}
${selectionRule}
- 只为画面里需要保持外观的人选择参考图；不要因为参考图可用就强行让对应人物入镜。
` : '';
    const imageRules = hasGptImage || hasNovelAi ? `
**生图工具选择**:
${hasGptImage ? '- `generate_image`：自然语言、写实、海报、物品、风景、通用图片。' : ''}
${hasNovelAi ? '- `novelai_generate_image`：二次元、标签提示词、负面提示词、Seed/Steps/Guidance、NovelAI 风格控制。' : ''}
${autoPresetRules}
- 生图引擎由用户在设置中固定选择；只使用本轮实际提供给你的生图工具，不要自行在 GPT 与 NovelAI 之间切换。
- 生图工具同一轮只能调用一次。可选参数 after_generate_action：none 表示图片完成后直接结束；inspect 表示系统在最终图片真正完成后再把图片交给你看，并让你自然回应一小句。
- 默认使用 none。仅当用户明确要求看图后评价，或当前语境确实需要亲自看最终成图时才使用 inspect；不要为了显得更有互动感默认使用 inspect。
${referenceRules}
` : '';
    return `

---
[外部工具已接入 —— ${userName} 在设置里给你连了 MCP 工具服务器]

**核心**: 你还是原来的角色、原来的语气、原来的记忆。工具只是你顺手能用的能力，**每轮都要有角色化的文字**，别干巴巴报结果。

可用工具来源:
${lines.join('\n')}
${imageRules}
**使用纪律**:
- 需要时直接调工具（系统会自动执行并把结果给你），不需要时正常聊天，**别硬找理由调工具**。
- 用户明确要求完成游戏、论坛或其他多步任务时，先做必要检查，随后立刻调用能推进目标的动作工具；不要反复读取同一份说明或状态。执行动作后可以再次检查新状态，并继续到目标完成或工具明确失败。
- 工具必须通过系统的 function calling 接口发起，**绝对不要把工具名和参数写进聊天正文**（比如输出 \`工具名(参数)\` 这种文字），用户会看到乱码一样的东西。
- 工具结果只挑与对话相关的部分用角色语气转述，别整段复读 JSON。
- 工具失败就如实说，并根据报错调整参数重试或换个方式，别编造结果。
- 涉及真实世界副作用的操作（发布内容、下单、删除等），若 ${userName} 本轮已经明确要求执行，即视为已经确认；没有明确要求时才先确认一句再动手。
---
`;
};

/** 尾部小提醒（注入 messages 末尾，防长对话把纪律冲掉） */
export const MCP_TAIL_REMINDER = `[MCP 工具 ON · 永远用角色语气回复别空回; 工具只能走 function calling 接口、严禁写成正文文字; 工具结果别复读 JSON; 用户本轮已明确要求的操作视为已确认，否则副作用操作先确认]`;

// ========== 掉格式容错: 正文里的"假工具调用" ==========
//
// 不支持 function calling 的模型（或被中转剥了 tools 参数的）看到系统块里的
// 工具清单后, 会把调用直接"演"在正文里, 常见形态:
//   ask_question("SullyOS")           ← 括号传参
//   ask_question: SullyOS             ← 冒号传参（整行）
//   get_weather({"city": "上海"})     ← 括号传 JSON
// 与见面观测协议同款思路的两层容错: FC 通道是第一层, 这里兜第二层。
// 只认已启用服务器的真实工具名（暴露名/原名都认）, 避免误伤普通文字。

export interface FakedMcpCall {
    exposedName: string;
    server: McpServerConfig;
    toolName: string;
    executionPolicy: McpExecutionPolicy;
    args: Record<string, any>;
    matched: string;
}

/** 从正文兼容调用中剥掉调用语法，只留下可以先展示给用户的角色文字。 */
export const stripTextFakedMcpCalls = (content: string, calls: FakedMcpCall[]): string => {
    let cleaned = content;
    for (const call of calls) cleaned = cleaned.split(call.matched).join('');
    return cleaned.replace(/\n{3,}/g, '\n\n').trim();
};

/**
 * MCP 工具前置气泡专用粗洗。该气泡在统一后处理之前落库，必须自行清掉模型
 * 复刻的历史外壳和思考标签；不能把“用户发送了表情包”反向变成角色消息。
 */
export const sanitizeMcpLeadInText = (raw: string): string => {
    let cleaned = raw || '';
    cleaned = cleaned.replace(/<(think|thinking|thought)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
    cleaned = cleaned.replace(/<(?:think|thinking|thought)\b[^>]*>[\s\S]*$/gi, '');
    cleaned = cleaned.replace(/<\/?(?:think|thinking|thought)\b[^>]*>/gi, '');
    cleaned = cleaned.replace(/\[(?:你|User|用户|System)\s*发送了表情包[:：]\s*.*?\]/gi, '');
    cleaned = cleaned.replace(/\[\d{4}[-/年]\d{1,2}[-/月]\d{1,2}[^\]]*\]/g, '');
    cleaned = cleaned.replace(/\s*\[(?:聊天|通话|约会)\]\s*/g, '\n');
    return cleaned.replace(/\n{3,}/g, '\n\n').trim();
};

/**
 * 正文假调用已经由客户端代为执行，下一跳只负责把结果组织成角色回复。
 * 这里必须移除 tools；否则部分中转会在这一跳改走正规 tool_calls，返回空正文，
 * 而正规工具循环阶段已经结束，最终表现就是角色一直打字后不落消息。
 * 不支持 FC 的模型仍可继续输出正文假调用，并由同一兜底循环处理多步任务。
 */
export const buildMcpTextFallbackBody = (baseReqBody: any, messages: any[]): any => {
    const followBody = { ...baseReqBody, messages };
    delete followBody.tools;
    delete followBody.tool_choice;
    return followBody;
};

/** tools 被中转拒绝时，把最小 schema 仅作为本轮兼容说明交给正文调用兜底。 */
export const buildMcpRejectedToolsFallbackBody = (baseReqBody: any): any => {
    const followBody = buildMcpTextFallbackBody(baseReqBody, baseReqBody.messages || []);
    const toolSpecs = (baseReqBody.tools || []).map((tool: any) => {
        const fn = tool?.function || {};
        const schema = fn.parameters || {};
        const required = new Set(Array.isArray(schema.required) ? schema.required : []);
        const properties = Object.entries(schema.properties || {}).map(([name, def]: [string, any]) => ({
            name,
            type: def?.type || 'any',
            required: required.has(name),
            description: typeof def?.description === 'string' ? def.description.trim() : '',
            enum: Array.isArray(def?.enum) ? def.enum : undefined,
        }));
        return {
            name: fn.name,
            description: typeof fn.description === 'string' ? fn.description.trim() : '',
            properties,
        };
    }).filter((tool: any) => tool.name);
    const lines = toolSpecs.map((tool: any) => {
        const args = tool.properties.map((arg: any) =>
            `${arg.name}${arg.required ? '*' : ''}:${arg.type}${arg.enum ? `=${arg.enum.join('|')}` : ''}${arg.description ? `（${arg.description}）` : ''}`,
        );
        return `- ${tool.name}(${args.join(', ')})${tool.description ? `：${tool.description}` : ''}`;
    });
    const toolNames = new Set(toolSpecs.map((tool: any) => tool.name));
    const hasGptImage = toolNames.has('generate_image');
    const hasNovelAi = toolNames.has('novelai_generate_image');
    const imageSelectionLines = [
        hasGptImage ? '- generate_image：自然语言、写实、海报、物品、风景、通用图片。' : '',
        hasNovelAi ? '- novelai_generate_image：二次元、标签提示词、负面提示词、Seed/Steps/Guidance、NovelAI 风格控制。' : '',
        hasGptImage || hasNovelAi ? '- 用户明确指定 GPT 或 NovelAI 时必须遵从；未指定时按画面类型判断；不要同时调用两套引擎。' : '',
        hasGptImage || hasNovelAi ? '- 生图同轮只能调用一次；after_generate_action 默认 none，仅在确实需要看最终成图后回应时使用 inspect。' : '',
    ].filter(Boolean);
    const newline = String.fromCharCode(10);
    const imageSelectionRules = imageSelectionLines.length
        ? newline + '生图工具选择规则：' + newline + imageSelectionLines.join(newline)
        : '';
    const singleTool = toolSpecs.length === 1 ? toolSpecs[0] : null;
    const deterministicExample = singleTool
        ? `\n当用户明确要求使用 ${singleTool.name}，或用户意图与它的描述直接匹配时，你拥有并且必须使用它。请只输出一行：\n${singleTool.name}({${singleTool.properties.map((arg: any) => `"${arg.name}":${arg.required ? `"<${arg.description || arg.name}>"` : `"<可选>"`}`).join(',')}})`
        : '';
    followBody.messages = [...followBody.messages, {
        role: 'system',
        content: `[MCP 文字兼容模式已开启。注意：下列工具已经真实连接到客户端，你确实拥有这些工具；绝对不要回复“我没有工具”或“无法调用”。用户请求与某个工具匹配时，必须调用，不要改成口头描述。调用时只输出一行严格格式 tool_name({"参数":"值"})，不要加代码块、解释、道歉或其他文字；客户端会识别并执行。没有收到客户端返回前，不得声称成功。* 表示必填参数。\n${lines.join('\n')}${imageSelectionRules}${deterministicExample}]`,
    }];
    return followBody;
};

/** 部分 OpenAI 兼容中转不是忽略 tools，而是直接用 4xx 拒绝整次请求。 */
export const shouldRetryMcpWithoutTools = (error: unknown): boolean => {
    const message = error instanceof Error ? error.message : String(error || '');
    return /(?:^|\D)(?:400|401|403|422)(?:\D|$)/.test(message);
};

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

const stripQuotes = (s: string): string => {
    const t = s.trim();
    const m = t.match(/^(['"`「『])([\s\S]*)(['"`」』])$/);
    return m ? m[2] : t;
};

/** schema 的参数名顺序: required 优先, 其余按声明序 —— 用于位置参数落位 */
const positionalKeys = (schema: any): string[] => {
    const props = schema?.properties ? Object.keys(schema.properties) : [];
    const req = Array.isArray(schema?.required) ? schema.required.filter((k: string) => props.includes(k)) : [];
    return [...req, ...props.filter(k => !req.includes(k))];
};

const coerceBySchema = (value: string, schema: any, key: string): any => {
    const type = schema?.properties?.[key]?.type;
    const v = stripQuotes(value);
    if (type === 'number' || type === 'integer') {
        const n = Number(v);
        if (Number.isFinite(n)) return type === 'integer' ? Math.trunc(n) : n;
    }
    if (type === 'boolean') {
        if (/^(true|是|开)$/i.test(v)) return true;
        if (/^(false|否|关)$/i.test(v)) return false;
    }
    return v;
};

/** 顶层逗号切分（尊重引号与花括号嵌套） */
const splitTopLevel = (s: string): string[] => {
    const out: string[] = [];
    let depth = 0, cur = '', quote = '';
    for (const ch of s) {
        if (quote) {
            cur += ch;
            if (ch === quote) quote = '';
            continue;
        }
        if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
        if (ch === '{' || ch === '[') depth++;
        if (ch === '}' || ch === ']') depth--;
        if (ch === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
        cur += ch;
    }
    if (cur.trim()) out.push(cur);
    return out;
};

/** 把括号里的原始文本解析成 args 对象（JSON / kwargs / 位置参数三种形态） */
const parseFakedArgs = (inner: string, schema: any): Record<string, any> => {
    const t = inner.trim();
    if (!t) return {};
    // JSON 形态
    if (t.startsWith('{')) {
        try { return JSON.parse(t); } catch { /* 尝试宽松修复 */ }
        try {
            return JSON.parse(t
                .replace(/,\s*([}\]])/g, '$1')
                .replace(/'/g, '"')
                .replace(/([{,]\s*)([a-zA-Z_]\w*)\s*:/g, '$1"$2":'));
        } catch { /* 落回单参数 */ }
    }
    const parts = splitTopLevel(t);
    // kwargs 形态: key=value / key: value
    if (parts.every(p => /^\s*[A-Za-z_]\w*\s*[=:]/.test(p))) {
        const args: Record<string, any> = {};
        for (const p of parts) {
            const m = p.match(/^\s*([A-Za-z_]\w*)\s*[=:]\s*([\s\S]*)$/);
            if (m) args[m[1]] = coerceBySchema(m[2], schema, m[1]);
        }
        return args;
    }
    // 位置参数形态: 按 schema 声明顺序落位
    const keys = positionalKeys(schema);
    const args: Record<string, any> = {};
    parts.forEach((p, i) => {
        const key = keys[i];
        if (key) args[key] = coerceBySchema(p, schema, key);
    });
    return args;
};

/**
 * 从 AI 正文里提取"假工具调用"。只匹配 resolve 里已知的工具名（暴露名/真实名）。
 * 返回按出现位置排序、按 matched 文本去重的调用列表。
 */
export const extractTextFakedMcpCalls = (
    content: string,
    resolve: Map<string, ResolvedMcpTool>,
): FakedMcpCall[] => {
    if (!content || !resolve.size) return [];

    // 名字查找表: 暴露名和真实工具名都认（模型两种都可能写）
    const lookup = new Map<string, { exposed: string; hit: ResolvedMcpTool }>();
    for (const [exposed, hit] of resolve) {
        lookup.set(exposed, { exposed, hit });
        lookup.set(hit.toolName, { exposed, hit });
    }

    const found: Array<FakedMcpCall & { index: number }> = [];
    const seen = new Set<string>();

    for (const [name, { exposed, hit }] of lookup) {
        const schema = (hit.server.tools || []).find(t => t.name === hit.toolName)?.inputSchema;
        const esc = escapeRegExp(name);

        // 形态1: name(args) —— 前面不能是单词字符/点/斜杠（防止匹配到更长标识符的一部分）
        const parenRe = new RegExp(`(^|[^\\w./])${esc}\\s*\\(([^)]*)\\)`, 'g');
        for (const m of content.matchAll(parenRe)) {
            const matched = m[0].slice(m[1].length);
            const key = `${exposed}|${matched}`;
            if (seen.has(key)) continue;
            seen.add(key);
            found.push({
                exposedName: exposed,
                server: hit.server,
                toolName: hit.toolName,
                executionPolicy: hit.executionPolicy,
                args: parseFakedArgs(m[2], schema),
                matched,
                index: (m.index ?? 0) + m[1].length,
            });
        }

        // 形态2: 行首 name: 值 —— 限定行首, 避免误伤句中"提到"工具名的普通文字
        const colonRe = new RegExp(`(^|\\n)\\s*[>*-]*\\s*\`?${esc}\`?\\s*[:：]\\s*([^\\n]+)`, 'g');
        for (const m of content.matchAll(colonRe)) {
            const matched = m[0].slice(m[1].length);
            const key = `${exposed}|${matched.trim()}`;
            if (seen.has(key)) continue;
            seen.add(key);
            const keys = positionalKeys(schema);
            const value = stripQuotes(m[2].replace(/[。！？!?…\s]+$/, ''));
            found.push({
                exposedName: exposed,
                server: hit.server,
                toolName: hit.toolName,
                executionPolicy: hit.executionPolicy,
                args: keys.length ? { [keys[0]]: coerceBySchema(value, schema, keys[0]) } : {},
                matched,
                index: (m.index ?? 0) + m[1].length,
            });
        }
    }

    return found
        .sort((a, b) => a.index - b.index)
        .map(({ index: _index, ...call }) => call);
};
