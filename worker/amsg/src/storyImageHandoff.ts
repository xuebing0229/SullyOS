import { parseImageToolClientOptions } from '../../../utils/imageToolPostAction';
import {
  extractTextFakedMcpCalls,
  type McpFireServer,
  type McpResolvedToolCore,
} from '../../../utils/mcpFireCore';
import {
  normalizeNovelAiReferencePolicy,
  resolveNovelAiReferenceArguments,
  type NovelAiReferencePolicy,
} from '../../../utils/novelAiReferencePolicy';
import { normalizeToolCallsForCompat } from '../../../utils/toolCallCompat';

export interface StoryCloudImageReferenceFragments {
  actors?: Record<string, Record<string, unknown>>;
  user?: Record<string, unknown>;
  vibe?: Record<string, unknown>;
}

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
  referencePolicy?: NovelAiReferencePolicy;
  referenceErrors?: Record<string, string>;
  references?: StoryCloudImageReferenceFragments;
}

export interface StoryCloudImagePlannerSpec {
  baseUrl: string;
  apiKey: string;
  model: string;
  systemPrompt: string;
  tools: Array<{
    type: 'function';
    function: { name: string; description?: string; parameters?: Record<string, unknown> };
  }>;
}

export interface StoryCloudImageHandoffSpec {
  version: 1;
  tools: StoryCloudImageToolHandoff[];
  planner?: StoryCloudImagePlannerSpec;
}

export interface StoryCloudImageHandoffResult {
  state: 'submitted' | 'skipped' | 'failed';
  exposedTool?: string;
  toolName?: string;
  clientRequestId?: string;
  remoteJobId?: string;
  arguments?: Record<string, unknown>;
  /** 客户端专用动作，永远不进入生图服务 /jobs.arguments。 */
  afterGenerateAction?: 'none' | 'inspect';
  uncertain?: boolean;
  error?: string;
}

const INLINE_PLAN_OPEN = '<story_image_plan>';
const INLINE_PLAN_CLOSE = '</story_image_plan>';
const MAX_TOOLS = 16;
const HTTP_TIMEOUT_MS = 20_000;

const cleanBaseUrl = (value: unknown): string => String(value || '').trim().replace(/\/+$/, '');
const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value));
const cloneRecord = (value: Record<string, unknown>): Record<string, unknown> =>
  JSON.parse(JSON.stringify(value));

const normalizeFragment = (value: unknown): Record<string, unknown> | undefined =>
  isRecord(value) ? cloneRecord(value) : undefined;

export const normalizeStoryImageHandoffSpec = (value: unknown): StoryCloudImageHandoffSpec | undefined => {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.tools)) return undefined;
  const tools: StoryCloudImageToolHandoff[] = [];
  for (const rawTool of value.tools.slice(0, MAX_TOOLS)) {
    if (!isRecord(rawTool)) continue;
    const exposedName = String(rawTool.exposedName || '').trim();
    const toolName = String(rawTool.toolName || '').trim();
    const engineId = rawTool.engineId === 'novelai' ? 'novelai' : rawTool.engineId === 'gpt-image' ? 'gpt-image' : '';
    const controlBaseUrl = cleanBaseUrl(rawTool.controlBaseUrl);
    if (!exposedName || !toolName || !engineId || !/^https?:\/\//i.test(controlBaseUrl)) continue;

    const policyRaw = isRecord(rawTool.referencePolicy) ? rawTool.referencePolicy : undefined;
    // Old encrypted jobs did not carry policy. Keep them backward-compatible by defaulting to the
    // previous allow-all semantics; every newly built descriptor freezes the actually selected preset.
    const referencePolicy = engineId === 'novelai'
      ? normalizeNovelAiReferencePolicy(policyRaw ? {
          allowCharacterReference: policyRaw.allowCharacterReference !== false,
          allowUserReference: policyRaw.allowUserReference !== false,
          allowVibeReference: policyRaw.allowVibeReference !== false,
        } : undefined)
      : undefined;

    const referencesRaw = isRecord(rawTool.references) ? rawTool.references : undefined;
    const actorsRaw = referencesRaw && isRecord(referencesRaw.actors) ? referencesRaw.actors : undefined;
    const actors: Record<string, Record<string, unknown>> = {};
    if (actorsRaw && referencePolicy?.allowCharacterReference !== false) {
      for (const [actorId, fragment] of Object.entries(actorsRaw)) {
        if (actorId && isRecord(fragment)) actors[actorId] = cloneRecord(fragment);
      }
    }
    const user = referencePolicy?.allowUserReference === false
      ? undefined
      : normalizeFragment(referencesRaw?.user);
    const vibe = referencePolicy?.allowVibeReference === false
      ? undefined
      : normalizeFragment(referencesRaw?.vibe);
    const presetRaw = isRecord(rawTool.preset) ? rawTool.preset : undefined;
    const preset = presetRaw && isRecord(presetRaw.remoteConfig)
      ? {
          remoteConfig: cloneRecord(presetRaw.remoteConfig),
          apiKey: String(presetRaw.apiKey || ''),
        }
      : undefined;

    tools.push({
      exposedName,
      toolName,
      engineId,
      controlBaseUrl,
      token: String(rawTool.token || ''),
      ...(preset ? { preset } : {}),
      ...(referencePolicy ? { referencePolicy } : {}),
      ...(isRecord(rawTool.referenceErrors) ? {
        referenceErrors: Object.fromEntries(Object.entries(rawTool.referenceErrors)
          .filter(([, error]) => typeof error === 'string')
          .map(([slot, error]) => [slot, String(error).slice(0, 300)])),
      } : {}),
      ...(referencesRaw ? {
        references: {
          ...(Object.keys(actors).length ? { actors } : {}),
          ...(user ? { user } : {}),
          ...(vibe ? { vibe } : {}),
        },
      } : {}),
    });
  }
  const plannerRaw = isRecord(value.planner) ? value.planner : undefined;
  const plannerTools: StoryCloudImagePlannerSpec['tools'] = [];
  if (plannerRaw && Array.isArray(plannerRaw.tools)) {
    for (const rawPlannerTool of plannerRaw.tools.slice(0, MAX_TOOLS)) {
      if (!isRecord(rawPlannerTool) || rawPlannerTool.type !== 'function' || !isRecord(rawPlannerTool.function)) continue;
      const name = String(rawPlannerTool.function.name || '').trim();
      if (!name) continue;
      plannerTools.push({
        type: 'function',
        function: {
          name,
          ...(typeof rawPlannerTool.function.description === 'string'
            ? { description: rawPlannerTool.function.description.slice(0, 4000) }
            : {}),
          ...(isRecord(rawPlannerTool.function.parameters)
            ? { parameters: cloneRecord(rawPlannerTool.function.parameters) }
            : {}),
        },
      });
    }
  }
  const plannerBaseUrl = cleanBaseUrl(plannerRaw?.baseUrl);
  const plannerModel = String(plannerRaw?.model || '').trim();
  const plannerSystemPrompt = String(plannerRaw?.systemPrompt || '').trim();
  const planner = plannerRaw
    && /^https?:\/\//i.test(plannerBaseUrl)
    && plannerModel
    && plannerSystemPrompt
    && plannerTools.length
    ? {
        baseUrl: plannerBaseUrl,
        apiKey: String(plannerRaw.apiKey || ''),
        model: plannerModel,
        systemPrompt: plannerSystemPrompt.slice(0, 80_000),
        tools: plannerTools,
      }
    : undefined;

  return tools.length ? { version: 1, tools, ...(planner ? { planner } : {}) } : undefined;
};

const parseInlinePlan = (content: string): { tool: string; arguments: Record<string, unknown> } | null => {
  const openIndex = content.lastIndexOf(INLINE_PLAN_OPEN);
  if (openIndex < 0) return null;
  const closeIndex = content.indexOf(INLINE_PLAN_CLOSE, openIndex + INLINE_PLAN_OPEN.length);
  if (closeIndex < 0) return null;
  const raw = content.slice(openIndex + INLINE_PLAN_OPEN.length, closeIndex).trim();
  try {
    const parsed = JSON.parse(raw);
    if (!isRecord(parsed)) return null;
    const tool = String(parsed.tool || parsed.tool_name || '').trim();
    const args = parsed.arguments ?? parsed.args;
    return tool && isRecord(args) ? { tool, arguments: cloneRecord(args) } : null;
  } catch {
    return null;
  }
};

const fetchJson = async (
  url: string,
  token: string,
  init: RequestInit = {},
  timeoutMs = HTTP_TIMEOUT_MS,
): Promise<{ response: Response; body: any }> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = new Headers(init.headers || {});
    headers.set('Accept', 'application/json');
    if (token) headers.set('Authorization', `Bearer ${token}`);
    if (init.body !== undefined) headers.set('Content-Type', 'application/json');
    const response = await fetch(url, { ...init, headers, cache: 'no-store', signal: controller.signal });
    const text = await response.text();
    let body: any = null;
    if (text) {
      try { body = JSON.parse(text); }
      catch { body = { message: text.slice(0, 500) }; }
    }
    return { response, body };
  } finally {
    clearTimeout(timeout);
  }
};

const remoteError = (body: any, status: number): string =>
  String(body?.error?.message || body?.error || body?.message || `HTTP ${status}`).slice(0, 500);

const applyPreset = async (tool: StoryCloudImageToolHandoff): Promise<void> => {
  if (!tool.preset) return;
  const configUrl = `${tool.controlBaseUrl}/config`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const current = await fetchJson(configUrl, tool.token);
    if (!current.response.ok) throw new Error(`读取生图预设配置失败：${remoteError(current.body, current.response.status)}`);
    const revision = Number(current.body?.config?.revision ?? current.body?.revision);
    if (!Number.isFinite(revision)) throw new Error('生图服务没有返回可用 revision');
    const patched = await fetchJson(configUrl, tool.token, {
      // 与 App 侧 updateBuiltinImageRemoteConfig 保持同一份控制面契约。
      // 生图服务的 /config 更新接口是 PUT；PATCH 会让剧情云端 handoff 独有地应用预设失败。
      method: 'PUT',
      body: JSON.stringify({
        expectedRevision: revision,
        patch: tool.preset.remoteConfig,
        apiKey: tool.preset.apiKey,
      }),
    });
    if (patched.response.ok) return;
    if (patched.response.status !== 409 || attempt > 0) {
      throw new Error(`应用生图预设失败：${remoteError(patched.body, patched.response.status)}`);
    }
  }
};

const stripReferenceSelectorsForNonNovelAi = (
  rawArgs: Record<string, unknown>,
): Record<string, unknown> => {
  const args = cloneRecord(rawArgs);
  delete args.story_reference_actor_id;
  delete args.story_use_character_reference;
  delete args.story_use_user_reference;
  delete args.story_use_vibe_reference;
  delete args.use_character_reference;
  delete args.use_user_reference;
  delete args.use_vibe_reference;
  return args;
};

const mergeNovelAiReferences = (
  tool: StoryCloudImageToolHandoff,
  rawArgs: Record<string, unknown>,
): Record<string, unknown> => {
  if (tool.engineId !== 'novelai') return stripReferenceSelectorsForNonNovelAi(rawArgs);

  const requestedActorId = typeof rawArgs.story_reference_actor_id === 'string'
    ? rawArgs.story_reference_actor_id
    : '';
  const refs = tool.references;
  const actorFragment = refs?.actors
    ? ((requestedActorId && refs.actors[requestedActorId]) || Object.values(refs.actors)[0])
    : undefined;

  // This is the same pure resolver used by foreground prepareBuiltinImageToolArguments.
  // The planner may choose use_* switches, but selected-tool policy is authoritative and every
  // planner-supplied managed slot/strength/fidelity is stripped before trusted fragments are merged.
  return resolveNovelAiReferenceArguments({
    args: rawArgs,
    policy: tool.referencePolicy,
    references: {
      ...(actorFragment ? { character: actorFragment } : {}),
      ...(refs?.user ? { user: refs.user } : {}),
      ...(refs?.vibe ? { vibe: refs.vibe } : {}),
    },
  }).arguments;
};

const findExistingJob = async (
  tool: StoryCloudImageToolHandoff,
  clientRequestId: string,
): Promise<any | null> => {
  const { response, body } = await fetchJson(
    `${tool.controlBaseUrl}/jobs/by-client/${encodeURIComponent(clientRequestId)}`,
    tool.token,
  );
  if (response.ok) return body?.job || null;
  if (response.status === 404) return null;
  throw new Error(`查询生图后台任务失败：${remoteError(body, response.status)}`);
};

const stableImageClientRequestId = (storyClientRequestId: string): string => {
  const safe = String(storyClientRequestId || '').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 130);
  return `storyimg_${safe || 'unknown'}`;
};

/**
 * 纯本地计算“这轮图应该用哪个稳定 clientRequestId / 哪组最终参数”。
 * 不碰网络，所以正文 [DONE] 后可以先把这个占位 handoff 连同正文一起落库并立即让手机接回。
 * 手机和 Worker 随后谁先真正 POST /jobs 都只会使用同一个 clientRequestId，服务端幂等会合并成同一张图。
 */
const prepareStoryImageHandoffFromPlan = (
  spec: StoryCloudImageHandoffSpec,
  storyClientRequestId: string,
  plan: { tool: string; arguments: Record<string, unknown> },
): StoryCloudImageHandoffResult => {
  const tool = spec.tools.find(item => item.exposedName === plan.tool);
  if (!tool) return { state: 'failed', exposedTool: plan.tool, error: '配图规划器选择的生图工具已不可用' };
  return {
    state: 'submitted',
    exposedTool: tool.exposedName,
    toolName: tool.toolName,
    clientRequestId: stableImageClientRequestId(storyClientRequestId),
    arguments: mergeNovelAiReferences(tool, plan.arguments),
    uncertain: true,
  };
};

export const prepareStoryImageHandoff = (
  spec: StoryCloudImageHandoffSpec,
  storyClientRequestId: string,
  storyContent: string,
): StoryCloudImageHandoffResult => {
  const plan = parseInlinePlan(String(storyContent || ''));
  return plan
    ? prepareStoryImageHandoffFromPlan(spec, storyClientRequestId, plan)
    : { state: 'skipped' };
};

const parsePlannerArgs = (value: unknown): Record<string, unknown> | null => {
  if (isRecord(value)) return cloneRecord(value);
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value);
    return isRecord(parsed) ? cloneRecord(parsed) : null;
  } catch {
    return null;
  }
};

const parsePlannerText = (
  text: string,
  allowedNames: Set<string>,
): { tool: string; arguments: Record<string, unknown> } | null => {
  const clean = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  if (clean) {
    const first = clean.indexOf('{');
    const last = clean.lastIndexOf('}');
    if (first >= 0 && last > first) {
      try {
        const parsed = JSON.parse(clean.slice(first, last + 1));
        if (isRecord(parsed)) {
          const tool = String(parsed.tool || parsed.tool_name || parsed.name || '').trim();
          const args = parsePlannerArgs(parsed.arguments ?? parsed.args);
          if (tool && allowedNames.has(tool) && args) return { tool, arguments: args };
        }
      } catch { /* try shared text-call parser below */ }
    }
  }
  return null;
};

type PlannerTextResolve = Map<string, McpResolvedToolCore<McpFireServer>>;

const buildPlannerTextResolve = (
  plannerTools: StoryCloudImagePlannerSpec['tools'],
  allowedTools: StoryCloudImageToolHandoff[],
): PlannerTextResolve => {
  const resolve: PlannerTextResolve = new Map();
  const server: McpFireServer = {
    id: 'story-image-planner',
    name: '剧情配图规划器',
    url: 'https://story-image-planner.invalid',
    tools: [],
  };
  for (const plannerTool of plannerTools) {
    const exposedName = String(plannerTool.function.name || '').trim();
    if (!exposedName) continue;
    const handoff = allowedTools.find(tool => tool.exposedName === exposedName);
    const toolName = handoff?.toolName || exposedName;
    resolve.set(exposedName, {
      server,
      toolName,
      tool: {
        name: toolName,
        description: plannerTool.function.description,
        inputSchema: plannerTool.function.parameters || { type: 'object', properties: {} },
      },
    });
  }
  return resolve;
};

const plannerResponseShape = (body: any): Record<string, unknown> => {
  const choices = Array.isArray(body?.choices) ? body.choices : [];
  const message = choices[0]?.message || {};
  return {
    choiceCount: choices.length,
    toolCallCount: Array.isArray(message.tool_calls) ? message.tool_calls.length : 0,
    hasFunctionCall: Boolean(message.function_call),
    contentType: Array.isArray(message.content) ? 'array' : typeof message.content,
    contentLength: typeof message.content === 'string' ? message.content.length : 0,
  };
};

const extractPlannerSelection = (
  body: any,
  allowedNames: Set<string>,
  textResolve: PlannerTextResolve,
): { tool: string; arguments: Record<string, unknown> } | null => {
  const message = body?.choices?.[0]?.message || {};

  // 与旧 App 端剧情配图规划器复用同一份 Gemini/OpenAI tool_calls 规范化逻辑。
  const calls = normalizeToolCallsForCompat(message.tool_calls, 'story-theater-image');
  for (const call of calls) {
    const tool = String(call?.function?.name || call?.name || '').trim();
    if (!tool || !allowedNames.has(tool)) continue;
    const args = parsePlannerArgs(call?.function?.arguments ?? call?.arguments);
    if (args) return { tool, arguments: args };
  }

  // 兼容旧式 OpenAI function_call。
  const functionCall = message.function_call;
  if (functionCall) {
    const tool = String(functionCall.name || '').trim();
    const args = parsePlannerArgs(functionCall.arguments);
    if (tool && allowedNames.has(tool) && args) return { tool, arguments: args };
  }

  const content = String(message.content || '');

  // 先复用旧 App/主聊天已经吃过大量站子格式的“正文假工具调用”解析器：
  // exposedName / 原始 toolName、括号 JSON、kwargs、位置参数、冒号形式都沿用同一套规则。
  const faked = extractTextFakedMcpCalls(content, textResolve)[0];
  if (faked) return { tool: faked.exposedName, arguments: cloneRecord(faked.args) };

  // Worker 原有的 {"tool":"...","arguments":{...}} 兼容返回继续保留。
  return parsePlannerText(content, allowedNames);
};

const buildNativeRepairBody = (nativeBody: Record<string, unknown>): Record<string, unknown> => ({
  ...nativeBody,
  temperature: 0,
  parallel_tool_calls: false,
  messages: [
    ...((nativeBody.messages as unknown[]) || []),
    {
      role: 'system',
      content: '纠错重试：上一轮没有返回可执行的 tool_calls。你现在必须调用且只能调用一个本轮提供的生图工具；禁止只输出文字，禁止返回空白，禁止同时调用多个工具。',
    },
  ],
});

const runSeparatePlanner = async (
  planner: StoryCloudImagePlannerSpec,
  allowedTools: StoryCloudImageToolHandoff[],
  storyContent: string,
): Promise<{ tool: string; arguments: Record<string, unknown> }> => {
  const allowedNames = new Set(allowedTools.map(tool => tool.exposedName));
  const plannerTools = planner.tools.filter(tool => allowedNames.has(tool.function.name));
  if (!plannerTools.length) throw new Error('配图规划器没有可用生图工具');
  const textResolve = buildPlannerTextResolve(plannerTools, allowedTools);
  const latestStory = String(storyContent || '').slice(-24_000);
  const systemPrompt = `${planner.systemPrompt}\n\n【刚完成的最新一轮正文——以这一段作为画面最高优先级】\n${latestStory}`;
  const url = `${cleanBaseUrl(planner.baseUrl)}/chat/completions`;
  const nativeBody = {
    model: planner.model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: '请为刚完成的最新一轮剧情生成插图。必须选择并调用一个生图工具。' },
    ],
    tools: plannerTools,
    tool_choice: plannerTools.length === 1
      ? { type: 'function', function: { name: plannerTools[0].function.name } }
      : 'required',
    parallel_tool_calls: false,
    temperature: 0.4,
    max_tokens: 3000,
    stream: false,
  };

  let native: { response: Response; body: any };
  try {
    native = await fetchJson(url, planner.apiKey, {
      method: 'POST',
      body: JSON.stringify(nativeBody),
    }, 90_000);
  } catch (error) {
    throw new Error(`配图规划器请求失败：${String((error as Error)?.message || error).slice(0, 500)}`);
  }

  if (native.response.ok) {
    const selection = extractPlannerSelection(native.body, allowedNames, textResolve);
    if (selection) return selection;

    console.warn('[StoryImageHandoff] image planner omitted executable tool call; retrying native planner once', {
      plannerModel: planner.model,
      toolCount: plannerTools.length,
      response: plannerResponseShape(native.body),
    });

    // 旧 App 端的成熟行为：原生 tools 请求成功但模型漏调工具时，第二次仍使用原生 tools
    // 做纠错，而不是擅自切成另一套 JSON 协议。这样前台/后台看到同一种模型返回时行为一致。
    let repair: { response: Response; body: any };
    try {
      repair = await fetchJson(url, planner.apiKey, {
        method: 'POST',
        body: JSON.stringify(buildNativeRepairBody(nativeBody)),
      }, 90_000);
    } catch (error) {
      throw new Error(`配图规划器纠错重试失败：${String((error as Error)?.message || error).slice(0, 500)}`);
    }
    if (!repair.response.ok) {
      throw new Error(`配图规划器纠错重试失败：${remoteError(repair.body, repair.response.status)}`);
    }
    const repaired = extractPlannerSelection(repair.body, allowedNames, textResolve);
    if (repaired) return repaired;

    console.warn('[StoryImageHandoff] image planner repair still omitted executable tool call', {
      plannerModel: planner.model,
      toolCount: plannerTools.length,
      response: plannerResponseShape(repair.body),
    });
    throw new Error('配图规划器连续两次没有返回可执行的生图调用');
  }

  const nativeError = remoteError(native.body, native.response.status);
  if (![400, 404, 405, 415, 422].includes(native.response.status)) {
    // 不再把鉴权、限流、服务器故障等真实错误吞掉后伪装成“模型没调用工具”。
    throw new Error(`配图规划器请求失败：${nativeError}`);
  }

  // 只有站点明确拒绝 tools/tool_choice 时才切一次文字兼容模式；复用主聊天的假工具调用解析器，
  // 不再发明 Worker 专属格式。真正生图尚未发生，所以这一轮兼容重试不会重复出图。
  const schemaText = plannerTools.map(tool => JSON.stringify(tool)).join('\n');
  const fallback = await fetchJson(url, planner.apiKey, {
    method: 'POST',
    body: JSON.stringify({
      model: planner.model,
      messages: [
        {
          role: 'system',
          content: `${systemPrompt}\n\n工具兼容模式：原生 tools/tool_choice 被上游拒绝（${nativeError.slice(0, 300)}）。下面是允许选择的生图工具 schema：\n${schemaText}\n\n你必须只输出一行生图工具调用，严格使用 tool_name({JSON})；禁止解释、分析、道歉、代码块、自然语言前后缀，也禁止返回空白。`,
        },
        { role: 'user', content: '选择一个最适合最新剧情画面的工具，并给出完整参数。' },
      ],
      temperature: 0,
      max_tokens: 3000,
      stream: false,
    }),
  }, 90_000);
  if (!fallback.response.ok) {
    throw new Error(`配图规划器兼容重试失败：${remoteError(fallback.body, fallback.response.status)}`);
  }
  const selection = extractPlannerSelection(fallback.body, allowedNames, textResolve);
  if (!selection) {
    console.warn('[StoryImageHandoff] text fallback omitted executable tool call', {
      plannerModel: planner.model,
      toolCount: plannerTools.length,
      response: plannerResponseShape(fallback.body),
    });
    throw new Error('配图规划器连续两次没有返回可执行的生图调用');
  }
  return selection;
};

export const runStoryImageHandoff = async (
  spec: StoryCloudImageHandoffSpec,
  storyClientRequestId: string,
  storyContent: string,
): Promise<StoryCloudImageHandoffResult> => {
  let plan = parseInlinePlan(String(storyContent || ''));
  if (!plan && spec.planner) {
    try {
      plan = await runSeparatePlanner(spec.planner, spec.tools, storyContent);
    } catch (error) {
      return {
        state: 'failed',
        error: String((error as Error)?.message || error).slice(0, 500),
      };
    }
  }
  if (!plan) return { state: 'skipped' };

  const prepared = prepareStoryImageHandoffFromPlan(spec, storyClientRequestId, plan);
  if (prepared.state !== 'submitted' || !prepared.exposedTool || !prepared.clientRequestId) return prepared;

  const tool = spec.tools.find(item => item.exposedName === prepared.exposedTool);
  if (!tool) return { ...prepared, state: 'failed', error: '正文选择的生图工具已不可用' };

  const clientRequestId = prepared.clientRequestId;
  const preparedArgs = isRecord(prepared.arguments) ? cloneRecord(prepared.arguments) : {};
  // 与主线后台生图完全复用同一份客户端字段解析器：动作字段只供本机结果回挂使用，
  // 严格后端只接收 cleanedArgs，不能看到 after_generate_action / afterGenerateAction。
  const { afterGenerateAction, cleanedArgs } = parseImageToolClientOptions(preparedArgs);
  const finalArgs = cleanedArgs;
  const baseResult = {
    exposedTool: tool.exposedName,
    toolName: tool.toolName,
    clientRequestId,
    arguments: finalArgs,
    ...(afterGenerateAction !== 'none' ? { afterGenerateAction } : {}),
  };

  // A failed unused reference must not fail the picture. A selected unsynced slot must never
  // silently use the previous image on the MCP server (replacement retains the same slot id).
  for (const key of ['reference_id', 'user_reference_id', 'vibe_reference_id']) {
    const error = tool.referenceErrors?.[String(finalArgs[key] || '')];
    if (error) return { ...baseResult, state: 'failed', error: `配图参考图同步失败：${error}` };
  }

  try {
    try {
      const existing = await findExistingJob(tool, clientRequestId);
      if (existing?.id) {
        return { ...baseResult, state: 'submitted', remoteJobId: String(existing.id) };
      }
    } catch (lookupError) {
      console.warn('[StoryImageHandoff] pre-submit lookup inconclusive', String((lookupError as any)?.message || lookupError));
    }

    await applyPreset(tool);
    let submitted: { response: Response; body: any };
    try {
      submitted = await fetchJson(`${tool.controlBaseUrl}/jobs`, tool.token, {
        method: 'POST',
        body: JSON.stringify({
          clientRequestId,
          toolName: tool.toolName,
          arguments: finalArgs,
        }),
      });
    } catch {
      return { ...baseResult, state: 'submitted', uncertain: true };
    }

    if (submitted.response.ok && submitted.body?.job?.id) {
      return { ...baseResult, state: 'submitted', remoteJobId: String(submitted.body.job.id) };
    }
    if (submitted.response.status >= 500) {
      return { ...baseResult, state: 'submitted', uncertain: true };
    }
    return {
      ...baseResult,
      state: 'failed',
      error: `生图后台接单失败：${remoteError(submitted.body, submitted.response.status)}`,
    };
  } catch (error) {
    return {
      ...baseResult,
      state: 'failed',
      error: String((error as any)?.message || error).slice(0, 500),
    };
  }
};