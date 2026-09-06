package __APP_ID__.plugins;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import org.json.JSONObject;

@CapacitorPlugin(name = "SullyStoryBackground")
public class SullyStoryBackgroundPlugin extends Plugin {
    @PluginMethod
    public void acquireKeepAlive(PluginCall call) {
        String leaseId = call.getString("leaseId", "").trim();
        String title = call.getString("title", "剧情");
        if (!leaseId.matches("[A-Za-z0-9:_-]{8,160}")) {
            call.reject("剧情后台保活 leaseId 无效");
            return;
        }
        if (SullyStoryKeepAliveService.acquire(getContext(), leaseId, title)) {
            call.resolve();
        } else {
            call.reject("无法启动剧情后台保活");
        }
    }

    @PluginMethod
    public void releaseKeepAlive(PluginCall call) {
        String leaseId = call.getString("leaseId", "").trim();
        if (!leaseId.matches("[A-Za-z0-9:_-]{8,160}")) {
            call.reject("剧情后台保活 leaseId 无效");
            return;
        }
        SullyStoryKeepAliveService.release(getContext(), leaseId);
        call.resolve();
    }

    @PluginMethod
    public void startCloudMonitor(PluginCall call) {
        String jobId = call.getString("jobId", "").trim();
        String title = call.getString("title", "剧情");
        String workerUrl = call.getString("workerUrl", "").trim().replaceAll("/+$", "");
        String userId = call.getString("userId", "").trim();
        String serverToken = call.getString("serverToken", "");
        String specJson = call.getString("specJson", "");
        String clientRequestId = call.getString("clientRequestId", "").trim();
        if (clientRequestId.isEmpty() && specJson != null && !specJson.trim().isEmpty()) {
            try {
                clientRequestId = new JSONObject(specJson).optString("clientRequestId", "").trim();
            } catch (Exception ignored) { }
        }
        if (!jobId.matches("[A-Za-z0-9_-]{12,160}")) {
            call.reject("剧情云端监控 jobId 无效");
            return;
        }
        if (!workerUrl.startsWith("https://") || userId.isEmpty()) {
            call.reject("剧情云端监控 Worker 配置无效");
            return;
        }
        if (!SullyStoryCloudMonitorService.start(
            getContext(),
            jobId,
            clientRequestId,
            title,
            workerUrl,
            userId,
            serverToken
        )) {
            call.reject("无法启动剧情云端状态通知");
            return;
        }

        // 新任务可以把完整 story spec 一起交给这里。先启动 ForegroundService，再在
        // Android 原生线程里 POST /story-jobs：即使用户点完生成马上切屏，WebView 冻住了，
        // 真正的云端任务提交和后续状态轮询也已经脱离 WebView 生命周期。
        if (specJson != null && !specJson.trim().isEmpty()) {
            final String submitSpec = specJson;
            Thread submitThread = new Thread(() -> {
                try {
                    JSONObject readySpec = new JSONObject(submitSpec);
                    SullyStoryReferenceUploads.prepare(readySpec.optJSONObject("imageHandoff"));
                    int status = submitCloudStoryJob(workerUrl, userId, serverToken, readySpec.toString());
                    if (status >= 200 && status < 300) {
                        call.resolve();
                        return;
                    }
                    String message = "剧情云端任务提交失败（HTTP " + status + "）";
                    SullyStoryCloudMonitorService.finish(getContext(), jobId, title, "failed", message);
                    call.reject(message);
                } catch (Exception error) {
                    // 连接异常时无法判断 POST 是否已抵达 Worker，所以不把状态牌直接判失败。
                    // JS 恢复后会用同一个 jobId/clientRequestId 再查账；必要时同 ID 重交也是幂等的。
                    String detail = error.getMessage() == null ? error.getClass().getSimpleName() : error.getMessage();
                    call.reject("剧情云端任务提交结果不确定：" + detail);
                }
            }, "SullyStoryCloudSubmit");
            submitThread.start();
            return;
        }

        call.resolve();
    }

    private static int submitCloudStoryJob(
        String workerUrl,
        String userId,
        String serverToken,
        String specJson
    ) throws Exception {
        byte[] body = specJson.getBytes(StandardCharsets.UTF_8);
        HttpURLConnection connection = (HttpURLConnection) new URL(workerUrl + "/story-jobs").openConnection();
        try {
            connection.setRequestMethod("POST");
            connection.setConnectTimeout(10000);
            connection.setReadTimeout(20000);
            connection.setDoOutput(true);
            connection.setUseCaches(false);
            connection.setRequestProperty("Accept", "application/json");
            connection.setRequestProperty("Content-Type", "application/json");
            connection.setRequestProperty("Cache-Control", "no-cache, no-store, max-age=0");
            connection.setRequestProperty("Pragma", "no-cache");
            connection.setRequestProperty("X-User-Id", userId);
            if (serverToken != null && !serverToken.trim().isEmpty()) {
                connection.setRequestProperty("X-Client-Token", serverToken.trim());
            }
            connection.setFixedLengthStreamingMode(body.length);
            try (OutputStream output = connection.getOutputStream()) {
                output.write(body);
                output.flush();
            }
            return connection.getResponseCode();
        } finally {
            connection.disconnect();
        }
    }

    @PluginMethod
    public void finishCloudMonitor(PluginCall call) {
        String jobId = call.getString("jobId", "").trim();
        String title = call.getString("title", "剧情");
        String status = call.getString("status", "failed").trim();
        String error = call.getString("error", "");
        if (!jobId.matches("[A-Za-z0-9_-]{12,160}")) {
            call.reject("剧情云端监控 jobId 无效");
            return;
        }
        SullyStoryCloudMonitorService.finish(getContext(), jobId, title, status, error);
        call.resolve();
    }

    @PluginMethod
    public void submit(PluginCall call) {
        JSObject spec = call.getObject("spec");
        if (spec == null) {
            call.reject("缺少剧情后台任务参数");
            return;
        }
        String jobId = spec.optString("jobId", "").trim();
        if (!jobId.matches("[A-Za-z0-9_-]{12,128}")) {
            call.reject("剧情后台任务 ID 无效");
            return;
        }
        try {
            JSONObject job = SullyStoryGenerationManager.get(getContext()).submit(spec);
            JSObject result = new JSObject();
            result.put("job", job);
            call.resolve(result);
        } catch (Exception error) {
            call.reject(error.getMessage() == null ? "无法启动剧情后台任务" : error.getMessage());
        }
    }

    @PluginMethod
    public void status(PluginCall call) {
        String jobId = call.getString("jobId", "").trim();
        if (!jobId.matches("[A-Za-z0-9_-]{12,128}")) {
            call.reject("剧情后台任务 ID 无效");
            return;
        }
        try {
            JSONObject job = SullyStoryGenerationManager.get(getContext()).status(jobId);
            JSObject result = new JSObject();
            result.put("job", job == null ? JSONObject.NULL : job);
            call.resolve(result);
        } catch (Exception error) {
            call.reject(error.getMessage() == null ? "读取剧情后台任务失败" : error.getMessage());
        }
    }

    @PluginMethod
    public void remove(PluginCall call) {
        String jobId = call.getString("jobId", "").trim();
        if (!jobId.matches("[A-Za-z0-9_-]{12,128}")) {
            call.reject("剧情后台任务 ID 无效");
            return;
        }
        try {
            SullyStoryGenerationManager.get(getContext()).remove(jobId);
            call.resolve();
        } catch (Exception error) {
            call.reject(error.getMessage() == null ? "清理剧情后台任务失败" : error.getMessage());
        }
    }
}
