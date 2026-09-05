from pathlib import Path

p = Path('utils/backgroundImageJobs.ts')
s = p.read_text()

# Import ActiveMsgClient so a worker-owned image handoff can read the story job's final handoff state.
old = "import { DB } from './db';\n"
new = "import { DB } from './db';\nimport { ActiveMsgClient } from './activeMsgClient';\n"
assert old in s
s = s.replace(old, new, 1)

# Remove the fixed 45s client fallback window entirely.
old = """const MAX_RECONCILE_FAILURES = 12;\n// 云端剧情正文会先把稳定的 image handoff 身份交给手机，再由 Worker 紧接着 POST /jobs。\n// 手机在这段宽限期只做 by-client 查询，不能和 Worker 抢首发，否则同一张图可能被并发提交两次。\nconst CLOUD_STORY_INITIAL_SUBMIT_GRACE_MS = 45_000;\n"""
new = """const MAX_RECONCILE_FAILURES = 12;\n"""
assert old in s
s = s.replace(old, new, 1)

old = """    lastCheckedAt?: number;\n    submitAttempts: number;\n    /** adopt 云端任务时，早于此时间只允许查询，不允许客户端首发 POST /jobs。 */\n    submitNotBefore?: number;\n    resultAppliedAt?: number;\n"""
new = """    lastCheckedAt?: number;\n    submitAttempts: number;\n    /** 云端剧情 handoff 由 Worker 独占首发权；客户端只查状态，永不自动补交。 */\n    workerOwnsSubmission?: boolean;\n    resultAppliedAt?: number;\n"""
assert old in s
s = s.replace(old, new, 1)

old = """        submitAttempts:\n            Number.isFinite(raw.submitAttempts)\n                ? Math.max(0, raw.submitAttempts)\n                : 0,\n        submitNotBefore:\n            Number.isFinite(raw.submitNotBefore)\n                ? Number(raw.submitNotBefore)\n                : undefined,\n        resultAppliedAt:\n"""
new = """        submitAttempts:\n            Number.isFinite(raw.submitAttempts)\n                ? Math.max(0, raw.submitAttempts)\n                : 0,\n        // 兼容 2.3.204：旧版的 submitNotBefore 只会出现在云端剧情 adopt 任务上。\n        workerOwnsSubmission:\n            raw.workerOwnsSubmission === true\n            || (raw.ownerType === 'story-theater' && Number.isFinite(raw.submitNotBefore)),\n        resultAppliedAt:\n"""
assert old in s
s = s.replace(old, new, 1)

# Add a best-effort lookup of the final story Worker handoff. This is how explicit pre-submit failures
# reach the phone without allowing the phone to POST /jobs itself.
anchor = """const getRemoteJobById = async (\n    job: LocalBackgroundImageJob,\n): Promise<RemoteImageJob | null> => {\n    if (!job.remoteJobId) return null;\n\n    try {\n        const body = await fetchJson(\n            `${normalizeBaseUrl(job.controlBaseUrl)}`\n            + `/jobs/`\n            + encodeURIComponent(\n                job.remoteJobId,\n            ),\n            job.token,\n        );\n\n        return body?.job || null;\n    } catch (error) {\n        if (isRemoteJobNotFoundError(error)) return null;\n        throw error;\n    }\n};\n\n"""
assert anchor in s
addition = anchor + """interface WorkerStoryImageHandoffState {\n    state?: 'submitted' | 'failed' | 'skipped';\n    remoteJobId?: string;\n    error?: string;\n    uncertain?: boolean;\n}\n\nconst getWorkerStoryImageHandoff = async (\n    job: LocalBackgroundImageJob,\n): Promise<WorkerStoryImageHandoffState | null> => {\n    if (!job.workerOwnsSubmission) return null;\n    const imageClientRequestId = String(job.clientRequestId || '');\n    if (!imageClientRequestId.startsWith('storyimg_')) return null;\n    const storyClientRequestId = imageClientRequestId.slice('storyimg_'.length);\n    if (!storyClientRequestId) return null;\n\n    try {\n        const config = await ActiveMsgClient.getGlobalConfig();\n        const workerUrl = String(config.workerUrl || '').trim().replace(/\\/+$/, '');\n        const userId = String(config.userId || '').trim();\n        if (!/^https?:\\/\\//i.test(workerUrl) || !userId) return null;\n\n        const headers = new Headers({\n            Accept: 'application/json',\n            'X-User-Id': userId,\n        });\n        const serverToken = String(config.serverToken || '').trim();\n        if (serverToken) headers.set('X-Client-Token', serverToken);\n\n        const controller = new AbortController();\n        const timeout = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);\n        try {\n            const response = await fetch(\n                `${workerUrl}/story-jobs/by-client/${encodeURIComponent(storyClientRequestId)}`,\n                {\n                    method: 'GET',\n                    headers,\n                    cache: 'no-store',\n                    signal: controller.signal,\n                },\n            );\n            if (!response.ok) return null;\n            const body = await response.json().catch(() => null);\n            const handoff = body?.job?.response?._sullyStoryImageHandoff;\n            return handoff && typeof handoff === 'object'\n                ? handoff as WorkerStoryImageHandoffState\n                : null;\n        } finally {\n            clearTimeout(timeout);\n        }\n    } catch {\n        // 这里只是补充 Worker 的最终 handoff 诊断；查询失败不应制造第二张图，也不应误判图片失败。\n        return null;\n    }\n};\n\n"""
s = s.replace(anchor, addition, 1)

old = """        if (!remoteJob) {\n            // adopt 的云端剧情 handoff 可能比 Worker 真正 POST /jobs 早几十毫秒到几秒抵达手机。\n            // 宽限期内每轮仍先执行上面的 by-client 查询，但查不到也绝不由手机抢首发。\n            // 只有 Worker 长时间没有创建任务，才允许客户端用同一 clientRequestId 做灾备补交。\n            if (Number(localJob.submitNotBefore || 0) > now()) {\n                updateJob(localJob.id, {\n                    status: 'submitting',\n                    lastCheckedAt: now(),\n                    lastError: undefined,\n                });\n                return;\n            }\n\n            if (localJob.submitAttempts >= MAX_SUBMIT_ATTEMPTS) {\n"""
new = """        if (!remoteJob) {\n            if (localJob.workerOwnsSubmission) {\n                // 云端剧情自动配图只有 Worker 能首发。手机永远只查账，不再用任何固定时间猜测\n                // “Worker 可能挂了”然后补 POST。Worker 明确失败时，从 story job 的最终 handoff\n                // 把失败同步回来；用户需要重试时手动点“重新生成”。\n                const storyHandoff = await getWorkerStoryImageHandoff(localJob);\n                if (storyHandoff?.state === 'failed') {\n                    await markMonitoredJobFailed(\n                        localJob.id,\n                        storyHandoff.error || '剧情后台自动配图提交失败',\n                        options,\n                    );\n                    return;\n                }\n                if (storyHandoff?.state === 'submitted' && storyHandoff.remoteJobId) {\n                    const linked = updateJob(localJob.id, {\n                        remoteJobId: storyHandoff.remoteJobId,\n                        status: 'queued',\n                        lastCheckedAt: now(),\n                        lastError: undefined,\n                    });\n                    if (linked) remoteJob = await getRemoteJobById(linked);\n                }\n                if (!remoteJob) {\n                    updateJob(localJob.id, {\n                        status: 'submitting',\n                        lastCheckedAt: now(),\n                        lastError: undefined,\n                    });\n                    return;\n                }\n            }\n\n            if (localJob.submitAttempts >= MAX_SUBMIT_ATTEMPTS) {\n"""
assert old in s
s = s.replace(old, new, 1)

old = """            lastCheckedAt: now(),\n            lastError: remoteJob.error?.message,\n            submitNotBefore: undefined,\n        });\n"""
new = """            lastCheckedAt: now(),\n            lastError: remoteJob.error?.message,\n        });\n"""
assert old in s
s = s.replace(old, new, 1)

old = """            // 已拿到 remote id 就立即解除宽限；否则保留/建立 Worker 首发窗口。\n            submitNotBefore: remote.remoteJobId\n                ? undefined\n                : (existing.submitNotBefore || now() + CLOUD_STORY_INITIAL_SUBMIT_GRACE_MS),\n            lastError: undefined,\n"""
new = """            workerOwnsSubmission: true,\n            lastError: undefined,\n"""
assert old in s
s = s.replace(old, new, 1)

old = """        // Worker 负责第一次 POST。没有 remote id 时客户端先只查询；\n        // 45 秒仍查不到才用同一 clientRequestId 灾备补交，避免两端并发双提交。\n        submitAttempts: remote.remoteJobId ? 1 : 0,\n        submitNotBefore: remote.remoteJobId\n            ? undefined\n            : createdAt + CLOUD_STORY_INITIAL_SUBMIT_GRACE_MS,\n        imageBillingCapture: captureImageGenerationBilling(engineId),\n"""
new = """        // Worker 独占自动配图的第一次 POST；客户端只按同一 clientRequestId / remoteJobId 查状态。\n        // 自动流程永不补交，失败后由用户手动“重新生成”。\n        submitAttempts: remote.remoteJobId ? 1 : 0,\n        workerOwnsSubmission: true,\n        imageBillingCapture: captureImageGenerationBilling(engineId),\n"""
assert old in s
s = s.replace(old, new, 1)

# Adopted cloud handoffs should not run an immediate reconcile with empty callbacks; the global monitor
# will pick them up within 4s and can surface onFailed/onCompleted consistently.
s = s.replace("""        dispatchJobEvent('updated', updated);\n        void reconcileBackgroundImageJobs();\n        return queuedToolResult(updated, remote.remoteJobId ? ({\n""", """        dispatchJobEvent('updated', updated);\n        return queuedToolResult(updated, remote.remoteJobId ? ({\n""", 1)
s = s.replace("""    upsertJob(localJob);\n    dispatchJobEvent('updated', localJob);\n    void reconcileBackgroundImageJobs();\n    return queuedToolResult(localJob, remote.remoteJobId ? ({\n""", """    upsertJob(localJob);\n    dispatchJobEvent('updated', localJob);\n    return queuedToolResult(localJob, remote.remoteJobId ? ({\n""", 1)

p.write_text(s)
