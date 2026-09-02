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
import android.os.PowerManager;
import androidx.core.app.NotificationCompat;
import java.io.BufferedReader;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.SocketException;
import java.net.SocketTimeoutException;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.Comparator;
import java.util.Locale;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.IOException;
import java.io.InterruptedIOException;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;
import okhttp3.Call;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;
import okhttp3.ResponseBody;
import okio.BufferedSource;

public class SullyStoryBackgroundService extends Service {
    public static final String ACTION_RUN = "SULLY_STORY_BACKGROUND_RUN";
    private static final String CHANNEL_SERVICE = "sully_story_background_service";
    private static final String CHANNEL_DONE = "sully_story_background_done";
    private static final int SERVICE_NOTIFICATION_ID = 23031;
    private static final long RETENTION_MS = 7L * 24L * 60L * 60L * 1000L;

    private HandlerThread workerThread;
    private Handler worker;
    private boolean pumping = false;
    private PowerManager.WakeLock wakeLock;

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
        try {
            PowerManager power = (PowerManager) getSystemService(Context.POWER_SERVICE);
            if (power != null) {
                wakeLock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, getPackageName() + ":story-background");
                wakeLock.setReferenceCounted(false);
                // 单轮 hard timeout 最大 10 分钟；多留一分钟给落盘与通知，避免永久持锁。
                wakeLock.acquire(11L * 60L * 1000L);
            }
        } catch (Exception ignored) { }
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

    private void releaseWakeLock() {
        try {
            if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        } catch (Exception ignored) { }
        wakeLock = null;
    }

    @Override
    public void onDestroy() {
        if (worker != null) worker.removeCallbacksAndMessages(null);
        if (workerThread != null) workerThread.quitSafely();
        releaseWakeLock();
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
            releaseWakeLock();
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
                    job.remove("partialContent");
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

    private RouteResult executeRoute(String jobId, JSONObject route, JSONObject baseBody, long timeoutMs) throws RouteFailure {
        StringBuilder streamedContent = new StringBuilder();
        long attemptStartedAt = System.currentTimeMillis();
        long firstByteTimeoutMs = Math.max(0L, Math.min(300_000L, route.optLong("firstByteTimeoutMs", 0L)));
        long firstVisibleDeadlineMs = firstByteTimeoutMs > 0L ? attemptStartedAt + firstByteTimeoutMs : 0L;

        AtomicBoolean visibleContent = new AtomicBoolean(false);
        AtomicBoolean firstVisibleTimedOut = new AtomicBoolean(false);
        AtomicBoolean idleTimedOut = new AtomicBoolean(false);
        AtomicLong lastStreamActivityAt = new AtomicLong(attemptStartedAt);

        ScheduledExecutorService firstVisibleTimer = null;
        ScheduledExecutorService idleWatchdog = null;
        Call call = null;

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

            OkHttpClient client = new OkHttpClient.Builder()
                .connectTimeout(Math.min(20_000L, timeoutMs), TimeUnit.MILLISECONDS)
                .writeTimeout(Math.min(20_000L, timeoutMs), TimeUnit.MILLISECONDS)
                .readTimeout(0L, TimeUnit.MILLISECONDS)
                // 不能把 timeoutMs 当“整轮总时长”。长篇流式只要一直在吐数据就应该继续写完，
                // 否则 240 秒一到会把正常生成硬切成半篇。
                .callTimeout(0L, TimeUnit.MILLISECONDS)
                .retryOnConnectionFailure(true)
                .build();

            Request request = new Request.Builder()
                .url(baseUrl + "/chat/completions")
                .header("Authorization", "Bearer " + route.optString("apiKey", "sk-none"))
                .header("Accept", stream ? "text/event-stream, application/json" : "application/json, text/event-stream")
                .header("Cache-Control", "no-cache")
                .header("User-Agent", "SullyOS-StoryBackground/2.1")
                .post(RequestBody.create(body.toString(), MediaType.get("application/json; charset=utf-8")))
                .build();

            call = client.newCall(request);
            final Call activeCall = call;

            if (firstByteTimeoutMs > 0L) {
                long delayMs = Math.max(1L, firstVisibleDeadlineMs - System.currentTimeMillis());
                firstVisibleTimer = Executors.newSingleThreadScheduledExecutor();
                firstVisibleTimer.schedule(() -> {
                    if (!visibleContent.get()) {
                        firstVisibleTimedOut.set(true);
                        activeCall.cancel();
                    }
                }, delayMs, TimeUnit.MILLISECONDS);
            }

            // timeoutMs 现在表示“流连续这么久完全没有活动才判死”，而不是总生成时长。
            // 只要上游还在持续吐 SSE，长篇可以超过 4 分钟继续生成到真正结束。
            idleWatchdog = Executors.newSingleThreadScheduledExecutor();
            idleWatchdog.scheduleAtFixedRate(() -> {
                if (!visibleContent.get()) return;
                long idleFor = System.currentTimeMillis() - lastStreamActivityAt.get();
                if (idleFor >= timeoutMs) {
                    idleTimedOut.set(true);
                    activeCall.cancel();
                }
            }, 5_000L, 5_000L, TimeUnit.MILLISECONDS);

            try (Response http = call.execute()) {
                int status = http.code();
                ResponseBody responseBody = http.body();
                if (responseBody == null) {
                    throw new RouteFailure(status, "API 返回空响应 (HTTP " + status + ")", false, "");
                }

                String contentType = http.header("Content-Type", "");
                boolean sse = status < 400 && (stream || contentType.toLowerCase(Locale.ROOT).contains("text/event-stream"));
                String raw;
                JSONObject response;

                if (sse) {
                    SseResult parsed = readSse(
                        responseBody.source(),
                        streamedContent,
                        visibleContent,
                        lastStreamActivityAt,
                        jobId
                    );
                    raw = parsed.raw;
                    response = parsed.response;
                } else {
                    raw = responseBody.string();
                    if (status >= 400) {
                        throw new RouteFailure(status, errorMessage(raw, status), false, "");
                    }
                    try {
                        response = new JSONObject(raw);
                    } catch (Exception parseError) {
                        if (raw.trim().startsWith("data:")) {
                            SseResult parsed = parseSseText(raw);
                            response = parsed.response;
                            streamedContent.append(parsed.content);
                            if (!parsed.content.isEmpty()) visibleContent.set(true);
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
            }
        } catch (RouteFailure failure) {
            throw failure;
        } catch (IOException networkError) {
            boolean committed = streamedContent.length() > 0;
            String rawMessage = networkError.getMessage() == null ? "" : networkError.getMessage();

            if (!committed && firstVisibleTimedOut.get()) {
                throw new RouteFailure(
                    0,
                    "首字等待超时（" + Math.max(1L, Math.round(firstByteTimeoutMs / 1000.0)) + " 秒），已停止当前线路",
                    false,
                    ""
                );
            }

            if (committed && idleTimedOut.get()) {
                throw new RouteFailure(
                    0,
                    "剧情后台流连续 " + Math.max(1L, Math.round(timeoutMs / 1000.0)) + " 秒没有任何新数据，已判定连接失活",
                    true,
                    streamedContent.toString()
                );
            }

            String message = committed
                ? "剧情后台 OkHttp 流式连接在正文生成中被上游或网络中断"
                : "剧情后台 OkHttp 连接在首字前失败";
            if (!rawMessage.isEmpty()) message += "（" + rawMessage + "）";
            throw new RouteFailure(0, message, committed, streamedContent.toString());
        } catch (Exception error) {
            throw new RouteFailure(
                0,
                error.getMessage() == null ? "剧情后台网络请求失败" : error.getMessage(),
                streamedContent.length() > 0,
                streamedContent.toString()
            );
        } finally {
            if (firstVisibleTimer != null) firstVisibleTimer.shutdownNow();
            if (idleWatchdog != null) idleWatchdog.shutdownNow();
        }
    }

    private SseResult readSse(
        BufferedSource source,
        StringBuilder content,
        AtomicBoolean visibleContent,
        AtomicLong lastStreamActivityAt,
        String jobId
    ) throws Exception {
        StringBuilder raw = new StringBuilder();
        JSONObject usage = null;
        String model = "";
        String id = "";
        String role = "assistant";
        String finishReason = null;
        long lastPersistAt = 0L;

        while (true) {
            String line = source.readUtf8Line();
            if (line == null) break;

            long now = System.currentTimeMillis();
            lastStreamActivityAt.set(now);
            raw.append(line).append('\n');

            String trimmed = line.trim();
            if (!trimmed.startsWith("data:")) continue;
            String payload = trimmed.substring(5).trim();
            if (payload.isEmpty()) continue;
            if ("[DONE]".equals(payload)) break;

            JSONObject chunk;
            try {
                chunk = new JSONObject(payload);
            } catch (Exception ignored) {
                continue;
            }

            if (chunk.has("usage") && !chunk.isNull("usage")) usage = chunk.optJSONObject("usage");
            if (model.isEmpty()) model = chunk.optString("model", "");
            if (id.isEmpty()) id = chunk.optString("id", "");

            JSONArray choices = chunk.optJSONArray("choices");
            if (choices == null || choices.length() == 0) continue;
            JSONObject choice = choices.optJSONObject(0);
            if (choice == null) continue;

            JSONObject delta = choice.optJSONObject("delta");
            JSONObject message = choice.optJSONObject("message");
            String piece = "";
            if (delta != null) {
                Object value = delta.opt("content");
                if (value instanceof String) piece = (String) value;
                String r = delta.optString("role", "");
                if (!r.isEmpty()) role = r;
            } else if (message != null) {
                piece = message.optString("content", "");
                String r = message.optString("role", "");
                if (!r.isEmpty()) role = r;
            }

            if (!piece.isEmpty()) {
                content.append(piece);
                visibleContent.set(true);

                // 原生后台每隔约 0.8 秒把已收到正文落盘。
                // 前台还开着时可以实时读出来；切屏后 WebView 暂停也没关系，回来会追上当前进度。
                if (now - lastPersistAt >= 800L) {
                    JSONObject liveJob = readJobFile(this, jobId);
                    if (liveJob != null && "running".equals(liveJob.optString("status"))) {
                        liveJob.put("partialContent", content.toString());
                        liveJob.put("updatedAt", now);
                        writeJobFile(this, liveJob);
                    }
                    lastPersistAt = now;
                }
            }

            if (choice.has("finish_reason") && !choice.isNull("finish_reason")) {
                finishReason = choice.optString("finish_reason", null);
                if (finishReason != null && !finishReason.isEmpty()) break;
            }
        }

        // 最后一批不足 0.8 秒也补一次，避免恢复前台时少看到结尾。
        if (content.length() > 0) {
            long now = System.currentTimeMillis();
            JSONObject liveJob = readJobFile(this, jobId);
            if (liveJob != null && "running".equals(liveJob.optString("status"))) {
                liveJob.put("partialContent", content.toString());
                liveJob.put("updatedAt", now);
                writeJobFile(this, liveJob);
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
