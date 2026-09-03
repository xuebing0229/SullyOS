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
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.Comparator;
import java.util.Locale;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;
import okhttp3.ResponseBody;
import okhttp3.sse.EventSource;
import okhttp3.sse.EventSourceListener;
import okhttp3.sse.EventSources;
import org.json.JSONArray;
import org.json.JSONObject;


public class SullyStoryBackgroundService extends Service {
    public static final String ACTION_RUN = "SULLY_STORY_BACKGROUND_RUN";
    private static final String CHANNEL_SERVICE = "sully_story_background_service";
    private static final String CHANNEL_DONE = "sully_story_background_done";
    private static final int SERVICE_NOTIFICATION_ID = 23031;
    private static final long RETENTION_MS = 7L * 24L * 60L * 60L * 1000L;

    private static final int MAX_PARALLEL_JOBS = 3;

    private HandlerThread workerThread;
    private Handler worker;
    private boolean pumping = false;
    private final ExecutorService jobExecutor = Executors.newFixedThreadPool(MAX_PARALLEL_JOBS);
    private final AtomicInteger activeJobs = new AtomicInteger(0);
    private PowerManager.WakeLock wakeLock;
    private OkHttpClient sseClient;

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
            "openedAt", "firstEventAt", "firstVisibleAt",
            "sseEvents", "reasoningChars", "visibleChars", "streamFinishReason",
            "attempts"
        };
        for (String key : keys) if (job.has(key)) result.put(key, job.get(key));
        return result;
    }

    @Override
    public void onCreate() {
        super.onCreate();
        createChannels();
        // 成熟 Android SSE 项目的共同做法：ForegroundService 自己持有一个专用、
        // 可复用的 OkHttp SSE client。SSE framing 交给 okhttp-sse EventSource，
        // 不在业务代码里自己 readLine/拼 data: 协议。
        sseClient = new OkHttpClient.Builder()
            .connectTimeout(30L, TimeUnit.SECONDS)
            .writeTimeout(30L, TimeUnit.SECONDS)
            .readTimeout(0L, TimeUnit.MILLISECONDS)
            .callTimeout(0L, TimeUnit.MILLISECONDS)
            // completion POST 不能自动重放；断线后由上层明确判定是否可切故障转移线路。
            .retryOnConnectionFailure(false)
            .build();
        startForeground(SERVICE_NOTIFICATION_ID, buildServiceNotification("剧情正在后台续写，可放心切屏"));
        try {
            PowerManager power = (PowerManager) getSystemService(Context.POWER_SERVICE);
            if (power != null) {
                wakeLock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, getPackageName() + ":story-background");
                wakeLock.setReferenceCounted(false);
                // 单轮 hard timeout 最大 10 分钟；多留一分钟给落盘与通知，避免永久持锁。
                wakeLock.acquire(30L * 60L * 1000L);
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
        jobExecutor.shutdownNow();
        if (sseClient != null) {
            try { sseClient.dispatcher().cancelAll(); } catch (Exception ignored) { }
            try { sseClient.connectionPool().evictAll(); } catch (Exception ignored) { }
            try { sseClient.dispatcher().executorService().shutdownNow(); } catch (Exception ignored) { }
        }
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
            while (activeJobs.get() < MAX_PARALLEL_JOBS) {
                JSONObject job = claimNextQueuedJob();
                if (job == null) break;

                activeJobs.incrementAndGet();
                jobExecutor.submit(() -> {
                    try {
                        processJob(job);
                    } finally {
                        activeJobs.decrementAndGet();
                        if (worker != null) worker.post(this::pump);
                    }
                });
            }

            // 以前所有剧情共用一个 HandlerThread 串行执行：前一个请求若卡 240 秒，
            // 第二个剧情只能先排队 240 秒，再自己等 240 秒，于是页面看到 500+ 秒。
            // 现在允许独立剧情并行；只有队列和活动任务都空了才停前台服务。
            if (activeJobs.get() == 0 && !hasQueuedJob()) {
                releaseWakeLock();
                stopForeground(true);
                stopSelf();
            }
        } finally {
            pumping = false;
        }
    }

    private boolean hasQueuedJob() {
        File[] files = jobsDir(this).listFiles((dir, name) -> name.endsWith(".json"));
        if (files == null || files.length == 0) return false;
        for (File file : files) {
            try {
                String id = file.getName().substring(0, file.getName().length() - 5);
                JSONObject job = readJobFile(this, id);
                if (job != null && "queued".equals(job.optString("status"))) return true;
            } catch (Exception ignored) { }
        }
        return false;
    }

    private JSONObject claimNextQueuedJob() {
        File[] files = jobsDir(this).listFiles((dir, name) -> name.endsWith(".json"));
        if (files == null || files.length == 0) return null;
        Arrays.sort(files, Comparator.comparingLong(File::lastModified));
        for (File file : files) {
            try {
                String id = file.getName().substring(0, file.getName().length() - 5);
                JSONObject job = readJobFile(this, id);
                if (job == null || !"queued".equals(job.optString("status"))) continue;

                long now = System.currentTimeMillis();
                job.put("status", "running");
                job.put("startedAt", now);
                job.put("updatedAt", now);
                writeJobFile(this, job);
                return job;
            } catch (Exception ignored) { }
        }
        return null;
    }

    private void processJob(JSONObject job) {
        String jobId = job.optString("jobId", "");
        long startedAt = job.optLong("startedAt", System.currentTimeMillis());
        try {
            // claimNextQueuedJob 已经原子地把 queued -> running，防止并发 pump 重复领取同一任务。
            // 兼容极端恢复路径：没有 startedAt 时补一个。
            if (!job.has("startedAt")) {
                job.put("startedAt", startedAt);
                job.put("updatedAt", startedAt);
                writeJobFile(this, job);
            }
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
                    RouteResult result = executeRoute(jobId, route, baseBody, timeoutMs, failover);
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

    private RouteResult executeRoute(
        String jobId,
        JSONObject route,
        JSONObject baseBody,
        long timeoutMs,
        boolean failoverMode
    ) throws RouteFailure {
        try {
            return executeEventSourceRoute(jobId, route, baseBody, timeoutMs, failoverMode, true);
        } catch (RouteFailure failure) {
            // Pixiv-Shaft 等成熟实现采用的兼容策略：只有明确 400 且错误指向
            // stream_options/include_usage 时，才去掉统计参数重试同一条流式请求。
            // 400 发生在模型执行前，不会把普通网络断线自动重放成第二次扣费。
            String lower = String.valueOf(failure.getMessage()).toLowerCase(Locale.ROOT);
            boolean usageOptionRejected = failure.statusCode == 400
                && !failure.committed
                && (lower.contains("stream_options") || lower.contains("include_usage"));
            if (usageOptionRejected) {
                return executeEventSourceRoute(jobId, route, baseBody, timeoutMs, failoverMode, false);
            }
            throw failure;
        }
    }

    private RouteResult executeEventSourceRoute(
        String jobId,
        JSONObject route,
        JSONObject baseBody,
        long timeoutMs,
        boolean failoverMode,
        boolean includeUsage
    ) throws RouteFailure {
        if (sseClient == null) {
            throw new RouteFailure(0, "剧情后台 SSE 客户端尚未初始化", false, "");
        }

        String baseUrl = route.optString("baseUrl", "").replaceAll("/+$", "");
        if (!(baseUrl.startsWith("https://") || baseUrl.startsWith("http://"))) {
            throw new RouteFailure(0, "API 地址无效", false, "");
        }

        JSONObject body;
        try {
            body = new JSONObject(baseBody.toString());
            body.put("model", route.optString("model", body.optString("model", "")));
            if (body.has("temperature") && route.has("temperature") && !route.isNull("temperature")) {
                body.put("temperature", route.optDouble("temperature"));
            }
            body.put("stream", true);
            if (includeUsage) {
                JSONObject streamOptions = body.optJSONObject("stream_options");
                if (streamOptions == null) streamOptions = new JSONObject();
                streamOptions.put("include_usage", true);
                body.put("stream_options", streamOptions);
            } else {
                body.remove("stream_options");
            }
        } catch (Exception error) {
            throw new RouteFailure(0, "无法构造剧情后台请求：" + error.getMessage(), false, "");
        }

        Request request = new Request.Builder()
            .url(baseUrl + "/chat/completions")
            .header("Authorization", "Bearer " + route.optString("apiKey", "sk-none"))
            .header("Accept", "text/event-stream")
            .header("Cache-Control", "no-cache")
            .header("User-Agent", "SullyOS-StoryEventSource/1.0")
            .post(RequestBody.create(body.toString(), MediaType.get("application/json; charset=utf-8")))
            .build();

        final EventStreamAccumulator state = new EventStreamAccumulator(jobId);
        final CountDownLatch terminalLatch = new CountDownLatch(1);
        final AtomicBoolean settled = new AtomicBoolean(false);
        final AtomicReference<RouteResult> resultRef = new AtomicReference<>(null);
        final AtomicReference<RouteFailure> failureRef = new AtomicReference<>(null);
        final AtomicReference<EventSource> sourceRef = new AtomicReference<>(null);

        class CompletionGate {
            void success(RouteResult result, EventSource source) {
                if (!settled.compareAndSet(false, true)) return;
                resultRef.set(result);
                terminalLatch.countDown();
                try { if (source != null) source.cancel(); } catch (Exception ignored) { }
            }

            void fail(RouteFailure failure, EventSource source) {
                if (!settled.compareAndSet(false, true)) return;
                failureRef.set(failure);
                terminalLatch.countDown();
                try { if (source != null) source.cancel(); } catch (Exception ignored) { }
            }
        }
        final CompletionGate gate = new CompletionGate();

        final long firstByteTimeoutMs = Math.max(
            0L,
            Math.min(300_000L, route.optLong("firstByteTimeoutMs", 0L))
        );
        final long firstVisibleWaitMs = failoverMode
            ? (firstByteTimeoutMs > 0L ? firstByteTimeoutMs : timeoutMs)
            : 0L;

        ScheduledExecutorService firstVisibleTimer = null;
        ScheduledExecutorService idleWatchdog = null;

        EventSourceListener listener = new EventSourceListener() {
            @Override
            public void onOpen(EventSource eventSource, Response response) {
                state.onOpen(response == null ? 200 : response.code());
            }

            @Override
            public void onEvent(EventSource eventSource, String id, String type, String data) {
                if (settled.get()) return;
                try {
                    boolean terminal = state.accept(data == null ? "" : data);
                    if (terminal) {
                        state.persistDiagnostics();
                        gate.success(state.toRouteResult(), eventSource);
                    }
                } catch (Exception parseError) {
                    state.persistDiagnostics();
                    gate.fail(
                        new RouteFailure(
                            state.statusCode,
                            "剧情后台 SSE 数据解析失败：" + (
                                parseError.getMessage() == null ? parseError.getClass().getSimpleName() : parseError.getMessage()
                            ),
                            state.hasVisible(),
                            state.partialContent()
                        ),
                        eventSource
                    );
                }
            }

            @Override
            public void onClosed(EventSource eventSource) {
                if (settled.get()) return;
                try {
                    state.persistDiagnostics();
                    if (state.hasTerminalMarker()) {
                        gate.success(state.toRouteResult(), eventSource);
                    } else {
                        gate.fail(
                            new RouteFailure(
                                state.statusCode,
                                state.hasVisible()
                                    ? "剧情后台 SSE 在模型完成标记前关闭"
                                    : "剧情后台 SSE 在首个可见正文前关闭",
                                state.hasVisible(),
                                state.partialContent()
                            ),
                            eventSource
                        );
                    }
                } catch (Exception error) {
                    gate.fail(
                        new RouteFailure(
                            state.statusCode,
                            error.getMessage() == null ? "剧情后台 SSE 收尾失败" : error.getMessage(),
                            state.hasVisible(),
                            state.partialContent()
                        ),
                        eventSource
                    );
                }
            }

            @Override
            public void onFailure(EventSource eventSource, Throwable error, Response response) {
                if (settled.get()) return;
                int status = response == null ? state.statusCode : response.code();
                String message = "";
                if (response != null && status >= 400) {
                    message = readEventSourceError(response, status);
                }
                if (message.isEmpty() && error != null && error.getMessage() != null) {
                    message = error.getMessage();
                }
                if (message.isEmpty()) message = "SSE connection failed";
                state.persistDiagnostics();
                gate.fail(
                    new RouteFailure(
                        status,
                        state.hasVisible()
                            ? "剧情后台 SSE 在正文生成中断开（" + message + "）"
                            : "剧情后台 SSE 在首个可见正文前失败（" + message + "）",
                        state.hasVisible(),
                        state.partialContent()
                    ),
                    eventSource
                );
            }
        };

        EventSource source = EventSources.createFactory(sseClient).newEventSource(request, listener);
        sourceRef.set(source);

        if (firstVisibleWaitMs > 0L) {
            firstVisibleTimer = Executors.newSingleThreadScheduledExecutor();
            firstVisibleTimer.schedule(() -> {
                if (settled.get() || state.hasVisible()) return;
                gate.fail(
                    new RouteFailure(
                        0,
                        "首字等待超时（" + Math.max(1L, Math.round(firstVisibleWaitMs / 1000.0))
                            + " 秒），已停止当前线路",
                        false,
                        ""
                    ),
                    sourceRef.get()
                );
            }, firstVisibleWaitMs, TimeUnit.MILLISECONDS);
        }

        // timeoutMs 只作为“已经开始出正文后的连续静默”阈值，不是整轮总时长。
        idleWatchdog = Executors.newSingleThreadScheduledExecutor();
        idleWatchdog.scheduleAtFixedRate(() -> {
            if (settled.get() || !state.hasVisible()) return;
            long idleFor = System.currentTimeMillis() - state.lastActivityAt.get();
            if (idleFor < timeoutMs) return;
            gate.fail(
                new RouteFailure(
                    0,
                    "剧情后台 SSE 连续 " + Math.max(1L, Math.round(timeoutMs / 1000.0))
                        + " 秒没有任何新事件，已判定连接失活",
                    true,
                    state.partialContent()
                ),
                sourceRef.get()
            );
        }, 5_000L, 5_000L, TimeUnit.MILLISECONDS);

        try {
            terminalLatch.await();
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            gate.fail(
                new RouteFailure(0, "剧情后台任务被系统中断", state.hasVisible(), state.partialContent()),
                sourceRef.get()
            );
        } finally {
            if (firstVisibleTimer != null) firstVisibleTimer.shutdownNow();
            if (idleWatchdog != null) idleWatchdog.shutdownNow();
        }

        RouteResult result = resultRef.get();
        if (result != null) return result;
        RouteFailure failure = failureRef.get();
        if (failure != null) throw failure;
        throw new RouteFailure(0, "剧情后台 SSE 未返回终态", state.hasVisible(), state.partialContent());
    }

    private static String readEventSourceError(Response response, int status) {
        String raw = "";
        try {
            ResponseBody body = response.body();
            if (body != null) raw = body.string();
        } catch (Exception ignored) { }
        return errorMessage(raw, status);
    }

    private final class EventStreamAccumulator {
        final String jobId;
        final StringBuilder content = new StringBuilder();
        final StringBuilder reasoning = new StringBuilder();
        final AtomicLong lastActivityAt = new AtomicLong(System.currentTimeMillis());

        JSONObject usage = null;
        String model = "";
        String id = "";
        String role = "assistant";
        String finishReason = null;
        int statusCode = 200;
        int sseEvents = 0;
        int reasoningChars = 0;
        long lastPersistAt = 0L;
        boolean visible = false;
        boolean meaningfulActivity = false;
        boolean terminalMarker = false;

        EventStreamAccumulator(String jobId) {
            this.jobId = jobId;
        }

        synchronized void onOpen(int status) {
            statusCode = status;
            long now = System.currentTimeMillis();
            lastActivityAt.set(now);
            try {
                JSONObject liveJob = readJobFile(SullyStoryBackgroundService.this, jobId);
                if (liveJob != null && "running".equals(liveJob.optString("status"))) {
                    if (!liveJob.has("openedAt")) liveJob.put("openedAt", now);
                    liveJob.put("updatedAt", now);
                    writeJobFile(SullyStoryBackgroundService.this, liveJob);
                }
            } catch (Exception ignored) { }
        }

        synchronized boolean accept(String data) throws Exception {
            long now = System.currentTimeMillis();
            lastActivityAt.set(now);
            if (data == null) return false;
            String payload = data.trim();
            if (payload.isEmpty()) return false;
            sseEvents++;
            markFirstEvent(now);

            if ("[DONE]".equals(payload)) {
                terminalMarker = true;
                if (finishReason == null || finishReason.isEmpty()) finishReason = "stop";
                return true;
            }

            JSONObject chunk;
            try {
                chunk = new JSONObject(payload);
            } catch (Exception ignored) {
                // EventSource 已经负责 SSE framing；非 JSON 的业务事件只忽略，不把整条连接判死。
                return false;
            }

            if (chunk.has("usage") && !chunk.isNull("usage")) {
                usage = chunk.optJSONObject("usage");
            }
            if (chunk.has("usageMetadata") && !chunk.isNull("usageMetadata")) {
                usage = geminiUsageToOpenAi(chunk.optJSONObject("usageMetadata"));
            }
            if (model.isEmpty()) model = chunk.optString("model", chunk.optString("modelVersion", ""));
            if (id.isEmpty()) id = chunk.optString("id", chunk.optString("responseId", ""));

            JSONArray choices = chunk.optJSONArray("choices");
            if (
                choices != null
                && choices.length() == 0
                && chunk.has("usage")
                && !chunk.isNull("usage")
                && meaningfulActivity
            ) {
                terminalMarker = true;
                if (finishReason == null || finishReason.isEmpty()) finishReason = "stop";
                return true;
            }

            if (choices == null || choices.length() == 0) {
                JSONArray candidates = chunk.optJSONArray("candidates");
                JSONObject candidate = candidates == null || candidates.length() == 0
                    ? null
                    : candidates.optJSONObject(0);
                if (candidate == null) return false;

                JSONObject candidateContent = candidate.optJSONObject("content");
                JSONArray parts = candidateContent == null ? null : candidateContent.optJSONArray("parts");
                if (parts != null) {
                    for (int i = 0; i < parts.length(); i++) {
                        JSONObject part = parts.optJSONObject(i);
                        if (part == null) continue;
                        String text = part.optString("text", "");
                        if (text.isEmpty()) continue;
                        if (part.optBoolean("thought", false)) appendReasoning(text);
                        else appendVisible(text, now);
                    }
                }
                if (candidateContent != null) {
                    String r = candidateContent.optString("role", "");
                    if (!r.isEmpty()) role = "model".equals(r) ? "assistant" : r;
                }
                String geminiFinish = candidate.optString("finishReason", "");
                if (!geminiFinish.isEmpty()) {
                    finishReason = normalizeGeminiFinishReason(geminiFinish);
                    terminalMarker = true;
                    return true;
                }
                return false;
            }

            JSONObject choice = choices.optJSONObject(0);
            if (choice == null) return false;
            JSONObject delta = choice.optJSONObject("delta");
            JSONObject message = choice.optJSONObject("message");
            if (delta != null) {
                appendOpenAiContent(delta.opt("content"), now);
                Object rr = delta.has("reasoning_content") ? delta.opt("reasoning_content")
                    : delta.has("reasoning") ? delta.opt("reasoning")
                    : delta.opt("thinking");
                if (rr instanceof String) appendReasoning((String) rr);
                String r = delta.optString("role", "");
                if (!r.isEmpty()) role = r;
            } else if (message != null) {
                appendOpenAiContent(message.opt("content"), now);
                Object rr = message.has("reasoning_content") ? message.opt("reasoning_content")
                    : message.has("reasoning") ? message.opt("reasoning")
                    : message.opt("thinking");
                if (rr instanceof String) appendReasoning((String) rr);
                String r = message.optString("role", "");
                if (!r.isEmpty()) role = r;
            }

            if (choice.has("finish_reason") && !choice.isNull("finish_reason")) {
                String rawFinish = choice.optString("finish_reason", "");
                if (!rawFinish.isEmpty()) {
                    finishReason = rawFinish;
                    terminalMarker = true;
                    return true;
                }
            }
            return false;
        }

        private void appendOpenAiContent(Object value, long now) throws Exception {
            if (value instanceof String) {
                appendVisible((String) value, now);
                return;
            }
            if (!(value instanceof JSONArray)) return;
            JSONArray blocks = (JSONArray) value;
            for (int i = 0; i < blocks.length(); i++) {
                JSONObject block = blocks.optJSONObject(i);
                if (block == null) continue;
                String type = block.optString("type", "");
                if ("text".equals(type)) appendVisible(block.optString("text", ""), now);
                else if ("thinking".equals(type)) appendReasoning(block.optString("thinking", ""));
            }
        }

        private void appendReasoning(String piece) {
            if (piece == null || piece.isEmpty()) return;
            reasoning.append(piece);
            reasoningChars += piece.length();
            meaningfulActivity = true;
        }

        private void appendVisible(String piece, long now) throws Exception {
            if (piece == null || piece.isEmpty()) return;
            content.append(piece);
            meaningfulActivity = true;
            if (!visible) {
                visible = true;
                markFirstVisible(now);
            }
            if (now - lastPersistAt >= 800L) persistPartial(now);
        }

        private void markFirstEvent(long now) {
            try {
                JSONObject liveJob = readJobFile(SullyStoryBackgroundService.this, jobId);
                if (liveJob != null && "running".equals(liveJob.optString("status")) && !liveJob.has("firstEventAt")) {
                    liveJob.put("firstEventAt", now);
                    liveJob.put("updatedAt", now);
                    writeJobFile(SullyStoryBackgroundService.this, liveJob);
                }
            } catch (Exception ignored) { }
        }

        private void markFirstVisible(long now) {
            try {
                JSONObject liveJob = readJobFile(SullyStoryBackgroundService.this, jobId);
                if (liveJob != null && "running".equals(liveJob.optString("status")) && !liveJob.has("firstVisibleAt")) {
                    liveJob.put("firstVisibleAt", now);
                    liveJob.put("updatedAt", now);
                    writeJobFile(SullyStoryBackgroundService.this, liveJob);
                }
            } catch (Exception ignored) { }
        }

        private void persistPartial(long now) throws Exception {
            JSONObject liveJob = readJobFile(SullyStoryBackgroundService.this, jobId);
            if (liveJob != null && "running".equals(liveJob.optString("status"))) {
                liveJob.put("partialContent", content.toString());
                liveJob.put("visibleChars", content.length());
                liveJob.put("reasoningChars", reasoningChars);
                liveJob.put("sseEvents", sseEvents);
                liveJob.put("updatedAt", now);
                writeJobFile(SullyStoryBackgroundService.this, liveJob);
            }
            lastPersistAt = now;
        }

        synchronized void persistDiagnostics() {
            try {
                long now = System.currentTimeMillis();
                if (content.length() > 0) persistPartial(now);
                JSONObject liveJob = readJobFile(SullyStoryBackgroundService.this, jobId);
                if (liveJob != null && "running".equals(liveJob.optString("status"))) {
                    liveJob.put("sseEvents", sseEvents);
                    liveJob.put("reasoningChars", reasoningChars);
                    liveJob.put("visibleChars", content.length());
                    if (finishReason != null) liveJob.put("streamFinishReason", finishReason);
                    liveJob.put("updatedAt", now);
                    writeJobFile(SullyStoryBackgroundService.this, liveJob);
                }
            } catch (Exception ignored) { }
        }

        synchronized boolean hasVisible() {
            return visible;
        }

        synchronized boolean hasTerminalMarker() {
            return terminalMarker;
        }

        synchronized String partialContent() {
            return content.toString();
        }

        synchronized RouteResult toRouteResult() throws Exception {
            JSONObject response = assembledResponse(
                id,
                model,
                role,
                content.toString(),
                reasoning.toString(),
                finishReason,
                usage
            );
            return new RouteResult(
                statusCode,
                response,
                usage == null ? 0 : usage.optInt("prompt_tokens", 0),
                usage == null ? 0 : usage.optInt("completion_tokens", 0),
                usage == null ? 0 : usage.optInt("total_tokens", 0)
            );
        }
    }

    private static String normalizeGeminiFinishReason(String value) {
        String upper = value == null ? "" : value.trim().toUpperCase(Locale.ROOT);
        if ("STOP".equals(upper)) return "stop";
        if ("MAX_TOKENS".equals(upper)) return "length";
        if ("SAFETY".equals(upper)
            || "RECITATION".equals(upper)
            || "BLOCKLIST".equals(upper)
            || "PROHIBITED_CONTENT".equals(upper)
            || "SPII".equals(upper)) return "content_filter";
        return upper.isEmpty() ? null : upper.toLowerCase(Locale.ROOT);
    }

    private static JSONObject geminiUsageToOpenAi(JSONObject metadata) throws Exception {
        if (metadata == null) return null;
        JSONObject usage = new JSONObject();
        int prompt = metadata.optInt("promptTokenCount", 0);
        int completion = metadata.optInt("candidatesTokenCount", 0);
        int total = metadata.optInt("totalTokenCount", 0);
        int cached = metadata.optInt("cachedContentTokenCount", 0);
        int thoughts = metadata.optInt("thoughtsTokenCount", 0);
        if (prompt > 0) usage.put("prompt_tokens", prompt);
        if (completion > 0) usage.put("completion_tokens", completion);
        if (total > 0) usage.put("total_tokens", total);
        if (cached > 0) {
            usage.put("prompt_tokens_details", new JSONObject().put("cached_tokens", cached));
        }
        if (thoughts > 0) {
            usage.put("completion_tokens_details", new JSONObject().put("reasoning_tokens", thoughts));
        }
        usage.put("usage_metadata", metadata);
        return usage;
    }

    private static JSONObject normalizeGeminiResponse(JSONObject raw) throws Exception {
        if (raw == null || raw.has("choices")) return raw;
        JSONArray candidates = raw.optJSONArray("candidates");
        if (candidates == null || candidates.length() == 0) return raw;
        JSONObject candidate = candidates.optJSONObject(0);
        if (candidate == null) return raw;

        StringBuilder content = new StringBuilder();
        StringBuilder reasoning = new StringBuilder();
        JSONObject candidateContent = candidate.optJSONObject("content");
        JSONArray parts = candidateContent == null ? null : candidateContent.optJSONArray("parts");
        if (parts != null) {
            for (int i = 0; i < parts.length(); i++) {
                JSONObject part = parts.optJSONObject(i);
                if (part == null) continue;
                String text = part.optString("text", "");
                if (text.isEmpty()) continue;
                if (part.optBoolean("thought", false)) reasoning.append(text);
                else content.append(text);
            }
        }
        String role = candidateContent == null ? "assistant" : candidateContent.optString("role", "assistant");
        if ("model".equals(role)) role = "assistant";
        String finishReason = normalizeGeminiFinishReason(candidate.optString("finishReason", ""));

        JSONObject usage = raw.has("usageMetadata") && !raw.isNull("usageMetadata")
            ? geminiUsageToOpenAi(raw.optJSONObject("usageMetadata"))
            : null;
        return assembledResponse(
            raw.optString("responseId", "native-story-background"),
            raw.optString("modelVersion", ""),
            role,
            content.toString(),
            reasoning.toString(),
            finishReason,
            usage
        );
    }

    private static JSONObject assembledResponse(String id, String model, String role, String content, String reasoning, String finishReason, JSONObject usage) throws Exception {
        JSONObject message = new JSONObject().put("role", role).put("content", content);
        if (reasoning != null && !reasoning.isEmpty()) message.put("reasoning_content", reasoning);
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
