from pathlib import Path

p = Path('worker/amsg/src/storyJobs.ts')
s = p.read_text()

needle = "} from './storyImageHandoff';\n"
replacement = "} from './storyImageHandoff';\nimport { sendStoryBackgroundStatusPush } from './storyStatusPush';\n"
assert needle in s
s = s.replace(needle, replacement, 1)

old_env = """export interface StoryJobsEnv {\n  AMSG_MASTER_KEY: string;\n  AMSG_SERVER_TOKEN?: string;\n  DB: StoryJobsDb;\n  INSTANT_TICK?: StoryTickNamespace;\n}\n"""
new_env = """export interface StoryJobsEnv {\n  AMSG_MASTER_KEY: string;\n  AMSG_SERVER_TOKEN?: string;\n  VAPID_EMAIL?: string;\n  VAPID_PUBLIC_KEY?: string;\n  VAPID_PRIVATE_KEY?: string;\n  FCM_PROJECT_ID?: string;\n  FCM_SERVICE_ACCOUNT_EMAIL?: string;\n  FCM_SERVICE_ACCOUNT_PRIVATE_KEY?: string;\n  DB: StoryJobsDb;\n  INSTANT_TICK?: StoryTickNamespace;\n}\n"""
assert old_env in s
s = s.replace(old_env, new_env, 1)

row_end = """interface StoryAttempt {\n"""
helper = """const storyStatusJob = (row: StoryJobRow) => ({\n  jobId: row.job_id,\n  userId: row.user_id,\n  clientRequestId: row.client_request_id,\n  ownerKey: row.owner_key,\n  title: row.title,\n});\n\ninterface StoryAttempt {\n"""
assert row_end in s
s = s.replace(row_end, helper, 1)

fail_tail = """    row.user_id,\n    row.job_id,\n  ).run();\n};\n\nexport const runStoryJob = async (\n"""
fail_new = """    row.user_id,\n    row.job_id,\n  ).run();\n  await sendStoryBackgroundStatusPush(\n    env as any,\n    storyStatusJob(row),\n    'failed',\n    error,\n  );\n};\n\nexport const runStoryJob = async (\n"""
assert fail_tail in s
s = s.replace(fail_tail, fail_new, 1)

running = """  const liveRow = { ...row, status: 'running' as StoryJobStatus, started_at: startedAt, updated_at: startedAt };\n  let spec: StoryJobSpec;\n"""
running_new = """  const liveRow = { ...row, status: 'running' as StoryJobStatus, started_at: startedAt, updated_at: startedAt };\n  // 状态通知与模型请求并行起跑，不允许为了弹通知拖慢正文首字。\n  void sendStoryBackgroundStatusPush(env as any, storyStatusJob(liveRow), 'running');\n  let spec: StoryJobSpec;\n"""
assert running in s
s = s.replace(running, running_new, 1)

success_anchor = """      ).run();\n\n      // 正文已经对客户端可见以后，再完成真正的生图 handoff。\n"""
success_new = """      ).run();\n\n      // D1 已经是 succeeded 才发完成通知；通知失败绝不影响正文，也不等待后面的配图尾活。\n      await sendStoryBackgroundStatusPush(\n        env as any,\n        storyStatusJob({ ...liveRow, status: 'succeeded', completed_at: finishedAt, updated_at: finishedAt }),\n        'succeeded',\n      );\n\n      // 正文已经对客户端可见以后，再完成真正的生图 handoff。\n"""
assert success_anchor in s
s = s.replace(success_anchor, success_new, 1)

p.write_text(s)

# 结果类 push 只负责系统通知，不得被客户端当聊天正文落库。
p = Path('utils/amsgResults.ts')
s = p.read_text()
import_anchor = "import { SCHEDULE_CHANGE_RESULT_KIND } from './amsgScheduleResult';\n"
import_new = import_anchor + "import { STORY_BACKGROUND_STATUS_RESULT_KIND } from './storyBackgroundStatus';\n"
assert import_anchor in s
s = s.replace(import_anchor, import_new, 1)
case_anchor = """      case SCHEDULE_CHANGE_RESULT_KIND: {\n        const { applyScheduleChangeResult } = await import('./amsgScheduleResultApply');\n        return await applyScheduleChangeResult(payload, context);\n      }\n"""
case_new = case_anchor + """      case STORY_BACKGROUND_STATUS_RESULT_KIND:\n        // 这类 result 的正文就是 Android / Web Push 系统通知本身；客户端只认领后销账，\n        // 绝不能把“正在生成/生成完成”当成角色聊天消息落库。\n        return true;\n"""
assert case_anchor in s
s = s.replace(case_anchor, case_new, 1)
p.write_text(s)

# 原生轮询备用通道也按 payload.messageId 更新同一条通知；不能用每次队列自增 id 刷三条。
p = Path('native/android/SullyAmsgPollService.java')
s = p.read_text()
old = """            Intent launch = getPackageManager().getLaunchIntentForPackage(getPackageName());\n            PendingIntent pending = PendingIntent.getActivity(this, (int) (id & 0x7fffffff), launch, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);\n            NotificationCompat.Builder notification = new NotificationCompat.Builder(this, \"amsg2\")\n"""
new = """            String messageId = payload.optString(\"messageId\", \"\");\n            int notificationId = messageId.isEmpty()\n                ? (int) (id & 0x7fffffff)\n                : (messageId.hashCode() & 0x7fffffff);\n            Intent launch = getPackageManager().getLaunchIntentForPackage(getPackageName());\n            PendingIntent pending = PendingIntent.getActivity(this, notificationId, launch, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);\n            NotificationCompat.Builder notification = new NotificationCompat.Builder(this, \"amsg2\")\n"""
assert old in s
s = s.replace(old, new, 1)
s = s.replace("getSystemService(NotificationManager.class).notify((int) (id & 0x7fffffff), notification.build());", "getSystemService(NotificationManager.class).notify(notificationId, notification.build());", 1)
p.write_text(s)
