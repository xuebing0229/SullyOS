from pathlib import Path

# 1) Cloud story image adoption: Worker owns the first /jobs POST for a short grace window.
p = Path('utils/backgroundImageJobs.ts')
s = p.read_text()

old = """const MAX_RECONCILE_FAILURES = 12;\n"""
new = """const MAX_RECONCILE_FAILURES = 12;\n// 云端剧情正文会先把稳定的 image handoff 身份交给手机，再由 Worker 紧接着 POST /jobs。\n// 手机在这段宽限期只做 by-client 查询，不能和 Worker 抢首发，否则同一张图可能被并发提交两次。\nconst CLOUD_STORY_INITIAL_SUBMIT_GRACE_MS = 45_000;\n"""
assert old in s, 'constant anchor not found'
s = s.replace(old, new, 1)

old = """    lastCheckedAt?: number;\n    submitAttempts: number;\n    resultAppliedAt?: number;\n"""
new = """    lastCheckedAt?: number;\n    submitAttempts: number;\n    /** adopt 云端任务时，早于此时间只允许查询，不允许客户端首发 POST /jobs。 */\n    submitNotBefore?: number;\n    resultAppliedAt?: number;\n"""
assert old in s, 'job interface anchor not found'
s = s.replace(old, new, 1)

old = """        submitAttempts:\n            Number.isFinite(raw.submitAttempts)\n                ? Math.max(0, raw.submitAttempts)\n                : 0,\n        resultAppliedAt:\n"""
new = """        submitAttempts:\n            Number.isFinite(raw.submitAttempts)\n                ? Math.max(0, raw.submitAttempts)\n                : 0,\n        submitNotBefore:\n            Number.isFinite(raw.submitNotBefore)\n                ? Number(raw.submitNotBefore)\n                : undefined,\n        resultAppliedAt:\n"""
assert old in s, 'sanitize anchor not found'
s = s.replace(old, new, 1)

old = """        if (!remoteJob) {\n            if (localJob.submitAttempts >= MAX_SUBMIT_ATTEMPTS) {\n"""
new = """        if (!remoteJob) {\n            // adopt 的云端剧情 handoff 可能比 Worker 真正 POST /jobs 早几十毫秒到几秒抵达手机。\n            // 宽限期内每轮仍先执行上面的 by-client 查询，但查不到也绝不由手机抢首发。\n            // 只有 Worker 长时间没有创建任务，才允许客户端用同一 clientRequestId 做灾备补交。\n            if (Number(localJob.submitNotBefore || 0) > now()) {\n                updateJob(localJob.id, {\n                    status: 'submitting',\n                    lastCheckedAt: now(),\n                    lastError: undefined,\n                });\n                return;\n            }\n\n            if (localJob.submitAttempts >= MAX_SUBMIT_ATTEMPTS) {\n"""
assert old in s, 'reconcile submit anchor not found'
s = s.replace(old, new, 1)

old = """        const updated = updateJob(localJob.id, {\n            remoteJobId: remoteJob.id,\n            status: remoteStatusToLocal(remoteJob.status),\n            lastCheckedAt: now(),\n            lastError: remoteJob.error?.message,\n        });\n"""
new = """        const updated = updateJob(localJob.id, {\n            remoteJobId: remoteJob.id,\n            status: remoteStatusToLocal(remoteJob.status),\n            lastCheckedAt: now(),\n            lastError: remoteJob.error?.message,\n            submitNotBefore: undefined,\n        });\n"""
assert old in s, 'remote update anchor not found'
s = s.replace(old, new, 1)

old = """        const updated = updateJob(existing.id, {\n            remoteJobId: remote.remoteJobId || existing.remoteJobId,\n            ownerType: context.ownerType === 'story-theater' ? 'story-theater' : existing.ownerType,\n            storyTheaterTarget: context.ownerType === 'story-theater'\n                ? context.storyTheaterTarget\n                : existing.storyTheaterTarget,\n            lastError: undefined,\n        }) || existing;\n"""
new = """        const updated = updateJob(existing.id, {\n            remoteJobId: remote.remoteJobId || existing.remoteJobId,\n            ownerType: context.ownerType === 'story-theater' ? 'story-theater' : existing.ownerType,\n            storyTheaterTarget: context.ownerType === 'story-theater'\n                ? context.storyTheaterTarget\n                : existing.storyTheaterTarget,\n            // 已拿到 remote id 就立即解除宽限；否则保留/建立 Worker 首发窗口。\n            submitNotBefore: remote.remoteJobId\n                ? undefined\n                : (existing.submitNotBefore || now() + CLOUD_STORY_INITIAL_SUBMIT_GRACE_MS),\n            lastError: undefined,\n        }) || existing;\n"""
assert old in s, 'adopt existing anchor not found'
s = s.replace(old, new, 1)

old = """        // Worker 已经负责第一次 POST。没有 remote id 代表响应不确定，恢复器先 by-client 查，\n        // 确认不存在后也只会用这个同一 clientRequestId 补交。\n        submitAttempts: remote.remoteJobId ? 1 : 0,\n        imageBillingCapture: captureImageGenerationBilling(engineId),\n"""
new = """        // Worker 负责第一次 POST。没有 remote id 时客户端先只查询；\n        // 45 秒仍查不到才用同一 clientRequestId 灾备补交，避免两端并发双提交。\n        submitAttempts: remote.remoteJobId ? 1 : 0,\n        submitNotBefore: remote.remoteJobId\n            ? undefined\n            : createdAt + CLOUD_STORY_INITIAL_SUBMIT_GRACE_MS,\n        imageBillingCapture: captureImageGenerationBilling(engineId),\n"""
assert old in s, 'adopt created anchor not found'
s = s.replace(old, new, 1)

p.write_text(s)

# 2) Automatic Story Theater turns must not make a second Gemini planner request.
p = Path('components/date/story/StoryTheaterSession.tsx')
s = p.read_text()
old = """                    const imageResult = cloudImageHandoffResult?.state === 'submitted'\n                        ? await adoptStoryCloudImageHandoff({\n                            entry,\n                            actors,\n                            handoff: cloudImageHandoffResult,\n                            inlinePlan: inlineImagePlan,\n                            targetMessageId: assistantMessageId,\n                        })\n                        : await generateStoryTheaterImage({\n                            apiConfig,\n                            plannerApiConfig: resolveStoryImagePlannerApiConfig(entry, apiConfig, apiPresets),\n                            entry,\n                            actors,\n                            userProfile,\n                            userName: promptIdentityName,\n                            messages: imageRows,\n                            inlinePlan: inlineImagePlan,\n                            targetMessageId: assistantMessageId,\n                        });\n                    if (imageResult.frame) {\n                        await DB.updateMessageMetadata(assistantMessageId, previous => ({ ...previous, theaterImage: imageResult.frame }));\n                        await loadMessages();\n                    } else if (imageResult.queued) {\n                        addToast('剧情配图已进入后台生成，完成后会自动挂回本轮正文', 'info');\n                    }\n"""
new = """                    // 自动轮次只接受“正文同一次 completion”给出的 inline plan / Worker handoff。\n                    // 主剧情模型偶发漏掉隐藏 plan 时，不再偷偷多打一遍 Gemini「剧情自动配图规划」；\n                    // 手动“重新生成配图”仍保留旧规划器兜底。\n                    const imageResult = cloudImageHandoffResult?.state === 'submitted'\n                        ? await adoptStoryCloudImageHandoff({\n                            entry,\n                            actors,\n                            handoff: cloudImageHandoffResult,\n                            inlinePlan: inlineImagePlan,\n                            targetMessageId: assistantMessageId,\n                        })\n                        : inlineImagePlan\n                            ? await generateStoryTheaterImage({\n                                apiConfig,\n                                plannerApiConfig: resolveStoryImagePlannerApiConfig(entry, apiConfig, apiPresets),\n                                entry,\n                                actors,\n                                userProfile,\n                                userName: promptIdentityName,\n                                messages: imageRows,\n                                inlinePlan: inlineImagePlan,\n                                targetMessageId: assistantMessageId,\n                            })\n                            : undefined;\n                    if (!imageResult) {\n                        console.warn('[StoryTheater] automatic image skipped because story completion omitted inline image plan', {\n                            requestKey: activeRequestKey,\n                            cloudHandoffState: cloudImageHandoffResult?.state,\n                        });\n                        addToast('主剧情模型本轮漏掉了配图计划；已停止额外调用“剧情自动配图规划”API，避免重复请求。可以手动点「重新生成」补图。', 'info');\n                    } else if (imageResult.frame) {\n                        await DB.updateMessageMetadata(assistantMessageId, previous => ({ ...previous, theaterImage: imageResult.frame }));\n                        await loadMessages();\n                    } else if (imageResult.queued) {\n                        addToast('剧情配图已进入后台生成，完成后会自动挂回本轮正文', 'info');\n                    }\n"""
assert old in s, 'automatic image caller anchor not found'
s = s.replace(old, new, 1)
p.write_text(s)
