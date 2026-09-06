import { parseImageToolClientOptions } from '../../../utils/imageToolPostAction';

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

    const referencesRaw = isRecord(rawTool.references) ? rawTool.references : undefined;
    const actorsRaw = referencesRaw && isRecord(referencesRaw.actors) ? referencesRaw.actors : undefined;
    const actors: Record<string, Record<string, unknown>> = {};
    if (actorsRaw) {
      for (const [actorId, fragment] of Object.entries(actorsRaw)) {
        if (actorId && isRecord(fragment)) actors[actorId] = cloneRecord(fragment);
      }
    }
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
      ...(referencesRaw ? {
        references: {
          ...(Object.keys(actors).length ? { actors } : {}),
          ...(normalizeFragment(referencesRaw.user) ? { user: normalizeFragment(referencesRaw.user)! } : {}),
          ...(normalizeFragment(referencesRaw.vibe) ? { vibe: normalizeFragment(referencesRaw.vibe)! } : {}),
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

const mergeNovelAiReferences = (
  tool: StoryCloudImageToolHandoff,
  rawArgs: Record<string, unknown>,
): Record<string, unknown> => {
  const args = cloneRecord(rawArgs);
  const requestedActorId = typeof args.story_reference_actor_id === 'string'
    ? args.story_reference_actor_id
    : '';
  const useCharacter = args.story_use_character_reference !== false && args.use_character_reference !== false;
  const useUser = args.story_use_user_reference !== false && args.use_user_reference !== false;
  const useVibe = args.story_use_vibe_reference !== false && args.use_vibe_reference !== false;
  delete args.story_reference_actor_id;
  delete args.story_use_character_reference;
  delete args.story_use_user_reference;
  delete args.story_use_vibe_reference;
  delete args.use_character_reference;
  delete args.use_user_reference;
  delete args.use_vibe_reference;

  if (tool.engineId !== 'novelai') return args;
  const refs = tool.references;
  if (useVibe && refs?.vibe && Object.keys(refs.vibe).length) {
    Object.assign(args, refs.vibe);
    return args;
  }
  if (useCharacter && refs?.actors) {
    const actorFragment = (requestedActorId && refs.actors[requestedActorId])
      || Object.values(refs.actors)[0];
    if (actorFragment) Object.assign(args, actorFragment);
  }
  if (useUser && refs?.user) Object.assign(args, refs.user);
  return args;
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
      } catch { /* try text-style call below */ }
    }
  }
  for (const name of allowedNames) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = clean.match(new RegExp(`${escaped}\\s*\\((\\{[\\s\\S]*\\})\\)`, 'm'));
    if (!match) continue;
    const args = parsePlannerArgs(match[1]);
    if (args) return { tool: name, arguments: args };
  }
  return null;
};

const extractPlannerSelection = (
  body: any,
  allowedNames: Set<string>,
): { tool: string; arguments: Record<string, unknown> } | null => {
  const message = body?.choices?.[0]?.message || {};
  const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  for (const call of calls) {
    const tool = String(call?.function?.name || call?.name || '').trim();
    if (!tool || !allowedNames.has(tool)) continue;
    const args = parsePlannerArgs(call?.function?.arguments ?? call?.arguments);
    if (args) return { tool, arguments: args };
  }
  const functionCall = message.function_call;
  if (functionCall) {
    const tool = String(functionCall.name || '').trim();
    const args = parsePlannerArgs(functionCall.arguments);
    if (tool && allowedNames.has(tool) && args) return { tool, arguments: args };
  }
  return parsePlannerText(String(message.content || ''), allowedNames);
};

const runSeparatePlanner = async (
  planner: StoryCloudImagePlannerSpec,
  allowedTools: StoryCloudImageToolHandoff[],
  storyContent: string,
): Promise<{ tool: string; arguments: Record<string, unknown> }> => {
  const allowedNames = new Set(allowedTools.map(tool => tool.exposedName));
  const plannerTools = planner.tools.filter(tool => allowedNames.has(tool.function.name));
  if (!plannerTools.length) throw new Error('配图规划器没有可用生图工具');
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

  let nativeError = '';
  try {
    const native = await fetchJson(url, planner.apiKey, {
      method: 'POST',
      body: JSON.stringify(nativeBody),
    }, 90_000);
    if (native.response.ok) {
      const selection = extractPlannerSelection(native.body, allowedNames);
      if (selection) return selection;
      nativeError = '规划器没有返回可执行的 tool_calls';
    } else {
      nativeError = remoteError(native.body, native.response.status);
      if (![400, 404, 405, 415, 422].includes(native.response.status)) {
        throw new Error(`配图规划器请求失败：${nativeError}`);
      }
    }
  } catch (error) {
    nativeError = String((error as Error)?.message || error);
  }

  // OpenAI-compatible 站点偶尔拒绝 tools/tool_choice。与 App 侧兼容策略一致，
  // 真正的生图尚未发生，因此可以只补一次“严格 JSON 选工具”规划，不会重复出图。
  const schemaText = plannerTools.map(tool => JSON.stringify(tool)).join('\n');
  const fallback = await fetchJson(url, planner.apiKey, {
    method: 'POST',
    body: JSON.stringify({
      model: planner.model,
      messages: [
        {
          role: 'system',
          content: `${systemPrompt}\n\n工具兼容模式：上一次原生工具调用不可用（${nativeError.slice(0, 300)}）。下面是允许选择的生图工具 schema：\n${schemaText}\n\n你必须只输出一行 JSON：{"tool":"工具名","arguments":{...}}。禁止解释、代码块和额外文本。`,
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
  const selection = extractPlannerSelection(fallback.body, allowedNames);
  if (!selection) throw new Error('配图规划器连续两次没有返回可执行的生图调用');
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
