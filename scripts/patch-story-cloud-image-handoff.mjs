#!/usr/bin/env node
import fs from 'node:fs';

const read = path => fs.readFileSync(path, 'utf8');
const write = (path, content) => fs.writeFileSync(path, content);
const replaceOnce = (source, before, after, label) => {
  const first = source.indexOf(before);
  if (first < 0) throw new Error(`patch anchor not found: ${label}`);
  if (source.indexOf(before, first + before.length) >= 0) throw new Error(`patch anchor not unique: ${label}`);
  return source.slice(0, first) + after + source.slice(first + before.length);
};

// 1) Worker story job spec + completion handoff.
{
  const path = 'worker/amsg/src/storyJobs.ts';
  let s = read(path);
  s = replaceOnce(
    s,
    "import { constantTimeEqual } from './instantChat';\n",
    "import { constantTimeEqual } from './instantChat';\nimport {\n  normalizeStoryImageHandoffSpec,\n  runStoryImageHandoff,\n  type StoryCloudImageHandoffSpec,\n} from './storyImageHandoff';\n",
    'storyJobs import',
  );
  s = replaceOnce(
    s,
    "  routes: StoryJobRoute[];\n  baseBody: Record<string, unknown>;\n}",
    "  routes: StoryJobRoute[];\n  baseBody: Record<string, unknown>;\n  /** 可选：正文完成后由 Worker 直接把隐藏 image plan 交给生图 /jobs。 */\n  imageHandoff?: StoryCloudImageHandoffSpec;\n}",
    'storyJobs spec type',
  );
  s = replaceOnce(
    s,
    "    routes,\n    baseBody: raw.baseBody as Record<string, unknown>,\n  };",
    "    routes,\n    baseBody: raw.baseBody as Record<string, unknown>,\n    ...(normalizeStoryImageHandoffSpec(raw.imageHandoff)\n      ? { imageHandoff: normalizeStoryImageHandoffSpec(raw.imageHandoff) }\n      : {}),\n  };",
    'storyJobs validate spec',
  );
  s = replaceOnce(
    s,
    "      attempt.ok = true;\n      attempts.push(attempt);\n      const responseCipher = await sealJson(env, userId, jobId, 'response', streamed.response);\n      const partialCipher = await sealJson(env, userId, jobId, 'partial', streamed.content);",
    "      attempt.ok = true;\n      attempts.push(attempt);\n\n      // 正文已经完整且 terminal 后才允许起图。配图链任何失败都不能反过来把正文标失败。\n      // imageHandoff/result 都存进同一份加密 response；手机醒来接正文时顺便认领远端图 job。\n      let imageHandoffResult: Awaited<ReturnType<typeof runStoryImageHandoff>> | undefined;\n      if (spec.imageHandoff) {\n        try {\n          imageHandoffResult = await runStoryImageHandoff(\n            spec.imageHandoff,\n            spec.clientRequestId,\n            streamed.content,\n          );\n        } catch (imageHandoffError) {\n          imageHandoffResult = {\n            state: 'failed',\n            error: String((imageHandoffError as Error)?.message || imageHandoffError).slice(0, 500),\n          };\n        }\n      }\n      const storedResponse = imageHandoffResult\n        ? { ...streamed.response, _sullyStoryImageHandoff: imageHandoffResult }\n        : streamed.response;\n      const responseCipher = await sealJson(env, userId, jobId, 'response', storedResponse);\n      const partialCipher = await sealJson(env, userId, jobId, 'partial', streamed.content);",
    'storyJobs success handoff',
  );
  write(path, s);
}

// 2) Cloud story client includes handoff descriptor in encrypted story spec.
{
  const path = 'utils/backgroundStoryJobs.ts';
  let s = read(path);
  s = replaceOnce(
    s,
    "import type { ApiExecutionPlan } from './apiFailover';\n",
    "import type { ApiExecutionPlan } from './apiFailover';\nimport type { StoryCloudImageHandoffSpec } from './storyTheaterImage';\n",
    'backgroundStoryJobs import',
  );
  s = replaceOnce(
    s,
    "    onPromptTokens?: (tokens: number) => void;\n    onStreamText?: (fullText: string) => void;\n}",
    "    onPromptTokens?: (tokens: number) => void;\n    onStreamText?: (fullText: string) => void;\n    /** 已冻结的生图服务/预设/参考槽描述；随 story spec 一起加密存 Worker。 */\n    imageHandoff?: StoryCloudImageHandoffSpec;\n}",
    'backgroundStoryJobs options',
  );
  s = replaceOnce(
    s,
    "            baseBody: {\n                ...options.body,\n                stream: true,\n            },\n        };",
    "            baseBody: {\n                ...options.body,\n                stream: true,\n            },\n            ...(options.imageHandoff ? { imageHandoff: options.imageHandoff } : {}),\n        };",
    'backgroundStoryJobs spec',
  );
  write(path, s);
}

// 3) Local background-image monitor can adopt a job that Worker already submitted.
{
  const path = 'utils/backgroundImageJobs.ts';
  let s = read(path);
  const anchor = "export async function callMcpToolWithBackgroundImage(\n";
  const adopt = `export async function adoptBackgroundImageJob(\n    server: McpServerConfig,\n    toolName: string,\n    args: Record<string, any>,\n    remote: {\n        clientRequestId: string;\n        remoteJobId?: string;\n    },\n    context: {\n        charId: string;\n        ownerType?: 'chat' | 'story-theater';\n        storyTheaterTarget?: {\n            entryId: string;\n            messageId: number;\n            title: string;\n        };\n    },\n): Promise<McpToolResult> {\n    const clientRequestId = String(remote.clientRequestId || '').trim();\n    if (!clientRequestId) return { success: false, error: '云端生图任务缺少 clientRequestId' };\n    const { afterGenerateAction, cleanedArgs } = parseImageToolClientOptions(args);\n    if (!isBackgroundImageToolCall(server, toolName)) {\n        return { success: false, error: '云端生图任务对应的本地工具已不可用' };\n    }\n    const engineId = engineIdFromServer(server);\n    if (!engineId || !server.controlBaseUrl) {\n        return { success: false, error: '云端生图任务对应的本地服务配置不完整' };\n    }\n\n    const state = readState();\n    const existing = state.jobs.find(job => job.clientRequestId === clientRequestId);\n    if (existing) {\n        const updated = updateJob(existing.id, {\n            remoteJobId: remote.remoteJobId || existing.remoteJobId,\n            ownerType: context.ownerType === 'story-theater' ? 'story-theater' : existing.ownerType,\n            storyTheaterTarget: context.ownerType === 'story-theater'\n                ? context.storyTheaterTarget\n                : existing.storyTheaterTarget,\n            lastError: undefined,\n        }) || existing;\n        dispatchJobEvent('updated', updated);\n        void reconcileBackgroundImageJobs();\n        return queuedToolResult(updated, remote.remoteJobId ? ({\n            id: remote.remoteJobId,\n            clientRequestId,\n            toolName,\n            status: 'queued',\n            createdAt: updated.createdAt,\n            updatedAt: now(),\n        } as RemoteImageJob) : undefined);\n    }\n\n    const createdAt = now();\n    const localJob: LocalBackgroundImageJob = {\n        id: makeLocalId(),\n        clientRequestId,\n        remoteJobId: remote.remoteJobId,\n        engineId,\n        serverId: server.id,\n        serverName: server.name,\n        controlBaseUrl: normalizeBaseUrl(server.controlBaseUrl),\n        token: String(server.token || ''),\n        charId: context.charId,\n        ownerType: context.ownerType === 'story-theater' ? 'story-theater' : 'chat',\n        storyTheaterTarget: context.ownerType === 'story-theater' ? context.storyTheaterTarget : undefined,\n        toolName,\n        toolArgs: clone(cleanedArgs),\n        afterGenerateAction,\n        inspectStatus: afterGenerateAction === 'inspect' ? 'pending' : undefined,\n        status: remote.remoteJobId ? 'queued' : 'submitting',\n        createdAt,\n        updatedAt: createdAt,\n        // Worker 已经负责第一次 POST。没有 remote id 代表响应不确定，恢复器先 by-client 查，\n        // 确认不存在后也只会用这个同一 clientRequestId 补交。\n        submitAttempts: remote.remoteJobId ? 1 : 0,\n        imageBillingCapture: captureImageGenerationBilling(engineId),\n    };\n    upsertJob(localJob);\n    dispatchJobEvent('updated', localJob);\n    void reconcileBackgroundImageJobs();\n    return queuedToolResult(localJob, remote.remoteJobId ? ({\n        id: remote.remoteJobId,\n        clientRequestId,\n        toolName,\n        status: 'queued',\n        createdAt,\n        updatedAt: createdAt,\n    } as RemoteImageJob) : undefined);\n}\n\n`;
  s = replaceOnce(s, anchor, adopt + anchor, 'backgroundImageJobs adopt insertion');
  write(path, s);
}

// 4) Story image layer: freeze descriptors before lock, and adopt Worker-created image job after wake.
{
  const path = 'utils/storyTheaterImage.ts';
  let s = read(path);
  s = replaceOnce(
    s,
    "import { callMcpToolWithBackgroundImage } from './backgroundImageJobs';",
    "import { adoptBackgroundImageJob, callMcpToolWithBackgroundImage } from './backgroundImageJobs';",
    'storyTheaterImage bg import',
  );
  s = replaceOnce(
    s,
    "    applyImageGenerationPresetById,\n    isCharacterReferenceAllowedForActivePreset,\n} from './imageGenerationPresets';",
    "    applyImageGenerationPresetById,\n    getImageGenerationPresets,\n    isCharacterReferenceAllowedForActivePreset,\n} from './imageGenerationPresets';",
    'storyTheaterImage preset import',
  );
  const anchor = "const parseToolArgs = (call: any): Record<string, any> => {\n";
  const helpers = `export interface StoryCloudImageToolHandoff {\n    exposedName: string;\n    toolName: string;\n    engineId: 'gpt-image' | 'novelai';\n    controlBaseUrl: string;\n    token: string;\n    preset?: {\n        remoteConfig: Record<string, unknown>;\n        apiKey: string;\n    };\n    references?: {\n        actors?: Record<string, Record<string, unknown>>;\n        user?: Record<string, unknown>;\n        vibe?: Record<string, unknown>;\n    };\n}\n\nexport interface StoryCloudImageHandoffSpec {\n    version: 1;\n    tools: StoryCloudImageToolHandoff[];\n}\n\nexport interface StoryCloudImageHandoffResult {\n    state: 'submitted' | 'skipped' | 'failed';\n    exposedTool?: string;\n    toolName?: string;\n    clientRequestId?: string;\n    remoteJobId?: string;\n    arguments?: Record<string, any>;\n    uncertain?: boolean;\n    error?: string;\n}\n\nconst MANAGED_REFERENCE_KEYS = new Set([\n    'reference_id',\n    'reference_type',\n    'reference_strength',\n    'reference_fidelity',\n    'user_reference_id',\n    'user_reference_type',\n    'user_reference_strength',\n    'user_reference_fidelity',\n    'vibe_reference_id',\n    'vibe_reference_strength',\n    'vibe_reference_information_extracted',\n]);\n\nconst pickManagedReferenceFragment = (args: Record<string, any>): Record<string, unknown> => {\n    const out: Record<string, unknown> = {};\n    for (const [key, value] of Object.entries(args || {})) {\n        if (MANAGED_REFERENCE_KEYS.has(key)) out[key] = value;\n    }\n    return out;\n};\n\n/**\n * 在正文 story job 提交前冻结“这轮可能会选到的生图服务”。\n * 凭据只进入加密 story request，不会回显；NovelAI 参考图也在这里先确保远端槽位存在，\n * 这样用户提交正文后立刻锁屏，Worker 仍有足够信息独立把图片 /jobs 接上。\n */\nexport const buildStoryCloudImageHandoffSpec = async (input: {\n    actors: CharacterProfile[];\n    userProfile: UserProfile;\n}): Promise<StoryCloudImageHandoffSpec | undefined> => {\n    if (!input.actors.length) return undefined;\n    const imageTools = resolveStoryImageTools(input.actors);\n    const presets = getImageGenerationPresets();\n    const tools: StoryCloudImageToolHandoff[] = [];\n\n    for (const [exposedName, hit] of imageTools.resolve) {\n        const controlBaseUrl = String(hit.server.controlBaseUrl || '').trim().replace(/\\/+$/, '');\n        if (!/^https?:\\/\\//i.test(controlBaseUrl)) continue;\n        const engineId = hit.server.imagePresetEngineId === 'novelai' || hit.toolName === 'novelai_generate_image'\n            ? 'novelai'\n            : 'gpt-image';\n        const preset = hit.server.imagePresetId\n            ? presets.find(item => item.id === hit.server.imagePresetId)\n            : undefined;\n        const descriptor: StoryCloudImageToolHandoff = {\n            exposedName,\n            toolName: hit.toolName,\n            engineId,\n            controlBaseUrl,\n            token: String(hit.server.token || ''),\n            ...(preset ? {\n                preset: {\n                    remoteConfig: JSON.parse(JSON.stringify(preset.remoteConfig || {})),\n                    apiKey: String(preset.apiKey || ''),\n                },\n            } : {}),\n        };\n\n        if (engineId === 'novelai') {\n            const references: NonNullable<StoryCloudImageToolHandoff['references']> = {};\n            const actorFragments: Record<string, Record<string, unknown>> = {};\n            for (const actor of input.actors) {\n                if (!actor.novelAiReference?.enabled) continue;\n                try {\n                    const prepared = await prepareBuiltinImageToolArguments({\n                        server: hit.server,\n                        toolName: hit.toolName,\n                        args: {\n                            prompt: '__story_cloud_reference_probe__',\n                            use_character_reference: true,\n                            use_user_reference: false,\n                            use_vibe_reference: false,\n                        },\n                        character: actor,\n                        userProfile: input.userProfile,\n                    });\n                    const fragment = pickManagedReferenceFragment(prepared);\n                    if (Object.keys(fragment).length) actorFragments[actor.id] = fragment;\n                } catch (error) {\n                    console.warn('[StoryTheater] cloud image actor reference preflight skipped', actor.id, error);\n                }\n            }\n            if (Object.keys(actorFragments).length) references.actors = actorFragments;\n\n            if (input.userProfile.novelAiReference?.enabled) {\n                try {\n                    const prepared = await prepareBuiltinImageToolArguments({\n                        server: hit.server,\n                        toolName: hit.toolName,\n                        args: {\n                            prompt: '__story_cloud_user_reference_probe__',\n                            use_character_reference: false,\n                            use_user_reference: true,\n                            use_vibe_reference: false,\n                        },\n                        character: input.actors[0],\n                        userProfile: input.userProfile,\n                    });\n                    const fragment = pickManagedReferenceFragment(prepared);\n                    if (Object.keys(fragment).length) references.user = fragment;\n                } catch (error) {\n                    console.warn('[StoryTheater] cloud image user reference preflight skipped', error);\n                }\n            }\n\n            try {\n                const prepared = await prepareBuiltinImageToolArguments({\n                    server: hit.server,\n                    toolName: hit.toolName,\n                    args: {\n                        prompt: '__story_cloud_vibe_reference_probe__',\n                        use_character_reference: false,\n                        use_user_reference: false,\n                        use_vibe_reference: true,\n                    },\n                    character: input.actors[0],\n                    userProfile: input.userProfile,\n                });\n                const fragment = pickManagedReferenceFragment(prepared);\n                if (Object.keys(fragment).some(key => key.startsWith('vibe_'))) references.vibe = fragment;\n            } catch (error) {\n                console.warn('[StoryTheater] cloud image vibe reference preflight skipped', error);\n            }\n            if (Object.keys(references).length) descriptor.references = references;\n        }\n        tools.push(descriptor);\n    }\n    return tools.length ? { version: 1, tools } : undefined;\n};\n\nexport const adoptStoryCloudImageHandoff = async (input: {\n    entry: StoryTheaterEntry;\n    actors: CharacterProfile[];\n    handoff: StoryCloudImageHandoffResult;\n    inlinePlan?: StoryInlineImagePlan;\n    targetMessageId: number;\n}): Promise<StoryTheaterImageGenerationResult> => {\n    if (input.handoff.state !== 'submitted' || !input.handoff.clientRequestId) {\n        throw new Error('云端没有可接回的生图任务');\n    }\n    const imageTools = resolveStoryImageTools(input.actors);\n    const exposedName = String(input.handoff.exposedTool || input.inlinePlan?.tool || '').trim();\n    const selected = imageTools.resolve.get(exposedName);\n    if (!selected) throw new Error('云端已经提交配图，但本机已找不到对应生图预设；为避免重复扣费不会重新生成');\n    const toolName = String(input.handoff.toolName || selected.toolName);\n    const args = input.handoff.arguments && typeof input.handoff.arguments === 'object'\n        ? input.handoff.arguments\n        : (input.inlinePlan?.arguments || {});\n    const result = await adoptBackgroundImageJob(\n        selected.server,\n        toolName,\n        args,\n        {\n            clientRequestId: input.handoff.clientRequestId,\n            remoteJobId: input.handoff.remoteJobId,\n        },\n        {\n            charId: storyTheaterThreadId(input.entry.id),\n            ownerType: 'story-theater',\n            storyTheaterTarget: {\n                entryId: input.entry.id,\n                messageId: input.targetMessageId,\n                title: input.entry.title || '剧情剧场',\n            },\n        },\n    );\n    if (!result.success || !result.backgroundJob) {\n        throw new Error(result.error || '云端生图任务接回失败');\n    }\n    return {\n        queued: {\n            localJobId: result.backgroundJob.localJobId,\n            clientRequestId: result.backgroundJob.clientRequestId,\n        },\n    };\n};\n\n`;
  s = replaceOnce(s, anchor, helpers + anchor, 'storyTheaterImage cloud helpers');
  write(path, s);
}

// 5) Story UI wires descriptor into cloud job and adopts the already-submitted image job.
{
  const path = 'components/date/story/StoryTheaterSession.tsx';
  let s = read(path);
  s = replaceOnce(
    s,
    "    buildStoryInlineImagePlanInstruction,\n    generateStoryTheaterImage,\n    parseStoryInlineImagePlan,\n    resolveStoryImagePlannerApiConfig,\n    storyInlineImageVisibleText,\n} from '../../../utils/storyTheaterImage';",
    "    adoptStoryCloudImageHandoff,\n    buildStoryCloudImageHandoffSpec,\n    buildStoryInlineImagePlanInstruction,\n    generateStoryTheaterImage,\n    parseStoryInlineImagePlan,\n    resolveStoryImagePlannerApiConfig,\n    storyInlineImageVisibleText,\n    type StoryCloudImageHandoffResult,\n    type StoryCloudImageHandoffSpec,\n} from '../../../utils/storyTheaterImage';",
    'StoryTheaterSession image imports',
  );
  s = replaceOnce(
    s,
    "            meta?: Record<string, any>;\n            beforeRelease?: () => Promise<void> | void;\n        },",
    "            meta?: Record<string, any>;\n            imageHandoff?: StoryCloudImageHandoffSpec;\n            onCloudCompleted?: (data: any) => void;\n            beforeRelease?: () => Promise<void> | void;\n        },",
    'StoryTheaterSession background type',
  );
  s = replaceOnce(
    s,
    "                    meta: background.meta,\n                    onPromptTokens,",
    "                    meta: background.meta,\n                    imageHandoff: background.imageHandoff,\n                    onPromptTokens,",
    'StoryTheaterSession cloud option',
  );
  s = replaceOnce(
    s,
    "                    } : undefined,\n                });\n            } else if (useNativeEventSourceTransport && background) {",
    "                    } : undefined,\n                });\n                background.onCloudCompleted?.(data);\n            } else if (useNativeEventSourceTransport && background) {",
    'StoryTheaterSession cloud callback',
  );
  s = replaceOnce(
    s,
    "            const modelInput = appendStoryAffinityInputs(modelText, affinityInputs);",
    "            let cloudImageHandoffSpec: StoryCloudImageHandoffSpec | undefined;\n            if (entry.imageGeneration?.enabled && inlineImagePlanInstruction) {\n                try {\n                    cloudImageHandoffSpec = await buildStoryCloudImageHandoffSpec({ actors, userProfile });\n                } catch (cloudImageSetupError) {\n                    // 云端接力准备失败不影响正文；正文回来后仍走现有客户端配图兜底。\n                    console.warn('[StoryTheater] cloud image handoff preflight unavailable', cloudImageSetupError);\n                }\n            }\n            let cloudImageHandoffResult: StoryCloudImageHandoffResult | undefined;\n            const modelInput = appendStoryAffinityInputs(modelText, affinityInputs);",
    'StoryTheaterSession handoff preflight',
  );
  s = replaceOnce(
    s,
    "                meta: {\n                    ...(isReroll && rerollTarget ? { rerollTargetId: rerollTarget.id } : {}),",
    "                imageHandoff: cloudImageHandoffSpec,\n                onCloudCompleted: data => {\n                    const raw = data?._sullyStoryImageHandoff;\n                    if (raw && typeof raw === 'object') cloudImageHandoffResult = raw as StoryCloudImageHandoffResult;\n                },\n                meta: {\n                    ...(isReroll && rerollTarget ? { rerollTargetId: rerollTarget.id } : {}),",
    'StoryTheaterSession handoff callback',
  );
  const oldImage = `                    const imageResult = await generateStoryTheaterImage({\n                        apiConfig,\n                        plannerApiConfig: resolveStoryImagePlannerApiConfig(entry, apiConfig, apiPresets),\n                        entry,\n                        actors,\n                        userProfile,\n                        userName: promptIdentityName,\n                        messages: imageRows,\n                        inlinePlan: inlineImagePlan,\n                        targetMessageId: assistantMessageId,\n                    });`;
  const newImage = `                    const imageResult = cloudImageHandoffResult?.state === 'submitted'\n                        ? await adoptStoryCloudImageHandoff({\n                            entry,\n                            actors,\n                            handoff: cloudImageHandoffResult,\n                            inlinePlan: inlineImagePlan,\n                            targetMessageId: assistantMessageId,\n                        })\n                        : await generateStoryTheaterImage({\n                            apiConfig,\n                            plannerApiConfig: resolveStoryImagePlannerApiConfig(entry, apiConfig, apiPresets),\n                            entry,\n                            actors,\n                            userProfile,\n                            userName: promptIdentityName,\n                            messages: imageRows,\n                            inlinePlan: inlineImagePlan,\n                            targetMessageId: assistantMessageId,\n                        });`;
  s = replaceOnce(s, oldImage, newImage, 'StoryTheaterSession image adopt');
  write(path, s);
}

console.log('story cloud image handoff patch applied');
