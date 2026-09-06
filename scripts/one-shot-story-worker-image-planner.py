from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding='utf-8')


def write(path: str, text: str) -> None:
    (ROOT / path).write_text(text, encoding='utf-8')


def replace_once(path: str, old: str, new: str) -> None:
    text = read(path)
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{path}: expected 1 exact match, found {count}')
    write(path, text.replace(old, new, 1))


def replace_regex(path: str, pattern: str, replacement: str) -> None:
    text = read(path)
    new_text, count = re.subn(pattern, replacement, text, count=1, flags=re.S)
    if count != 1:
        raise SystemExit(f'{path}: regex expected 1 match, found {count}')
    write(path, new_text)


# ---------------------------------------------------------------------------
# Client handoff: freeze planner + image tool config without doing any network
# before the story POST. This is deliberately local-only so an instant app
# switch cannot strand the story request behind reference HEAD/PUT calls.
# ---------------------------------------------------------------------------
path = 'utils/storyTheaterImage.ts'
replace_once(
    path,
    "import { persistMcpGeneratedImages } from './mcpImagePersistence';\n",
    "import { persistMcpGeneratedImages } from './mcpImagePersistence';\nimport { getActiveVibeReference } from './vibeReference';\n",
)
replace_once(
    path,
    "export interface StoryCloudImageHandoffSpec {\n    version: 1;\n    tools: StoryCloudImageToolHandoff[];\n}\n",
    "export interface StoryCloudImagePlannerSpec {\n"
    "    baseUrl: string;\n"
    "    apiKey: string;\n"
    "    model: string;\n"
    "    systemPrompt: string;\n"
    "    tools: OpenAIMcpTool[];\n"
    "}\n\n"
    "export interface StoryCloudImageHandoffSpec {\n"
    "    version: 1;\n"
    "    tools: StoryCloudImageToolHandoff[];\n"
    "    /** 正文完成后由 Worker 独立执行的二段式配图规划器。 */\n"
    "    planner?: StoryCloudImagePlannerSpec;\n"
    "}\n",
)
new_builder = r'''export const buildStoryCloudImageHandoffSpec = async (input: {
    actors: CharacterProfile[];
    userProfile: UserProfile;
    entry?: StoryTheaterEntry;
    userName?: string;
    plannerApiConfig?: APIConfig;
    messages?: Message[];
}): Promise<StoryCloudImageHandoffSpec | undefined> => {
    if (!input.actors.length) return undefined;
    const imageTools = resolveStoryImageTools(input.actors);
    const presets = getImageGenerationPresets();
    const tools: StoryCloudImageToolHandoff[] = [];
    const activeVibe = getActiveVibeReference();

    // 这里只冻结“已经存在的远端 slot 身份”，绝不在正文 POST 前做 HEAD/PUT。
    // 参考图通常在设置/既往生图时已经上传；即便某个 slot 后续失效，也只影响配图，
    // 不能再让 WebView 因为参考图预检而把整轮正文卡在前台。
    const actorReferenceFragment = (actor: CharacterProfile): Record<string, unknown> | undefined => {
        const config = actor.novelAiReference;
        if (!config?.enabled || !config.slotId) return undefined;
        return {
            reference_id: config.slotId,
            reference_type: config.type,
            reference_strength: config.strength,
            reference_fidelity: config.fidelity,
        };
    };
    const userReferenceFragment = (): Record<string, unknown> | undefined => {
        const config = input.userProfile.novelAiReference;
        if (!config?.enabled || !config.slotId) return undefined;
        return {
            user_reference_id: config.slotId,
            user_reference_type: config.type,
            user_reference_strength: config.strength,
            user_reference_fidelity: config.fidelity,
        };
    };
    const vibeReferenceFragment = (): Record<string, unknown> | undefined => {
        if (!activeVibe?.slotId) return undefined;
        return {
            vibe_reference_id: activeVibe.slotId,
            vibe_reference_strength: activeVibe.strength,
            vibe_reference_information_extracted: activeVibe.informationExtracted,
        };
    };

    for (const [exposedName, hit] of imageTools.resolve) {
        const controlBaseUrl = String(hit.server.controlBaseUrl || '').trim().replace(/\/+$/, '');
        if (!/^https?:\/\//i.test(controlBaseUrl)) continue;
        const engineId = hit.server.imagePresetEngineId === 'novelai' || hit.toolName === 'novelai_generate_image'
            ? 'novelai'
            : 'gpt-image';
        const preset = hit.server.imagePresetId
            ? presets.find(item => item.id === hit.server.imagePresetId)
            : undefined;
        const descriptor: StoryCloudImageToolHandoff = {
            exposedName,
            toolName: hit.toolName,
            engineId,
            controlBaseUrl,
            token: String(hit.server.token || ''),
            ...(preset ? {
                preset: {
                    remoteConfig: JSON.parse(JSON.stringify(preset.remoteConfig || {})),
                    apiKey: String(preset.apiKey || ''),
                },
            } : {}),
        };

        if (engineId === 'novelai') {
            const actors: Record<string, Record<string, unknown>> = {};
            for (const actor of input.actors) {
                const fragment = actorReferenceFragment(actor);
                if (fragment) actors[actor.id] = fragment;
            }
            const user = userReferenceFragment();
            const vibe = vibeReferenceFragment();
            if (Object.keys(actors).length || user || vibe) {
                descriptor.references = {
                    ...(Object.keys(actors).length ? { actors } : {}),
                    ...(user ? { user } : {}),
                    ...(vibe ? { vibe } : {}),
                };
            }
        }
        tools.push(descriptor);
    }

    if (!tools.length) return undefined;
    const plannerApi = input.plannerApiConfig;
    const plannerBaseUrl = String(plannerApi?.baseUrl || '').trim().replace(/\/+$/, '');
    const plannerModel = String(plannerApi?.model || '').trim();
    const toolNames = imageTools.tools.map(tool => tool.function.name);
    const planner = input.entry && plannerApi && plannerModel && /^https?:\/\//i.test(plannerBaseUrl)
        ? {
            baseUrl: plannerBaseUrl,
            apiKey: String(plannerApi.apiKey || ''),
            model: plannerModel,
            systemPrompt: buildPlannerInstruction({
                apiConfig: plannerApi,
                plannerApiConfig: plannerApi,
                entry: input.entry,
                actors: input.actors,
                userProfile: input.userProfile,
                userName: input.userName || input.userProfile.name || '用户',
                messages: input.messages || [],
            }, toolNames),
            tools: imageTools.tools.map(tool => JSON.parse(JSON.stringify(tool))) as OpenAIMcpTool[],
        }
        : undefined;

    return {
        version: 1,
        tools,
        ...(planner ? { planner } : {}),
    };
};
'''
replace_regex(
    path,
    r"export const buildStoryCloudImageHandoffSpec = async \(input: \{[\s\S]*?\n\};\n\nexport const adoptStoryCloudImageHandoff",
    new_builder + "\nexport const adoptStoryCloudImageHandoff",
)


# ---------------------------------------------------------------------------
# Worker handoff: if the story body does not contain the obsolete inline plan,
# run the separate planner on the Worker and then submit the stable image job.
# ---------------------------------------------------------------------------
path = 'worker/amsg/src/storyImageHandoff.ts'
replace_once(
    path,
    "export interface StoryCloudImageHandoffSpec {\n  version: 1;\n  tools: StoryCloudImageToolHandoff[];\n}\n",
    "export interface StoryCloudImagePlannerSpec {\n"
    "  baseUrl: string;\n"
    "  apiKey: string;\n"
    "  model: string;\n"
    "  systemPrompt: string;\n"
    "  tools: Array<{\n"
    "    type: 'function';\n"
    "    function: { name: string; description?: string; parameters?: Record<string, unknown> };\n"
    "  }>;\n"
    "}\n\n"
    "export interface StoryCloudImageHandoffSpec {\n"
    "  version: 1;\n"
    "  tools: StoryCloudImageToolHandoff[];\n"
    "  planner?: StoryCloudImagePlannerSpec;\n"
    "}\n",
)
replace_once(
    path,
    "  return tools.length ? { version: 1, tools } : undefined;\n};\n",
    r'''  const plannerRaw = isRecord(value.planner) ? value.planner : undefined;
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
''',
)
replace_once(
    path,
    "const fetchJson = async (\n  url: string,\n  token: string,\n  init: RequestInit = {},\n): Promise<{ response: Response; body: any }> => {\n  const controller = new AbortController();\n  const timeout = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);\n",
    "const fetchJson = async (\n"
    "  url: string,\n"
    "  token: string,\n"
    "  init: RequestInit = {},\n"
    "  timeoutMs = HTTP_TIMEOUT_MS,\n"
    "): Promise<{ response: Response; body: any }> => {\n"
    "  const controller = new AbortController();\n"
    "  const timeout = setTimeout(() => controller.abort(), timeoutMs);\n",
)

planner_helpers_and_run = r'''const prepareStoryImageHandoffFromPlan = (
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
  const finalArgs = isRecord(prepared.arguments) ? cloneRecord(prepared.arguments) : {};
  const baseResult = {
    exposedTool: tool.exposedName,
    toolName: tool.toolName,
    clientRequestId,
    arguments: finalArgs,
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
'''
replace_regex(
    path,
    r"export const prepareStoryImageHandoff = \([\s\S]*?export const runStoryImageHandoff = async \([\s\S]*?\n\};\s*$",
    planner_helpers_and_run,
)


# ---------------------------------------------------------------------------
# Story Worker: planner + /jobs submission happen before the story is marked
# terminal. This keeps the whole handoff server-owned while still treating any
# image failure as non-fatal to the already-generated text.
# ---------------------------------------------------------------------------
path = 'worker/amsg/src/storyJobs.ts'
replace_once(
    path,
    "  normalizeStoryImageHandoffSpec,\n  prepareStoryImageHandoff,\n  runStoryImageHandoff,\n",
    "  normalizeStoryImageHandoffSpec,\n  runStoryImageHandoff,\n",
)
new_success_block = r'''      // 正文已经完整。若启用了自动配图，二段式“规划器 → 生图 /jobs”也必须在
      // Worker 内完成，不能再依赖 WebView 从 await 后继续执行；否则用户一切后台，JS 冻结，
      // 配图就必然等到回前台才开始。
      let finalImageHandoff: Awaited<ReturnType<typeof runStoryImageHandoff>> | undefined;
      if (spec.imageHandoff) {
        try {
          finalImageHandoff = await runStoryImageHandoff(
            spec.imageHandoff,
            spec.clientRequestId,
            streamed.content,
          );
        } catch (imageHandoffError) {
          finalImageHandoff = {
            state: 'failed',
            error: String((imageHandoffError as Error)?.message || imageHandoffError).slice(0, 500),
          };
        }
      }

      const storedResponse = finalImageHandoff
        ? { ...streamed.response, _sullyStoryImageHandoff: finalImageHandoff }
        : streamed.response;
      const responseCipher = await sealJson(env, userId, jobId, 'response', storedResponse);
      const partialCipher = await sealJson(env, userId, jobId, 'partial', streamed.content);
      const usage = (streamed.response as any)?.usage || {};
      const promptTokens = Number(usage?.prompt_tokens);
      const completionTokens = Number(usage?.completion_tokens);
      const finishedAt = now();
      await env.DB.prepare(
        `UPDATE story_jobs
         SET status = 'succeeded', response_cipher = ?, partial_cipher = ?, error = NULL,
             attempts_json = ?, prompt_tokens = ?, completion_tokens = ?, reasoning_chars = ?,
             visible_chars = ?, updated_at = ?, completed_at = ?
         WHERE user_id = ? AND job_id = ?`,
      ).bind(
        responseCipher,
        partialCipher,
        JSON.stringify(attempts),
        Number.isFinite(promptTokens) ? promptTokens : null,
        Number.isFinite(completionTokens) ? completionTokens : null,
        streamed.reasoning.length,
        streamed.content.length,
        finishedAt,
        finishedAt,
        userId,
        jobId,
      ).run();

      // 到这里正文与“配图是否已接单”的结论都已经落库。原生通知随后看到 succeeded，
      // App 即使仍在后台也不会再阻断真正的配图规划或生成。
      await sendStoryBackgroundStatusPush(
        env as any,
        storyStatusJob({ ...liveRow, status: 'succeeded', completed_at: finishedAt, updated_at: finishedAt }),
        'succeeded',
      );
      return;
    } catch (error) {'''
replace_regex(
    path,
    r"      // 正文已经完整：先把正文标成 succeeded[\s\S]*?      return;\n    \} catch \(error\) \{",
    new_success_block,
)


# ---------------------------------------------------------------------------
# Story UI: freeze the handoff before cloud submission, capture Worker result,
# and adopt the stable image job after the message is locally committed. Only
# old/non-cloud paths run the local planner.
# ---------------------------------------------------------------------------
path = 'components/date/story/StoryTheaterSession.tsx'
replace_once(
    path,
    "import { generateStoryTheaterImage, resolveStoryImagePlannerApiConfig } from '../../../utils/storyTheaterImage';\n",
    "import {\n"
    "    adoptStoryCloudImageHandoff,\n"
    "    buildStoryCloudImageHandoffSpec,\n"
    "    generateStoryTheaterImage,\n"
    "    resolveStoryImagePlannerApiConfig,\n"
    "    type StoryCloudImageHandoffResult,\n"
    "} from '../../../utils/storyTheaterImage';\n",
)
insert_marker = "            const prefill = compiled.assistantPrefill?.content || '';\n            usedNativeBackground = isNativeStoryBackgroundRuntime();\n            const generated = await callCompletion(payload, compiled.settings, reported => {"
insert_replacement = "            const prefill = compiled.assistantPrefill?.content || '';\n" \
    "            let cloudImageHandoffResult: StoryCloudImageHandoffResult | undefined;\n" \
    "            const cloudImageHandoff = entry.imageGeneration?.enabled\n" \
    "                ? await buildStoryCloudImageHandoffSpec({\n" \
    "                    actors,\n" \
    "                    userProfile,\n" \
    "                    entry,\n" \
    "                    userName: promptIdentityName,\n" \
    "                    plannerApiConfig: resolveStoryImagePlannerApiConfig(entry, apiConfig, apiPresets),\n" \
    "                    messages: visibleHistory,\n" \
    "                })\n" \
    "                : undefined;\n" \
    "            usedNativeBackground = isNativeStoryBackgroundRuntime();\n" \
    "            const generated = await callCompletion(payload, compiled.settings, reported => {"
replace_once(path, insert_marker, insert_replacement)
replace_once(
    path,
    "                meta: {\n                    ...(isReroll && rerollTarget ? { rerollTargetId: rerollTarget.id } : {}),\n                    ...(affinityInputs.length > 0 ? { affinityInputs } : {}),\n                    isContinueTurn,\n                },\n                beforeRelease:",
    "                meta: {\n"
    "                    ...(isReroll && rerollTarget ? { rerollTargetId: rerollTarget.id } : {}),\n"
    "                    ...(affinityInputs.length > 0 ? { affinityInputs } : {}),\n"
    "                    isContinueTurn,\n"
    "                },\n"
    "                imageHandoff: cloudImageHandoff,\n"
    "                onCloudCompleted: data => {\n"
    "                    cloudImageHandoffResult = data?._sullyStoryImageHandoff as StoryCloudImageHandoffResult | undefined;\n"
    "                },\n"
    "                beforeRelease:",
)
old_image_block = r'''                    // 正文已经独立完成并落库；配图始终再单独调用一次规划器。
            // 不再要求主剧情模型输出隐藏 story_image_plan，也不把配图协议混进正文预设。
            const imageResult = await generateStoryTheaterImage({
                apiConfig,
                plannerApiConfig: resolveStoryImagePlannerApiConfig(entry, apiConfig, apiPresets),
                entry,
                actors,
                userProfile,
                userName: promptIdentityName,
                messages: imageRows,
                targetMessageId: assistantMessageId,
            });
            if (imageResult.frame) {'''
new_image_block = r'''                    // 云端 Story Worker 已经在正文完成后独立跑过“配图规划 → /jobs”。
                    // 回前台只负责把那个稳定 clientRequestId 接到刚落库的 messageId，绝不再规划第二遍。
                    // 老 Worker / 非云端路径拿不到 handoff 时才保留原来的本机规划器作为兼容兜底。
                    let imageResult;
                    if (cloudImageHandoffResult?.state === 'submitted') {
                        imageResult = await adoptStoryCloudImageHandoff({
                            entry,
                            actors,
                            handoff: cloudImageHandoffResult,
                            targetMessageId: assistantMessageId,
                        });
                    } else if (cloudImageHandoffResult?.state === 'failed') {
                        throw new Error(cloudImageHandoffResult.error || '云端配图规划失败');
                    } else {
                        imageResult = await generateStoryTheaterImage({
                            apiConfig,
                            plannerApiConfig: resolveStoryImagePlannerApiConfig(entry, apiConfig, apiPresets),
                            entry,
                            actors,
                            userProfile,
                            userName: promptIdentityName,
                            messages: imageRows,
                            targetMessageId: assistantMessageId,
                        });
                    }
                    if (imageResult.frame) {'''
replace_once(path, old_image_block, new_image_block)

print('Story worker image planner migration patched successfully.')
