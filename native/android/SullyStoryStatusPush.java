package __APP_ID__.plugins;

import android.content.Context;
import android.util.Log;
import org.json.JSONObject;

/**
 * 主动消息 native 通道与剧情状态牌之间的唯一分流点。
 *
 * 返回 true 表示这是一条 story-status：调用方仍应保存/转发 payload 给 WebView，
 * 但不能再弹普通主动消息通知。running 只由现有 monitor 状态牌表示；终态则
 * 通过 monitor 自己的 ACTION_FINISH 广播原地收口。
 */
public final class SullyStoryStatusPush {
    private static final String TAG = "SullyStoryStatusPush";

    private SullyStoryStatusPush() { }

    public static boolean handle(Context context, String rawPayload) {
        try {
            JSONObject payload = new JSONObject(rawPayload == null ? "" : rawPayload);
            JSONObject metadata = payload.optJSONObject("metadata");
            boolean marked = "story-background".equals(payload.optString("messageType", ""))
                || "story-background-status".equals(payload.optString("resultKind", ""))
                || (metadata != null && metadata.optBoolean("amsgStoryBackgroundStatus", false));

            String status = firstNonEmpty(
                payload.optString("storyStatus", ""),
                metadata == null ? "" : metadata.optString("storyStatus", "")
            );
            if (!marked && status.isEmpty()) return false;

            if (isTerminal(status)) {
                String jobId = firstNonEmpty(
                    payload.optString("storyJobId", ""),
                    metadata == null ? "" : metadata.optString("storyJobId", "")
                );
                String clientRequestId = firstNonEmpty(
                    payload.optString("storyClientRequestId", ""),
                    metadata == null ? "" : metadata.optString("storyClientRequestId", "")
                );
                String title = firstNonEmpty(
                    payload.optString("storyTitle", ""),
                    metadata == null ? "" : metadata.optString("storyTitle", ""),
                    "剧情"
                );
                String error = payload.optString("error", "");
                SullyStoryCloudMonitorService.finish(
                    context,
                    jobId,
                    clientRequestId,
                    title,
                    status,
                    error
                );
                Log.d(TAG, "Routed story terminal status jobId=" + jobId + " status=" + status);
            }
            // running / malformed-but-marked story-status 也由这里消费通知，避免普通主动消息重复弹窗。
            return true;
        } catch (Exception ignored) {
            return false;
        }
    }

    static boolean isTerminal(String status) {
        return "succeeded".equals(status)
            || "failed".equals(status)
            || "cancelled".equals(status);
    }

    private static String firstNonEmpty(String... values) {
        if (values == null) return "";
        for (String value : values) {
            if (value != null && !value.trim().isEmpty()) return value.trim();
        }
        return "";
    }
}
