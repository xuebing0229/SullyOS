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

export interface StoryCloudImageHandoffSpec {
  version: 1;
  tools: StoryCloudImageToolHandoff[];
}

export interface StoryCloudImageHandoffResult {
  state: 'submitted' | 'skipped' | 'failed';
  exposedTool?: string;
  toolName?: string;
  clientRequestId?: string;
  remoteJobId?: string;
  arguments?: Record<string, unknown>;
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
  return tools.length ? { version: 1, tools } : undefined;
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
): Promise<{ response: Response; body: any }> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
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
      method: 'PATCH',
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

export const runStoryImageHandoff = async (
  spec: StoryCloudImageHandoffSpec,
  storyClientRequestId: string,
  storyContent: string,
): Promise<StoryCloudImageHandoffResult> => {
  const plan = parseInlinePlan(String(storyContent || ''));
  if (!plan) return { state: 'skipped' };
  const tool = spec.tools.find(item => item.exposedName === plan.tool);
  if (!tool) return { state: 'failed', exposedTool: plan.tool, error: '正文选择的生图工具已不可用' };

  const clientRequestId = stableImageClientRequestId(storyClientRequestId);
  const finalArgs = mergeNovelAiReferences(tool, plan.arguments);
  const baseResult = {
    exposedTool: tool.exposedName,
    toolName: tool.toolName,
    clientRequestId,
    arguments: finalArgs,
  };

  try {
    // 按 clientRequestId 先查账：Durable Object 被重试/恢复时绝不重复提交同一张图。
    try {
      const existing = await findExistingJob(tool, clientRequestId);
      if (existing?.id) {
        return { ...baseResult, state: 'submitted', remoteJobId: String(existing.id) };
      }
    } catch (lookupError) {
      // 查询失败不能证明任务不存在。后面 POST 仍使用同一个稳定 id；服务端自身幂等。
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
    } catch (error) {
      // POST 响应丢失时任务可能已接单。把同一个 id 交给手机恢复查询，禁止另造请求。
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
