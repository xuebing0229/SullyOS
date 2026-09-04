from pathlib import Path

root = Path.cwd()


def parse_conflicts(text: str):
    out = []
    pos = 0
    while True:
        a = text.find('<<<<<<< HEAD', pos)
        if a < 0:
            break
        sep = text.find('\n=======', a)
        end = text.find('\n>>>>>>> upstream/master', sep)
        if sep < 0 or end < 0:
            raise RuntimeError('Malformed Git conflict markers')
        block_end = text.find('\n', end + 1)
        if block_end < 0:
            block_end = len(text)
        ours_start = text.find('\n', a) + 1
        theirs_start = sep + len('\n=======') + 1
        out.append((a, block_end + 1 if block_end < len(text) else block_end, text[ours_start:sep], text[theirs_start:end]))
        pos = block_end
    return out


def resolve(rel: str, chooser):
    path = root / rel
    text = path.read_text()
    conflicts = parse_conflicts(text)
    if not conflicts:
        raise RuntimeError(f'Expected conflict not found: {rel}')
    pieces = []
    pos = 0
    for idx, (a, b, ours, theirs) in enumerate(conflicts, 1):
        pieces.append(text[pos:a])
        pieces.append(chooser(idx, ours, theirs))
        pos = b
    pieces.append(text[pos:])
    result = ''.join(pieces)
    if not result.endswith('\n'):
        result += '\n'
    path.write_text(result)


resolve('apps/Chat.tsx', lambda i, o, t: (
    o + '\n' + t if i == 1 else
    "            'meetup', 'proactive', 'active-msg-2', 'schedule', 'mcd-request', 'luckin-request', 'vibe-reference',\n"
    "            'html-mode-toggle', 'html-mode-settings', 'thinking-settings', 'favorites', 'collaboration',\n"
))

resolve('apps/Settings.tsx', lambda i, o, t: (
    o + '\n' + t if i == 1 else
    o + '\n        {/* 通用 MCP 管理由新版 McpConnectionConsole 提供，独立于实时感知。 */}\n'
))


def chat_input(i, o, t):
    if i == 1:
        return "import { ShareNetwork, Trash, Plus, Smiley, PaperPlaneTilt, Money, BookOpenText, GearSix, Image, Lock, ArrowsClockwise, ChatCircleDots, CalendarBlank, ForkKnife, Coffee, Code, Brain, PencilSimple, BellSimpleRinging, Alarm, Sparkle, CaretDown, FadersHorizontal, LinkSimple, Palette, Star, Briefcase } from '@phosphor-icons/react';\n"
    if i == 2:
        return ''
    if i == 3:
        return '''                           {/* Page 2: 承接继续顺延的普通功能项。 */}
                          <div className={`${actionsPage === 2 ? 'flex' : 'hidden'} min-h-[13rem] px-6 py-5 flex-col items-center justify-center text-center`}>
                             <div className="w-full grid grid-cols-4 gap-8 mb-4">
                            <button onClick={() => chatImageInputRef.current?.click()} className={`flex flex-col items-center gap-2 active:scale-95 transition-transform ${acnh ? 'text-[#725d42]' : isDiscordStyle ? 'text-slate-200' : 'text-slate-600'}`}>
                                {acnh ? <AcnhActionTile kind="image" /> : (
                                <div className={`w-14 h-14 rounded-2xl flex items-center justify-center shadow-sm border ${isDiscordStyle ? 'bg-slate-800 text-pink-300 border-pink-400/20' : 'bg-pink-50 text-pink-400 border-pink-100'}`}>
                                    <Image className="w-6 h-6" weight="bold" />
                                </div>)}
                                <span className="text-xs font-bold">相册</span>
                            </button>
                            <input type="file" ref={chatImageInputRef} className="hidden" accept="image/*" onChange={(e) => handleImageChange(e, 'chat')} />

                            <button onClick={() => onPanelAction('vibe-reference')} className={`flex flex-col items-center gap-2 active:scale-95 transition-transform relative ${acnh ? 'text-[#725d42]' : isDiscordStyle ? 'text-slate-200' : 'text-slate-600'}`}>
                                <div className={`w-14 h-14 rounded-2xl flex items-center justify-center shadow-sm border ${vibeReferenceActive ? (isDiscordStyle ? 'bg-violet-500/20 text-violet-300 border-violet-400/40' : 'bg-violet-100 text-violet-600 border-violet-300') : (isDiscordStyle ? 'bg-slate-800 text-violet-300 border-violet-400/20' : 'bg-violet-50 text-violet-500 border-violet-100')}`}>
                                    <Palette className="w-6 h-6" weight="bold" />
                                </div>
                                <span className="text-xs font-bold">Vibe 图库</span>
                                {vibeReferenceActive && <span className={`absolute top-0 right-1 w-2.5 h-2.5 rounded-full border-2 ${isDiscordStyle ? 'bg-violet-400 border-slate-900' : 'bg-violet-500 border-white'}`} />}
                            </button>

'''
    raise AssertionError(i)


resolve('components/chat/ChatInputArea.tsx', chat_input)
resolve('components/chat/ChatModals.tsx', lambda i, o, t: o + '\n' + t)
resolve('components/date/DateSession.tsx', lambda i, o, t: (
    o + '\n' + t if i == 1 else
    '''    const translateAndSpeak = async (
        text: string,
        emotion?: string,
        archive?: { sourceKey?: string; sourceTimestamp?: number },
    ): Promise<DateSpeechResult | null> => {
'''
))


def story(i, o, t):
    if i != 1:
        raise AssertionError(i)
    return '''            nativeCompletionReceived = usedNativeBackground;
            const rawContent = prefill && !generated.startsWith(prefill) ? `${prefill}${generated}` : generated;
            const previousAssistantContent = [...history].reverse().find(message => message.role === 'assistant')?.content || '';
            const content = affinityEnabled
                ? reconcileStoryAffinityScores(
                    rawContent,
                    previousAssistantContent,
                    affinityInputs,
                    actors.map(actor => ({ id: actor.id, name: actor.name })),
                )
                : rawContent;
            const rowsBeforeCommit = (await DB.getMessagesByCharId(threadId, true))
                .filter(message => message.metadata?.source === 'story_theater')
                .sort((a, b) => a.id - b.id);
            const duplicateAssistant = rowsBeforeCommit.find(message =>
                message.role === 'assistant'
                && message.metadata?.theaterRequestKey === activeRequestKey
                && message.id !== rerollTarget?.id
            );
            let didCommitAssistant = false;
            let assistantMessageId: number;
            if (duplicateAssistant) {
                assistantMessageId = duplicateAssistant.id;
                console.warn('[StoryTheater] duplicate completion discarded', { requestKey: activeRequestKey, messageId: duplicateAssistant.id });
            } else {
                if (isReroll && rerollTarget) {
                    const mirrorIds = Object.values((rerollTarget.metadata?.theaterMirrorIds || {}) as Record<string, number>).map(Number).filter(Boolean);
                    await DB.deleteMessages([rerollTarget.id, ...mirrorIds]);
                }
                assistantMessageId = await saveCentralAndMirrors('assistant', content, {
                    theaterPromptTokens: promptTokenCount,
                    theaterPromptTokensExact: promptTokenCountExact,
                    theaterRequestKey: activeRequestKey,
                    ...(affinityInputs.length > 0 ? { theaterAffinityInputs: affinityInputs } : {}),
                });
                didCommitAssistant = true;
'''


resolve('components/date/story/StoryTheaterSession.tsx', story)
resolve('types.ts', lambda i, o, t:
    "export type MessageType = 'text' | 'image' | 'emoji' | 'voice' | 'collaboration_file' | 'interaction' | 'transfer' | 'system' | 'social_card' | 'chat_forward' | 'xhs_card' | 'score_card' | 'music_card' | 'mcd_card' | 'luckin_card' | 'html_card' | 'news_card' | 'vr_card' | 'trpg_card' | 'novel_card' | 'world_card' | 'sim_card' | 'phone_card' | 'webpage_card' | 'theater_card' | 'room_card' | 'life_card' | 'group_topic_card' | 'app_memory_card';\n"
)
resolve('utils/activeMsgRuntime.ts', lambda i, o, t: t.replace('还欠着回复时，把下一跳点名排到 60s 后；', '还欠着回复时，把下一跳账本补收排到短间隔后；'))
resolve('utils/amsgBundleVersion.ts', lambda i, o, t: o)
resolve('utils/applyAssistantPostProcessing.ts', lambda i, o, t: o + '\n' + t)


def payload(i, o, t):
    if i == 1:
        return '''    fullMessages: ChatPayloadMessage[];
    /** fullMessages 里易变尾段 system 的下标；动态块用它插到钢印之前。-1 表示没有。 */
    volatileTailIndex: number;
'''
    if i == 2:
        return '''            cleanedApiMessages: requestMessages,
            fullMessages: requestMessages,
            volatileTailIndex: -1,
'''
    raise AssertionError(i)


resolve('utils/chatRequestPayload.ts', payload)
resolve('utils/mcpClient.test.ts', lambda i, o, t: t)
test_path = root / 'utils/mcpClient.test.ts'
test = test_path.read_text()
test = test.replace('    getMcpRequestTimeoutMs,\n    type McpServerConfig,', '    getMcpRequestTimeoutMs,\n    collectMcpFireServers,\n    hasWorkerUnreachableMcpServer,\n    type McpServerConfig,')
test = test.replace("import { buildMcpOpenAITools, buildMcpRejectedToolsFallbackBody, buildMcpSystemBlock, buildMcpTextFallbackBody, extractMcpImageUrls, formatMcpToolResult, MCP_RESULT_MAX_CHARS, sanitizeMcpLeadInText, shouldRetryMcpWithoutTools, stripTextFakedMcpCalls } from './mcpToolBridge';", "import { buildMcpOpenAITools, buildMcpRejectedToolsFallbackBody, buildMcpSystemBlock, buildMcpTextFallbackBody, extractMcpImageUrls, formatMcpToolResult, MCP_CHAT_MAX_STALLED_ROUNDS, MCP_CHAT_MAX_TOOL_LOOPS, MCP_RESULT_MAX_CHARS, MCP_TAIL_REMINDER, sanitizeMcpLeadInText, shouldRetryMcpWithoutTools, stripTextFakedMcpCalls } from './mcpToolBridge';")
test_path.write_text(test)

import subprocess
mcp = root / 'utils/mcpClient.ts'
s = subprocess.check_output(['git', 'show', ':3:utils/mcpClient.ts'], text=True)
s = s.replace("import {\n    callMcpToolCore,", "import { getBuiltinImageMcpServers } from './builtinImageMcp';\nimport {\n    callMcpToolCore,")
s = s.replace("    url: string;\n    /** Bearer Token", "    url: string;\n    /** 内置生图服务控制接口根地址；通用 MCP 不填写。 */\n    controlBaseUrl?: string;\n    /** Bearer Token")
s = s.replace("    charIds?: string[];\n    updatedAt: number;\n}", """    charIds?: string[];
    updatedAt: number;
    builtin?: boolean;
    imagePresetId?: string;
    imagePresetPurpose?: string;
    imagePresetEngineId?: 'gpt-image' | 'novelai';
    imagePresetAllowCharacterReference?: boolean;
    /** 只允许内置生图覆盖通用 MCP 的 60 秒单请求超时。 */
    requestTimeoutMs?: number;
}""")
s = s.replace("const MCP_USE_NATIVE_TOOLS_KEY = 'aetheros.mcp.useNativeTools';\n", """const MCP_USE_NATIVE_TOOLS_KEY = 'aetheros.mcp.useNativeTools';

export const getMcpRequestTimeoutMs = (
    server: Pick<McpServerConfig, 'id' | 'builtin' | 'requestTimeoutMs'>,
): number => {
    const configured = server.requestTimeoutMs;
    const isBuiltinImage = server.builtin === true && server.id.startsWith('builtin_image_');
    return isBuiltinImage && Number.isFinite(configured) && configured! > 0
        ? Math.round(configured!)
        : MCP_REQUEST_TIMEOUT_MS;
};
""")
s = s.replace("export const getEnabledMcpServers = (charId?: string): McpServerConfig[] =>\n    loadMcpServers().filter(s =>", "export const getEnabledMcpServers = (charId?: string): McpServerConfig[] =>\n    [...getBuiltinImageMcpServers(), ...loadMcpServers()].filter(s =>")
s = s.replace("return discoverMcpToolsCore(targetFor(server), getSession(server.id), MCP_REQUEST_TIMEOUT_MS, { onStage });", "return discoverMcpToolsCore(targetFor(server), getSession(server.id), getMcpRequestTimeoutMs(server), { onStage });")
s = s.replace("        serverLabel: server.name,\n    });", "        serverLabel: server.name,\n        timeoutMs: getMcpRequestTimeoutMs(server),\n    });")
mcp.write_text(s if s.endswith('\n') else s + '\n')

core_path = root / 'utils/mcpFireCore.ts'
core = core_path.read_text()
core = core.replace("""export interface McpToolResult {
    success: boolean;
    data?: any;
    rawText?: string;
    error?: string;
}""", """export interface McpImageContent {
    data: string;
    mimeType: string;
}

export interface McpToolResult {
    success: boolean;
    data?: any;
    rawText?: string;
    error?: string;
    content?: any[];
    structuredContent?: any;
    images?: McpImageContent[];
    rawResult?: any;
}""")
start = core.index('export const callMcpToolCore = async (')
end = core.index('/** worker 直连的请求头', start)
core_call = r'''export const callMcpToolCore = async (
    target: McpTransportTarget,
    session: McpSessionState,
    toolName: string,
    args: Record<string, any> = {},
    opts: { timeoutMs?: number; inputSchema?: any; serverLabel?: string } = {},
): Promise<McpToolResult> => {
    const timeoutMs = opts.timeoutMs ?? MCP_REQUEST_TIMEOUT_MS;
    const normalizedArgs = normalizeMcpToolArguments(args, opts.inputSchema);
    const finish = (result: McpToolResult): McpToolResult => {
        let resultPreview = '';
        if (result.success) {
            try { resultPreview = JSON.stringify(result.data).slice(0, 800); }
            catch { resultPreview = String(result.data).slice(0, 800); }
        }
        console.info('🔌 [MCP] tools/call 完成', {
            server: opts.serverLabel ?? targetHost(target.url), tool: toolName,
            args: normalizedArgs, success: result.success,
            ...(result.success ? { result: resultPreview } : { error: result.error }),
        });
        return result;
    };
    try {
        await ensureInitializedCore(target, session, timeoutMs);
        const body = buildRpcRequest(session, 'tools/call', { name: toolName, arguments: normalizedArgs });
        let response: McpJsonRpcResponse | null;
        try {
            ({ response } = await postCore(target, session, body, timeoutMs));
        } catch (e: any) {
            if (/HTTP (400|404)/.test(e?.message || '')) {
                Object.assign(session, createMcpSessionState());
                await ensureInitializedCore(target, session, timeoutMs);
                ({ response } = await postCore(target, session, buildRpcRequest(session, 'tools/call', { name: toolName, arguments: normalizedArgs }), timeoutMs));
            } else throw e;
        }
        if (!response) return finish({ success: false, error: '空响应' });
        if (response.error) return finish({ success: false, error: `MCP 错误 [${response.error.code}]: ${response.error.message}` });
        const result = response.result ?? response;
        if (result?.resultType === 'input_required') return finish({ success: false, error: '这个工具需要在执行途中补充确认或输入；SullyOS 当前不会替你自动回答，请回到聊天中明确要求后重试。', data: result, rawResult: result });
        const content = Array.isArray(result?.content) ? result.content : [];
        const rawText = content.filter((part: any) => part?.type === 'text' && typeof part.text === 'string').map((part: any) => part.text).join('\n').trim();
        let parsedText: any = undefined;
        if (rawText) { try { parsedText = JSON.parse(rawText); } catch { parsedText = rawText; } }
        const structuredContent = result?.structuredContent;
        const images: McpImageContent[] = content.filter((part: any) => part?.type === 'image' && typeof part.data === 'string' && part.data.length > 0).map((part: any) => ({ data: part.data, mimeType: typeof part.mimeType === 'string' && part.mimeType.startsWith('image/') ? part.mimeType : 'image/png' }));
        const modelData = parsedText !== undefined ? parsedText : structuredContent !== undefined ? structuredContent : content.length > 0 ? {} : result;
        const isError = result?.isError === true;
        return finish({ success: !isError, data: modelData, rawText, error: isError ? (rawText || result?.error?.message || result?.message || 'MCP 工具返回错误') : undefined, content, structuredContent, images, rawResult: result });
    } catch (e: any) {
        return finish({ success: false, error: e?.message || String(e) });
    }
};

'''
core_path.write_text(core[:start] + core_call + core[end:])

format_fixes = {
    'apps/Chat.tsx': [("from '../utils/vibeReference';import type", "from '../utils/vibeReference';\nimport type")],
    'apps/Settings.tsx': [("from '../components/settings/OrphanImageCleanupCard';import McpConnectionConsole", "from '../components/settings/OrphanImageCleanupCard';\nimport McpConnectionConsole"), ("from '../components/settings/McpConnectionConsole';import { DB", "from '../components/settings/McpConnectionConsole';\nimport { DB")],
    'components/chat/ChatModals.tsx': [("from '../os/TokenImg';import { trackEvent", "from '../os/TokenImg';\nimport { trackEvent")],
    'components/date/DateSession.tsx': [("from '../os/TokenImg';import { VOICE_LANGUAGE_OPTIONS", "from '../os/TokenImg';\nimport { VOICE_LANGUAGE_OPTIONS")],
    'utils/applyAssistantPostProcessing.ts': [("from './assistantDisplayPipeline';import { stripLeakedSourceTags", "from './assistantDisplayPipeline';\nimport { stripLeakedSourceTags")],
    'utils/activeMsgRuntime.ts': [("排到短间隔后；一条都不欠就直接撤掉定时器。 *\n * 每次", "排到短间隔后；一条都不欠就直接撤掉定时器。\n *\n * 每次")],
}
for rel, replacements in format_fixes.items():
    p = root / rel
    text = p.read_text()
    for old, new in replacements:
        text = text.replace(old, new)
    p.write_text(text if text.endswith('\n') else text + '\n')

story_path = root / 'components/date/story/StoryTheaterSession.tsx'
story_text = story_path.read_text()
story_text = story_text.replace("                didCommitAssistant = true;\n            }\n            }\n            if (!isReroll", "                didCommitAssistant = true;\n            }\n            if (!isReroll", 1)
story_path.write_text(story_text)

remaining = []
for path in root.rglob('*'):
    if path.is_file() and path.suffix in {'.ts', '.tsx', '.js', '.mjs'}:
        try:
            if '<<<<<<< HEAD' in path.read_text():
                remaining.append(str(path.relative_to(root)))
        except UnicodeDecodeError:
            pass
if remaining:
    raise RuntimeError(f'Unresolved conflicts: {remaining}')
print('resolved all upstream conflicts')
