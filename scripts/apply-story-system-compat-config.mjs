import fs from 'node:fs';

const fail = (message) => { throw new Error(message); };

const replaceExact = (path, before, after, expected = 1) => {
  const source = fs.readFileSync(path, 'utf8');
  const count = source.split(before).length - 1;
  if (count !== expected) fail(`${path}: expected ${expected} matches, found ${count}`);
  fs.writeFileSync(path, source.replaceAll(before, after));
};

// 1) Cloud Story: freeze per-route preset/model compatibility into a private request marker.
replaceExact(
  'utils/backgroundStoryJobs.ts',
  "import type { ApiExecutionPlan } from './apiFailover';\n",
  "import { loadApiPresetsForFailover, type ApiExecutionPlan } from './apiFailover';\nimport { findApiPresetForConfig } from './apiPresetRouteIdentity';\nimport { getApiPresetStorySystemCompatibility } from './apiPresetModels';\n",
);
replaceExact(
  'utils/backgroundStoryJobs.ts',
  `    const firstRoute = options.plan.routes[0];\n    const logId = cloudApiCallLogId(pending.clientRequestId);\n    let job: CloudStoryJob | null = null;\n    const spec = {\n`,
  `    const firstRoute = options.plan.routes[0];\n    const logId = cloudApiCallLogId(pending.clientRequestId);\n    let job: CloudStoryJob | null = null;\n    const apiPresets = loadApiPresetsForFailover();\n    const storySystemCompatibilityRoutes = options.plan.routes.map(route => {\n        const preset = apiPresets.find(item => item.id === route.presetId)\n            || findApiPresetForConfig(apiPresets, route.api);\n        return {\n            baseUrl: String(route.api.baseUrl || '').trim().replace(/\\/+$/, ''),\n            model: String(route.api.model || '').trim(),\n            enabled: getApiPresetStorySystemCompatibility(preset, route.api.model),\n        };\n    });\n    const spec = {\n`,
);
replaceExact(
  'utils/backgroundStoryJobs.ts',
  `        baseBody: {\n            ...options.body,\n            stream: true,\n        },\n`,
  `        baseBody: {\n            ...options.body,\n            // Worker 会在真正发往模型前消费并删除这个私有字段。它按 baseUrl + model\n            // 区分故障转移线路，因此同一个 Gemini 在不同站子可以一条开、一条关。\n            _sullyStorySystemCompatibilityRoutes: storySystemCompatibilityRoutes,\n            stream: true,\n        },\n`,
);

// 2) Story image planner: resolve the same preset/model flag; main chat never reads it.
replaceExact(
  'utils/storyTheaterImage.ts',
  "import { snapshotStoryReference, type StoryReferenceUpload } from './storyImageReferenceUploads';\n",
  "import { snapshotStoryReference, type StoryReferenceUpload } from './storyImageReferenceUploads';\nimport { findApiPresetForConfig } from './apiPresetRouteIdentity';\nimport { getApiPresetStorySystemCompatibility } from './apiPresetModels';\nimport { applyStorySystemCompatibilityToBody } from './storySystemCompatibility';\n",
);
replaceExact(
  'utils/storyTheaterImage.ts',
  `    /** 已按本剧情“快速规划模型”解析好的独立规划 API。 */\n    plannerApiConfig?: APIConfig;\n`,
  `    /** 已按本剧情“快速规划模型”解析好的独立规划 API。 */\n    plannerApiConfig?: APIConfig;\n    /** 只影响剧情生图规划器，不影响主聊天或最终 NovelAI/GPT Image 出图请求。 */\n    plannerSystemCompatibility?: boolean;\n`,
);
replaceExact(
  'utils/storyTheaterImage.ts',
  `export const resolveStoryImagePlannerApiConfig = (\n    entry: StoryTheaterEntry,\n    fallbackApi: APIConfig,\n    presets: ApiPreset[],\n): APIConfig => {\n    const presetId = String(entry.imageGeneration?.plannerApiPresetId || '').trim();\n    if (!presetId) return fallbackApi;\n\n    const preset = presets.find(item => item.id === presetId);\n    if (!preset) return fallbackApi;\n\n    const configuredModel = String(entry.imageGeneration?.plannerModel || '').trim();\n    return {\n        ...fallbackApi,\n        ...preset.config,\n        model: configuredModel || preset.config.model,\n        // 规划器只返回一次工具调用，不需要占用流式连接。\n        stream: false,\n    };\n};\n`,
  `export const resolveStoryImagePlannerApiConfig = (\n    entry: StoryTheaterEntry,\n    fallbackApi: APIConfig,\n    presets: ApiPreset[],\n): APIConfig => {\n    const presetId = String(entry.imageGeneration?.plannerApiPresetId || '').trim();\n    if (!presetId) return fallbackApi;\n\n    const preset = presets.find(item => item.id === presetId);\n    if (!preset) return fallbackApi;\n\n    const configuredModel = String(entry.imageGeneration?.plannerModel || '').trim();\n    return {\n        ...fallbackApi,\n        ...preset.config,\n        model: configuredModel || preset.config.model,\n        // 规划器只返回一次工具调用，不需要占用流式连接。\n        stream: false,\n    };\n};\n\nexport const resolveStoryImagePlannerSystemCompatibility = (\n    entry: StoryTheaterEntry,\n    fallbackApi: APIConfig,\n    presets: ApiPreset[],\n): boolean => {\n    const presetId = String(entry.imageGeneration?.plannerApiPresetId || '').trim();\n    const configuredModel = String(entry.imageGeneration?.plannerModel || '').trim();\n    const preset = presetId\n        ? presets.find(item => item.id === presetId)\n        : findApiPresetForConfig(presets, fallbackApi);\n    if (!preset) return false;\n    const model = configuredModel || (presetId ? preset.config.model : fallbackApi.model);\n    return getApiPresetStorySystemCompatibility(preset, model);\n};\n`,
);
replaceExact(
  'utils/storyTheaterImage.ts',
  `export interface StoryCloudImagePlannerSpec {\n    baseUrl: string;\n    apiKey: string;\n    model: string;\n    systemPrompt: string;\n    tools: OpenAIMcpTool[];\n}\n`,
  `export interface StoryCloudImagePlannerSpec {\n    baseUrl: string;\n    apiKey: string;\n    model: string;\n    systemPrompt: string;\n    systemCompatibility?: boolean;\n    tools: OpenAIMcpTool[];\n}\n`,
);
replaceExact(
  'utils/storyTheaterImage.ts',
  `    plannerApiConfig?: APIConfig;\n    messages?: Message[];\n}): Promise<StoryCloudImageHandoffSpec | undefined> => {\n`,
  `    plannerApiConfig?: APIConfig;\n    plannerSystemCompatibility?: boolean;\n    messages?: Message[];\n}): Promise<StoryCloudImageHandoffSpec | undefined> => {\n`,
);
replaceExact(
  'utils/storyTheaterImage.ts',
  `            model: plannerModel,\n            systemPrompt: buildPlannerInstruction({\n`,
  `            model: plannerModel,\n            ...(input.plannerSystemCompatibility === true ? { systemCompatibility: true } : {}),\n            systemPrompt: buildPlannerInstruction({\n`,
);
replaceExact(
  'utils/storyTheaterImage.ts',
  `        const runPlanner = async (body: Record<string, any>) => executeOpenAiChatPlan({\n            // 旧兼容兜底：只有主剧情模型没产出合法 inline plan 时才会走到这里。\n            plan: resolveApiExecutionPlan('chat', plannerApiConfig, false),\n            body,\n`,
  `        const runPlanner = async (body: Record<string, any>) => executeOpenAiChatPlan({\n            // 旧兼容兜底：只有主剧情模型没产出合法 inline plan 时才会走到这里。\n            // 兼容转换只发生在这个剧情规划请求里；同一预设用于主聊天时完全不读该开关。\n            plan: resolveApiExecutionPlan('chat', plannerApiConfig, false),\n            body: applyStorySystemCompatibilityToBody(body, input.plannerSystemCompatibility === true),\n`,
);

// 3) Story session passes planner compatibility into cloud + local planner calls.
replaceExact(
  'components/date/story/StoryTheaterSession.tsx',
  `    resolveStoryImagePlannerApiConfig,\n`,
  `    resolveStoryImagePlannerApiConfig,\n    resolveStoryImagePlannerSystemCompatibility,\n`,
);
replaceExact(
  'components/date/story/StoryTheaterSession.tsx',
  `                plannerApiConfig: resolveStoryImagePlannerApiConfig(entry, apiConfig, apiPresets),\n`,
  `                plannerApiConfig: resolveStoryImagePlannerApiConfig(entry, apiConfig, apiPresets),\n                plannerSystemCompatibility: resolveStoryImagePlannerSystemCompatibility(entry, apiConfig, apiPresets),\n`,
  3,
);

// 4) Worker-side separate image planner consumes the frozen flag.
replaceExact(
  'worker/amsg/src/storyImageHandoff.ts',
  "import { normalizeToolCallsForCompat } from '../../../utils/toolCallCompat';\n",
  "import { normalizeToolCallsForCompat } from '../../../utils/toolCallCompat';\nimport { applyStorySystemCompatibility } from './storyEgress';\n",
);
replaceExact(
  'worker/amsg/src/storyImageHandoff.ts',
  `  model: string;\n  systemPrompt: string;\n  tools: Array<{\n`,
  `  model: string;\n  systemPrompt: string;\n  systemCompatibility?: boolean;\n  tools: Array<{\n`,
);
replaceExact(
  'worker/amsg/src/storyImageHandoff.ts',
  `        model: plannerModel,\n        systemPrompt: plannerSystemPrompt.slice(0, 80_000),\n        tools: plannerTools,\n`,
  `        model: plannerModel,\n        systemPrompt: plannerSystemPrompt.slice(0, 80_000),\n        ...(plannerRaw.systemCompatibility === true ? { systemCompatibility: true } : {}),\n        tools: plannerTools,\n`,
);
replaceExact(
  'worker/amsg/src/storyImageHandoff.ts',
  `  let native: { response: Response; body: any };\n`,
  `  const encodePlannerBody = (body: Record<string, unknown>): string => {\n    const raw = JSON.stringify(body);\n    const compatible = applyStorySystemCompatibility(raw, planner.systemCompatibility === true);\n    return typeof compatible === 'string' ? compatible : raw;\n  };\n\n  let native: { response: Response; body: any };\n`,
);
replaceExact(
  'worker/amsg/src/storyImageHandoff.ts',
  `      body: JSON.stringify(nativeBody),\n`,
  `      body: encodePlannerBody(nativeBody),\n`,
);
replaceExact(
  'worker/amsg/src/storyImageHandoff.ts',
  `        body: JSON.stringify(buildNativeRepairBody(nativeBody)),\n`,
  `        body: encodePlannerBody(buildNativeRepairBody(nativeBody)),\n`,
);
replaceExact(
  'worker/amsg/src/storyImageHandoff.ts',
  `    body: JSON.stringify({\n      model: planner.model,\n      messages: [\n`,
  `    body: encodePlannerBody({\n      model: planner.model,\n      messages: [\n`,
);
replaceExact(
  'worker/amsg/src/storyImageHandoff.ts',
  `      stream: false,\n    }),\n  }, 90_000);\n`,
  `      stream: false,\n    }),\n  }, 90_000);\n`,
);

// 5) Preset model UI: a single switch shared by Story text + Story image planner only.
replaceExact(
  'apps/Settings.tsx',
  `    getApiPresetPricing,\n    removeApiPresetModel,\n    setApiPresetDefaultModel,\n    setApiPresetModelPricing,\n`,
  `    getApiPresetPricing,\n    getApiPresetStorySystemCompatibility,\n    removeApiPresetModel,\n    setApiPresetDefaultModel,\n    setApiPresetModelPricing,\n    setApiPresetModelStorySystemCompatibility,\n`,
);
replaceExact(
  'apps/Settings.tsx',
  `          title={pricingModel ? \`模型价格 · \${pricingModel}\` : '模型价格'}\n`,
  `          title={pricingModel ? \`模型设置 · \${pricingModel}\` : '模型设置'}\n`,
);
replaceExact(
  'apps/Settings.tsx',
  `                      addToast(\`\${pricingModel} 的价格已保存\`, 'success');\n`,
  `                      addToast(\`\${pricingModel} 的模型设置已保存\`, 'success');\n`,
);
replaceExact(
  'apps/Settings.tsx',
  `                  保存价格\n`,
  `                  保存\n`,
);
replaceExact(
  'apps/Settings.tsx',
  `      >\n          {pricingDraft && <ApiPricingEditor value={pricingDraft} onChange={setPricingDraft} />}\n      </Modal>\n\n      {/* 编辑预设`,
  `      >\n          <div className="space-y-3">\n              {pricingDraft && <ApiPricingEditor value={pricingDraft} onChange={setPricingDraft} />}\n              {pricingPresetId && pricingModel && (() => {\n                  const preset = apiPresets.find(item => item.id === pricingPresetId);\n                  if (!preset) return null;\n                  const enabled = getApiPresetStorySystemCompatibility(preset, pricingModel);\n                  return (\n                      <div className="rounded-2xl border border-violet-100 bg-violet-50/60 p-4">\n                          <div className="flex items-center justify-between gap-3">\n                              <div className="min-w-0">\n                                  <div className="text-xs font-bold text-violet-700">文游 System 兼容</div>\n                                  <p className="mt-1 text-[10px] leading-relaxed text-violet-700/65">\n                                      只作用于文游正文和剧情生图规划模型，主聊天不会读取。遇到长 system 导致 400/429 等兼容异常时再开启。\n                                  </p>\n                              </div>\n                              <button\n                                  type="button"\n                                  role="switch"\n                                  aria-checked={enabled}\n                                  onClick={() => {\n                                      const updated = setApiPresetModelStorySystemCompatibility(preset, pricingModel, !enabled);\n                                      updateApiPreset(preset.id, { models: updated.models });\n                                  }}\n                                  className={\`relative h-6 w-11 shrink-0 rounded-full transition-colors \${enabled ? 'bg-violet-500' : 'bg-slate-200'}\`}\n                              >\n                                  <span className={\`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition-transform \${enabled ? 'translate-x-5' : 'translate-x-0.5'}\`} />\n                              </button>\n                          </div>\n                      </div>\n                  );\n              })()}\n          </div>\n      </Modal>\n\n      {/* 编辑预设`,
);

console.log('Applied story system compatibility configuration patches.');
