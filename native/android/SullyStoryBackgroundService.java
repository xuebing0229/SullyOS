package __APP_ID__.plugins;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.IBinder;
import androidx.core.app.NotificationCompat;
import java.io.BufferedReader;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.SocketTimeoutException;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.Comparator;
import java.util.Locale;
import org.json.JSONArray;
import org.json.JSONObject;

public class SullyStoryBackgroundService extends Service {
    public static final String ACTION_RUN = "SULLY_STORY_BACKGROUND_RUN";
    private static final String CHANNEL_SERVICE = "sully_story_background_service";
    private static final String CHANNEL_DONE = "sully_story_background_done";
    private static final int SERVICE_NOTIFICATION_ID = 23031;
    private static final long RETENTION_MS = 7L * 24L * 60L * 60L * 1000L;

    private HandlerThread workerThread;
    private Handler worker;
    private boolean pumping = false;

    private static File jobsDir(Context context) {
        File dir = new File(context.getFilesDir(), "story-background-jobs");
        if (!dir.exists()) dir.mkdirs();
        return dir;
    }

    private static File fileFor(Context context, String jobId) {
        return new File(jobsDir(context), jobId + ".json");
    }

    private static synchronized JSONObject readJobFile(Context context, String jobId) throws Exception {
        File file = fileFor(context, jobId);
        if (!file.exists()) return null;
        byte[] bytes;
        try (FileInputStream input = new FileInputStream(file)) {
            bytes = new byte[(int) file.length()];
            int offset = 0;
            while (offset < bytes.length) {
                int read = input.read(bytes, offset, bytes.length - offset);
                if (read < 0) break;
                offset += read;
            }
        }
        return new JSONObject(new String(bytes, StandardCharsets.UTF_8));
    }

    private static synchronized void writeJobFile(Context context, JSONObject job) throws Exception {
        String jobId = job.optString("jobId", "");
        File target = fileFor(context, jobId);
        File temp = new File(target.getParentFile(), target.getName() + ".tmp");
        byte[] bytes = job.toString().getBytes(StandardCharsets.UTF_8);
        try (FileOutputStream out = new FileOutputStream(temp, false)) {
            out.write(bytes);
            out.getFD().sync();
        }
        if (target.exists() && !target.delete()) throw new Exception("无法替换剧情后台任务文件");
        if (!temp.renameTo(target)) throw new Exception("无法保存剧情后台任务");
    }

    public static synchronized JSONObject enqueue(Context context, JSONObject spec) throws Exception {
        String jobId = spec.optString("jobId", "").trim();
        JSONObject existing = readJobFile(context, jobId);
        if (existing != null) return publicJob(existing);

        JSONObject job = new JSONObject(spec.toString());
        long now = System.currentTimeMillis();
        job.put("status", "queued");
        job.put("createdAt", now);
        job.put("updatedAt", now);
        job.put("attempts", new JSONArray());
        writeJobFile(context, job);
        return publicJob(job);
    }

    public static synchronized JSONObject readJob(Context context, String jobId) throws Exception {
        JSONObject job = readJobFile(context, jobId);
        return job == null ? null : publicJob(job);
    }

    public static synchronized void removeJob(Context context, String jobId) {
        File file = fileFor(context, jobId);
        if (file.exists()) file.delete();
    }

    private static JSONObject publicJob(JSONObject job) throws Exception {
        JSONObject result = new JSONObject();
        String[] keys = new String[] {
            "jobId", "ownerKey", "title", "status", "createdAt", "updatedAt",
            "startedAt", "completedAt", "statusCode", "responseJson", "partialContent",
            "error", "promptTokens", "completionTokens", "totalTokens",
            "routeIndex", "routePresetId", "routePresetName", "routeBaseUrl", "routeModel",
            "attempts"
        };
        for (String key : keys) if (job.has(key)) result.put(key, job.get(key));
        return result;
    }

    @Override
    public void onCreate() {
        super.onCreate();
        createChannels();
        startForeground(SERVICE_NOTIFICATION_ID, buildServiceNotification("剧情正在后台续写，可放心切屏"));
        workerThread = new HandlerThread("SullyStoryBackground");
        workerThread.start();
        worker = new Handler(workerThread.getLooper());
        worker.post(() -> {
            recoverInterruptedJobs();
            pump();
        });
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (worker != null) worker.post(this::pump);
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        if (worker != null) worker.removeCallbacksAndMessages(null);
        if (workerThread != null) workerThread.quitSafely();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }

    private void createChannels() {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager manager = getSystemService(NotificationManager.class);
        manager.createNotificationChannel(new NotificationChannel(
            CHANNEL_SERVICE,
            "剧情后台续写",
            NotificationManager.IMPORTANCE_LOW
        ));
        manager.createNotificationChannel(new NotificationChannel(
            CHANNEL_DONE,
            "剧情续写完成",
            NotificationManager.IMPORTANCE_DEFAULT
        ));
    }

    private NotificationCompat.Builder baseNotification(String channel) {
        Intent launch = getPackageManager().getLaunchIntentForPackage(getPackageName());
        PendingIntent pending = launch == null ? null : PendingIntent.getActivity(
            this,
            23031,
            launch,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
        NotificationCompat.Builder builder = new NotificationCompat.Builder(this, channel)
            .setSmallIcon(getApplicationInfo().icon)
            .setContentIntent(pending);
        return builder;
    }

    private android.app.Notification buildServiceNotification(String text) {
        return baseNotification(CHANNEL_SERVICE)
            .setContentTitle("剧情剧场")
            .setContentText(text)
            .setOngoing(true)
            .setSilent(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build();
    }

    private void updateServiceNotification(String title) {
        getSystemService(NotificationManager.class).notify(
            SERVICE_NOTIFICATION_ID,
            buildServiceNotification("正在后台续写《" + title + "》")
        );
    }

    private void showDoneNotification(JSONObject job, boolean ok) {
        String title = job.optString("title", "剧情");
        String content = ok ? "新一幕已经写好，回来就能看到" : "后台续写失败，回来可查看原因";
        int id = Math.abs(job.optString("jobId", "story").hashCode());
        getSystemService(NotificationManager.class).notify(
            id,
            baseNotification(CHANNEL_DONE)
                .setContentTitle("《" + title + "》" + (ok ? "续写完成" : "续写失败"))
                .setContentText(content)
                .setStyle(new NotificationCompat.BigTextStyle().bigText(content))
                .setAutoCancel(true)
                .setPriority(NotificationCompat.PRIORITY_DEFAULT)
                .build()
        );
    }

    private void recoverInterruptedJobs() {
        File[] files = jobsDir(this).listFiles((dir, name) -> name.endsWith(".json"));
        if (files == null) return;
        for (File file : files) {
            try {
                String id = file.getName().substring(0, file.getName().length() - 5);
                JSONObject job = readJobFile(this, id);
                if (job != null && "running".equals(job.optString("status"))) {
                    job.put("status", "failed");
                    job.put("error", "后台服务曾在请求进行中被系统重启；为避免重复扣费，本轮没有自动重发。");
                    job.put("completedAt", System.currentTimeMillis());
                    job.put("updatedAt", System.currentTimeMillis());
                    scrubRequest(job);
                    writeJobFile(this, job);
                    showDoneNotification(job, false);
                }
            } catch (Exception ignored) { }
        }
        cleanupOldJobs();
    }

    private synchronized void pump() {
        if (pumping) return;
        pumping = true;
        try {
            while (true) {
                JSONObject job = nextQueuedJob();
                if (job == null) break;
                processJob(job);
            }
        } finally {
            pumping = false;
            stopForeground(true);
            stopSelf();
        }
    }

    private JSONObject nextQueuedJob() {
        File[] files = jobsDir(this).listFiles((dir, name) -> name.endsWith(".json"));
        if (files == null || files.length == 0) return null;
        Arrays.sort(files, Comparator.comparingLong(File::lastModified));
        for (File file : files) {
            try {
                String id = file.getName().substring(0, file.getName().length() - 5);
                JSONObject job = readJobFile(this, id);
                if (job != null && "queued".equals(job.optString("status"))) return job;
            } catch (Exception ignored) { }
        }
        return null;
    }

    private void processJob(JSONObject job) {
        String jobId = job.optString("jobId", "");
        long startedAt = System.currentTimeMillis();
        try {
            job.put("status", "running");
            job.put("startedAt", startedAt);
            job.put("updatedAt", startedAt);
            writeJobFile(this, job);
            updateServiceNotification(job.optString("title", "剧情"));

            JSONArray routes = job.optJSONArray("routes");
            JSONObject baseBody = job.optJSONObject("baseBody");
            if (routes == null || routes.length() == 0 || baseBody == null) {
                throw new Exception("剧情后台任务缺少 API 线路或请求正文");
            }
            boolean failover = "failover".equals(job.optString("mode"));
            long timeoutMs = Math.max(30_000L, Math.min(600_000L, job.optLong("timeoutMs", 240_000L)));
            JSONArray attempts = job.optJSONArray("attempts");
            if (attempts == null) attempts = new JSONArray();

            RouteFailure lastFailure = null;
            for (int i = 0; i < routes.length(); i++) {
                JSONObject route = routes.optJSONObject(i);
                if (route == null) continue;
                long attemptStarted = System.currentTimeMillis();
                try {
                    RouteResult result = executeRoute(jobId, route, baseBody, timeoutMs);
                    JSONObject attempt = attemptRecord(route, i, true, result.statusCode, null, System.currentTimeMillis() - attemptStarted);
                    attempts.put(attempt);
                    job.put("attempts", attempts);
                    job.put("status", "succeeded");
                    job.put("statusCode", result.statusCode);
                    job.put("responseJson", result.response.toString());
                    if (result.promptTokens > 0) job.put("promptTokens", result.promptTokens);
                    if (result.completionTokens > 0) job.put("completionTokens", result.completionTokens);
                    if (result.totalTokens > 0) job.put("totalTokens", result.totalTokens);
                    putRoute(job, route, i);
                    long done = System.currentTimeMillis();
                    job.put("completedAt", done);
                    job.put("updatedAt", done);
                    scrubRequest(job);
                    writeJobFile(this, job);
                    showDoneNotification(job, true);
                    return;
                } catch (RouteFailure failure) {
                    lastFailure = failure;
                    attempts.put(attemptRecord(route, i, false, failure.statusCode, failure.getMessage(), System.currentTimeMillis() - attemptStarted));
                    job.put("attempts", attempts);
                    if (failure.partialContent != null && !failure.partialContent.isEmpty()) {
                        job.put("partialContent", failure.partialContent);
                    }
                    if (failure.committed || !failover || i >= routes.length() - 1 || isSafetyFailure(failure.getMessage())) {
                        break;
                    }
                }
            }

            String message = lastFailure == null ? "所有 API 线路均不可用" : lastFailure.getMessage();
            job.put("status", "failed");
            job.put("error", message == null ? "剧情后台续写失败" : message);
            if (lastFailure != null && lastFailure.statusCode > 0) job.put("statusCode", lastFailure.statusCode);
            long done = System.currentTimeMillis();
            job.put("completedAt", done);
            job.put("updatedAt", done);
            scrubRequest(job);
            writeJobFile(this, job);
            showDoneNotification(job, false);
        } catch (Exception error) {
            try {
                job.put("status", "failed");
                job.put("error", error.getMessage() == null ? "剧情后台续写失败" : error.getMessage());
                long done = System.currentTimeMillis();
                job.put("completedAt", done);
                job.put("updatedAt", done);
                scrubRequest(job);
                writeJobFile(this, job);
                showDoneNotification(job, false);
            } catch (Exception ignored) { }
        }
    }

    private static JSONObject attemptRecord(JSONObject route, int index, boolean ok, int status, String error, long durationMs) throws Exception {
        JSONObject attempt = new JSONObject();
        attempt.put("routeIndex", index);
        attempt.put("presetId", route.optString("presetId", ""));
        attempt.put("presetName", route.optString("presetName", "当前 API"));
        attempt.put("baseUrl", route.optString("baseUrl", ""));
        attempt.put("model", route.optString("model", ""));
        attempt.put("ok", ok);
        if (status > 0) attempt.put("status", status);
        if (error != null && !error.isEmpty()) attempt.put("error", error);
        attempt.put("durationMs", durationMs);
        return attempt;
    }

    private static void putRoute(JSONObject job, JSONObject route, int index) throws Exception {
        job.put("routeIndex", index);
        job.put("routePresetId", route.optString("presetId", ""));
        job.put("routePresetName", route.optString("presetName", "当前 API"));
        job.put("routeBaseUrl", route.optString("baseUrl", ""));
        job.put("routeModel", route.optString("model", ""));
    }

    private static boolean isSafetyFailure(String message) {
        if (message == null) return false;
        String lower = message.toLowerCase(Locale.ROOT);
        return lower.contains("safety")
            || lower.contains("moderation")
            || lower.contains("content policy")
            || lower.contains("policy violation")
            || lower.contains("敏感")
            || lower.contains("审核");
    }

    private static int readTimeoutUntil(long deadlineMs, String reason) throws SocketTimeoutException {
        long remaining = deadlineMs - System.currentTimeMillis();
        if (remaining <= 0L) throw new SocketTimeoutException(reason);
        return (int) Math.max(1L, Math.min((long) Integer.MAX_VALUE, remaining));
    }

    private static int nextReadTimeout(long hardDeadlineMs, long firstVisibleDeadlineMs, boolean committed) throws SocketTimeoutException {
        if (!committed && firstVisibleDeadlineMs > 0L) {
            return readTimeoutUntil(Math.min(hardDeadlineMs, firstVisibleDeadlineMs), "story-first-visible");
        }
        return readTimeoutUntil(hardDeadlineMs, "story-hard-timeout");
    }

    private RouteResult executeRoute(String jobId, JSONObject route, JSONObject baseBody, long timeoutMs) throws RouteFailure {
        HttpURLConnection connection = null;
        StringBuilder streamedContent = new StringBuilder();
        long attemptStartedAt = System.currentTimeMillis();
        long firstByteTimeoutMs = Math.max(0L, Math.min(300_000L, route.optLong("firstByteTimeoutMs", 0L)));
        long firstVisibleDeadlineMs = firstByteTimeoutMs > 0L ? attemptStartedAt + firstByteTimeoutMs : 0L;
        long hardDeadlineMs = attemptStartedAt + timeoutMs;
        try {
            String baseUrl = route.optString("baseUrl", "").replaceAll("/+$", "");
            if (!(baseUrl.startsWith("https://") || baseUrl.startsWith("http://"))) {
                throw new RouteFailure(0, "API 地址无效", false, "");
            }
            JSONObject body = new JSONObject(baseBody.toString());
            body.put("model", route.optString("model", body.optString("model", "")));
            if (body.has("temperature") && route.has("temperature") && !route.isNull("temperature")) {
                body.put("temperature", route.optDouble("temperature"));
            }
            boolean stream = route.optBoolean("stream", false);
            body.put("stream", stream);
            if (stream) {
                JSONObject streamOptions = body.optJSONObject("stream_options");
                if (streamOptions == null) streamOptions = new JSONObject();
                streamOptions.put("include_usage", true);
                body.put("stream_options", streamOptions);
            } else {
                body.remove("stream_options");
            }

            URL url = new URL(baseUrl + "/chat/completions");
            connection = (HttpURLConnection) url.openConnection();
            connection.setRequestMethod("POST");
            connection.setDoOutput(true);
            connection.setConnectTimeout((int) Math.min(20_000L, timeoutMs));
            // 这里不能把“首字等待”只当成 socket 静默超时：
            // SSE 可能先持续吐 reasoning / heartbeat，但用户要求的是“第一段可见正文”。
            // 因此 read timeout 每次都按绝对 deadline 的剩余时间重算，直到正文真正出现。
            connection.setReadTimeout(nextReadTimeout(hardDeadlineMs, firstVisibleDeadlineMs, false));
            connection.setRequestProperty("Content-Type", "application/json");
            connection.setRequestProperty("Accept", stream ? "text/event-stream, application/json" : "application/json, text/event-stream");
            connection.setRequestProperty("Authorization", "Bearer " + route.optString("apiKey", "sk-none"));
            byte[] requestBytes = body.toString().getBytes(StandardCharsets.UTF_8);
            try (java.io.OutputStream out = connection.getOutputStream()) {
                out.write(requestBytes);
            }

            // 写请求正文也可能花掉首字等待时间，所以真正等响应前再按剩余 deadline 校正一次。
            connection.setReadTimeout(nextReadTimeout(hardDeadlineMs, firstVisibleDeadlineMs, false));
            int status = connection.getResponseCode();
            InputStream input = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
            if (input == null) throw new RouteFailure(status, "API 返回空响应 (HTTP " + status + ")", false, "");
            String contentType = connection.getContentType();
            boolean sse = stream || (contentType != null && contentType.toLowerCase(Locale.ROOT).contains("text/event-stream"));

            String raw;
            JSONObject response;
            if (sse) {
                SseResult parsed = readSse(input, streamedContent, connection, firstVisibleDeadlineMs, hardDeadlineMs);
                raw = parsed.raw;
                if (status >= 400) {
                    throw new RouteFailure(status, errorMessage(raw, status), !streamedContent.toString().isEmpty(), streamedContent.toString());
                }
                response = parsed.response;
            } else {
                raw = readAll(input, connection, firstVisibleDeadlineMs, hardDeadlineMs);
                if (status >= 400) throw new RouteFailure(status, errorMessage(raw, status), false, "");
                try {
                    response = new JSONObject(raw);
                } catch (Exception parseError) {
                    if (raw.trim().startsWith("data:")) {
                        SseResult parsed = parseSseText(raw);
                        response = parsed.response;
                        streamedContent.append(parsed.content);
                    } else {
                        throw new RouteFailure(status, "API 返回了无效 JSON (HTTP " + status + ")", false, "");
                    }
                }
            }

            if (response == null) throw new RouteFailure(status, "API 没有返回可用结果", false, "");
            JSONObject usage = response.optJSONObject("usage");
            return new RouteResult(
                status,
                response,
                usage == null ? 0 : usage.optInt("prompt_tokens", 0),
                usage == null ? 0 : usage.optInt("completion_tokens", 0),
                usage == null ? 0 : usage.optInt("total_tokens", 0)
            );
        } catch (RouteFailure failure) {
            throw failure;
        } catch (SocketTimeoutException timeout) {
            boolean committed = streamedContent.length() > 0;
            boolean firstVisibleTimedOut = !committed && firstByteTimeoutMs > 0L
                && ("story-first-visible".equals(timeout.getMessage()) || System.currentTimeMillis() >= firstVisibleDeadlineMs - 50L);
            String message = firstVisibleTimedOut
                ? "首字等待超时（" + Math.max(1L, Math.round(firstByteTimeoutMs / 1000.0)) + " 秒），已停止当前线路"
                : "剧情后台请求超时（" + Math.max(1L, Math.round(timeoutMs / 1000.0)) + " 秒）";
            throw new RouteFailure(0, message, committed, streamedContent.toString());
        } catch (Exception error) {
            throw new RouteFailure(0, error.getMessage() == null ? "剧情后台网络请求失败" : error.getMessage(), !streamedContent.toString().isEmpty(), streamedContent.toString());
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    private static String readAll(
        InputStream input,
        HttpURLConnection connection,
        long firstBodyDeadlineMs,
        long hardDeadlineMs
    ) throws Exception {
        StringBuilder out = new StringBuilder();
        boolean gotBody = false;
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(input, StandardCharsets.UTF_8))) {
            while (true) {
                connection.setReadTimeout(nextReadTimeout(hardDeadlineMs, firstBodyDeadlineMs, gotBody));
                String line = reader.readLine();
                if (line == null) break;
                gotBody = true;
                out.append(line).append('\n');
            }
        }
        return out.toString().trim();
    }

    private static SseResult readSse(
        InputStream input,
        StringBuilder content,
        HttpURLConnection connection,
        long firstVisibleDeadlineMs,
        long hardDeadlineMs
    ) throws Exception {
        StringBuilder raw = new StringBuilder();
        JSONObject first = null;
        JSONObject usage = null;
        String model = "";
        String id = "";
        String role = "assistant";
        String finishReason = null;
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(input, StandardCharsets.UTF_8))) {
            while (true) {
                // content 一旦出现，就和前台 streamCommitMode='content' 一样正式锁定当前线路；
                // 此后只受整轮 hard timeout 约束，不会再因为首字等待去切故障转移。
                connection.setReadTimeout(nextReadTimeout(hardDeadlineMs, firstVisibleDeadlineMs, content.length() > 0));
                String line = reader.readLine();
                if (line == null) break;
                raw.append(line).append('\n');
                String trimmed = line.trim();
                if (!trimmed.startsWith("data:")) continue;
                String payload = trimmed.substring(5).trim();
                if (payload.isEmpty()) continue;
                if ("[DONE]".equals(payload)) break;
                JSONObject chunk;
                try { chunk = new JSONObject(payload); }
                catch (Exception ignored) { continue; }
                if (first == null) first = chunk;
                if (chunk.has("usage") && !chunk.isNull("usage")) usage = chunk.optJSONObject("usage");
                if (model.isEmpty()) model = chunk.optString("model", "");
                if (id.isEmpty()) id = chunk.optString("id", "");
                JSONArray choices = chunk.optJSONArray("choices");
                if (choices == null || choices.length() == 0) continue;
                JSONObject choice = choices.optJSONObject(0);
                if (choice == null) continue;
                JSONObject delta = choice.optJSONObject("delta");
                JSONObject message = choice.optJSONObject("message");
                if (delta != null) {
                    Object piece = delta.opt("content");
                    if (piece instanceof String) content.append((String) piece);
                    String r = delta.optString("role", "");
                    if (!r.isEmpty()) role = r;
                } else if (message != null) {
                    String piece = message.optString("content", "");
                    if (!piece.isEmpty()) content.append(piece);
                    String r = message.optString("role", "");
                    if (!r.isEmpty()) role = r;
                }
                if (choice.has("finish_reason") && !choice.isNull("finish_reason")) {
                    finishReason = choice.optString("finish_reason", null);
                    if (finishReason != null && !finishReason.isEmpty()) break;
                }
            }
        }
        JSONObject response = assembledResponse(id, model, role, content.toString(), finishReason, usage);
        return new SseResult(raw.toString(), response, content.toString());
    }

    private static SseResult parseSseText(String rawText) throws Exception {
        StringBuilder content = new StringBuilder();
        JSONObject usage = null;
        String model = "";
        String id = "";
        String role = "assistant";
        String finishReason = null;
        for (String line : rawText.split("\\r?\\n")) {
            String trimmed = line.trim();
            if (!trimmed.startsWith("data:")) continue;
            String payload = trimmed.substring(5).trim();
            if (payload.isEmpty() || "[DONE]".equals(payload)) continue;
            JSONObject chunk;
            try { chunk = new JSONObject(payload); } catch (Exception ignored) { continue; }
            if (chunk.has("usage") && !chunk.isNull("usage")) usage = chunk.optJSONObject("usage");
            if (model.isEmpty()) model = chunk.optString("model", "");
            if (id.isEmpty()) id = chunk.optString("id", "");
            JSONArray choices = chunk.optJSONArray("choices");
            if (choices == null || choices.length() == 0) continue;
            JSONObject choice = choices.optJSONObject(0);
            if (choice == null) continue;
            JSONObject delta = choice.optJSONObject("delta");
            JSONObject message = choice.optJSONObject("message");
            if (delta != null) {
                Object piece = delta.opt("content");
                if (piece instanceof String) content.append((String) piece);
                String r = delta.optString("role", "");
                if (!r.isEmpty()) role = r;
            } else if (message != null) {
                content.append(message.optString("content", ""));
            }
            if (choice.has("finish_reason") && !choice.isNull("finish_reason")) finishReason = choice.optString("finish_reason", null);
        }
        return new SseResult(rawText, assembledResponse(id, model, role, content.toString(), finishReason, usage), content.toString());
    }

    private static JSONObject assembledResponse(String id, String model, String role, String content, String finishReason, JSONObject usage) throws Exception {
        JSONObject message = new JSONObject().put("role", role).put("content", content);
        JSONObject choice = new JSONObject().put("index", 0).put("message", message);
        if (finishReason == null) choice.put("finish_reason", JSONObject.NULL);
        else choice.put("finish_reason", finishReason);
        JSONObject response = new JSONObject()
            .put("id", id.isEmpty() ? "native-story-background" : id)
            .put("object", "chat.completion")
            .put("model", model)
            .put("choices", new JSONArray().put(choice));
        if (usage != null) response.put("usage", usage);
        return response;
    }

    private static String errorMessage(String raw, int status) {
        try {
            JSONObject parsed = new JSONObject(raw);
            JSONObject error = parsed.optJSONObject("error");
            if (error != null) {
                String message = error.optString("message", "");
                if (!message.isEmpty()) return "API Error " + status + ": " + message;
            }
            String message = parsed.optString("message", "");
            if (!message.isEmpty()) return "API Error " + status + ": " + message;
        } catch (Exception ignored) { }
        String preview = raw == null ? "" : raw.replace('\n', ' ').trim();
        if (preview.length() > 240) preview = preview.substring(0, 240);
        return "API Error " + status + (preview.isEmpty() ? "" : ": " + preview);
    }

    private static void scrubRequest(JSONObject job) {
        job.remove("baseBody");
        JSONArray routes = job.optJSONArray("routes");
        if (routes != null) {
            for (int i = 0; i < routes.length(); i++) {
                JSONObject route = routes.optJSONObject(i);
                if (route == null) continue;
                try { route.put("apiKey", ""); } catch (Exception ignored) { }
            }
        }
    }

    private void cleanupOldJobs() {
        long cutoff = System.currentTimeMillis() - RETENTION_MS;
        File[] files = jobsDir(this).listFiles((dir, name) -> name.endsWith(".json"));
        if (files == null) return;
        for (File file : files) {
            try {
                String id = file.getName().substring(0, file.getName().length() - 5);
                JSONObject job = readJobFile(this, id);
                if (job == null) continue;
                String status = job.optString("status");
                boolean terminal = "succeeded".equals(status) || "failed".equals(status) || "cancelled".equals(status);
                if (terminal && job.optLong("updatedAt", 0L) < cutoff) file.delete();
            } catch (Exception ignored) { }
        }
    }

    private static final class RouteResult {
        final int statusCode;
        final JSONObject response;
        final int promptTokens;
        final int completionTokens;
        final int totalTokens;
        RouteResult(int statusCode, JSONObject response, int promptTokens, int completionTokens, int totalTokens) {
            this.statusCode = statusCode;
            this.response = response;
            this.promptTokens = promptTokens;
            this.completionTokens = completionTokens;
            this.totalTokens = totalTokens;
        }
    }

    private static final class SseResult {
        final String raw;
        final JSONObject response;
        final String content;
        SseResult(String raw, JSONObject response, String content) {
            this.raw = raw;
            this.response = response;
            this.content = content;
        }
    }

    private static final class RouteFailure extends Exception {
        final int statusCode;
        final boolean committed;
        final String partialContent;
        RouteFailure(int statusCode, String message, boolean committed, String partialContent) {
            super(message);
            this.statusCode = statusCode;
            this.committed = committed;
            this.partialContent = partialContent == null ? "" : partialContent;
        }
    }
}
