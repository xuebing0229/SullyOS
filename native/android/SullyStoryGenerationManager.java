package __APP_ID__.plugins;

import android.content.Context;
import android.content.Intent;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.Locale;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
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

/**
 * RikkaHub-aligned generation owner.
 *
 * RikkaHub keeps generation in ChatService/AppScope and uses its ForegroundService only to keep
 * the app process foreground. SullyOS is a Capacitor app, so this application-process singleton
 * is the smallest native equivalent of ChatService: it owns the generation job and shared
 * OkHttpClient; SullyStoryKeepAliveService owns no HTTP request.
 */
public final class SullyStoryGenerationManager {
    private static volatile SullyStoryGenerationManager INSTANCE;
    private static final long RETENTION_MS = 7L * 24L * 60L * 60L * 1000L;

    private final Context context;
    private final ExecutorService generationExecutor = Executors.newCachedThreadPool();
    private final Set<String> running = ConcurrentHashMap.newKeySet();
    private final ConcurrentHashMap<String, EventSource> activeSources = new ConcurrentHashMap<>();
    private final OkHttpClient client;

    private SullyStoryGenerationManager(Context context) {
        this.context = context.getApplicationContext();
        this.client = new OkHttpClient.Builder()
            .connectTimeout(20L, TimeUnit.SECONDS)
            .readTimeout(10L, TimeUnit.MINUTES)
            .writeTimeout(120L, TimeUnit.SECONDS)
            .followSslRedirects(true)
            .followRedirects(true)
            .retryOnConnectionFailure(true)
            .addNetworkInterceptor(chain -> {
                Request request = chain.request();
                String contentType = request.header("Content-Type");
                if (contentType != null
                    && contentType.contains(";")
                    && "application/json".equalsIgnoreCase(contentType.substring(0, contentType.indexOf(';')).trim())) {
                    return chain.proceed(
                        request.newBuilder().header("Content-Type", "application/json").build()
                    );
                }
                return chain.proceed(request);
            })
            .build();
        recoverInterruptedJobs();
        cleanupOldJobs();
    }

    public static SullyStoryGenerationManager get(Context context) {
        if (INSTANCE == null) {
            synchronized (SullyStoryGenerationManager.class) {
                if (INSTANCE == null) INSTANCE = new SullyStoryGenerationManager(context);
            }
        }
        return INSTANCE;
    }

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



    public JSONObject submit(JSONObject spec) throws Exception {
        JSONObject publicJob = enqueue(context, spec);
        String jobId = spec.optString("jobId", "").trim();
        String title = spec.optString("title", "剧情");
        // 与 RikkaHub launchGenerationJob 一致：先 acquire FGS，再启动真正 generation job。
        boolean foregroundStarted = SullyStoryKeepAliveService.acquire(context, jobId, title);
        start(jobId, foregroundStarted);
        return publicJob;
    }

    public JSONObject status(String jobId) throws Exception {
        return readJob(context, jobId);
    }

    public void remove(String jobId) {
        cancel(jobId);
        removeJob(context, jobId);
    }

    public void cancel(String jobId) {
        EventSource source = activeSources.remove(jobId);
        if (source != null) {
            try { source.cancel(); } catch (Exception ignored) { }
        }
        try {
            JSONObject job = readJobFile(context, jobId);
            if (job != null && !"succeeded".equals(job.optString("status")) && !"failed".equals(job.optString("status"))) {
                job.put("status", "cancelled");
                job.put("updatedAt", System.currentTimeMillis());
                scrubRequest(job);
                writeJobFile(context, job);
            }
        } catch (Exception ignored) { }
    }

    private void start(String jobId, boolean foregroundStarted) throws Exception {
        if (!running.add(jobId)) return;
        JSONObject job = readJobFile(context, jobId);
        if (job == null) {
            running.remove(jobId);
            throw new Exception("剧情后台任务不存在");
        }
        String status = job.optString("status");
        if (!"queued".equals(status)) {
            running.remove(jobId);
            return;
        }
        long now = System.currentTimeMillis();
        job.put("status", "running");
        job.put("startedAt", now);
        job.put("updatedAt", now);
        writeJobFile(context, job);

        generationExecutor.submit(() -> {
            try {
                processJob(job);
            } finally {
                running.remove(jobId);
                activeSources.remove(jobId);
                if (foregroundStarted) releaseForeground(jobId);
            }
        });
    }

    private void releaseForeground(String generationId) {
        try {
            Intent intent = new Intent(context, SullyStoryKeepAliveService.class)
                .setAction(SullyStoryKeepAliveService.ACTION_RELEASE)
                .putExtra(SullyStoryKeepAliveService.EXTRA_LEASE_ID, generationId);
            context.startService(intent);
        } catch (Exception ignored) { }
    }

    private void recoverInterruptedJobs() {
        File[] files = jobsDir(context).listFiles((dir, name) -> name.endsWith(".json"));
        if (files == null) return;
        for (File file : files) {
            try {
                String id = file.getName().substring(0, file.getName().length() - 5);
                JSONObject job = readJobFile(context, id);
                if (job != null && "running".equals(job.optString("status"))) {
                    job.put("status", "failed");
                    job.put("error", "应用进程曾在生成中被系统终止；为避免重复扣费，本轮没有自动重发。");
                    job.put("completedAt", System.currentTimeMillis());
                    job.put("updatedAt", System.currentTimeMillis());
                    scrubRequest(job);
                    writeJobFile(context, job);
                }
            } catch (Exception ignored) { }
        }
    }

    private void processJob(JSONObject job) {
        String jobId = job.optString("jobId", "");
        long startedAt = job.optLong("startedAt", System.currentTimeMillis());
        try {
            // start() 已经把 queued -> running；没有 startedAt 时只做恢复兜底。
            if (!job.has("startedAt")) {
                job.put("startedAt", startedAt);
                job.put("updatedAt", startedAt);
                writeJobFile(context, job);
            }

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
                    writeJobFile(context, job);
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
            writeJobFile(context, job);
        } catch (Exception error) {
            try {
                job.put("status", "failed");
                job.put("error", error.getMessage() == null ? "剧情后台续写失败" : error.getMessage());
                long done = System.currentTimeMillis();
                job.put("completedAt", done);
                job.put("updatedAt", done);
                scrubRequest(job);
                writeJobFile(context, job);
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
            // SullyOS 必须兼容用户自定义 OpenAI-compatible 中转：
            // 只有明确 400 且错误指向 stream_options/include_usage 时，才去掉统计参数重试。
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
        if (client == null) {
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
            .post(RequestBody.create(body.toString(), MediaType.get("application/json")))
            .addHeader("Authorization", "Bearer " + route.optString("apiKey", "sk-none"))
            .addHeader("Content-Type", "application/json")
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

        EventSource source = EventSources.createFactory(client).newEventSource(request, listener);
        sourceRef.set(source);
        activeSources.put(jobId, source);

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
            activeSources.remove(jobId, sourceRef.get());
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
                JSONObject liveJob = readJobFile(context, jobId);
                if (liveJob != null && "running".equals(liveJob.optString("status"))) {
                    if (!liveJob.has("openedAt")) liveJob.put("openedAt", now);
                    liveJob.put("updatedAt", now);
                    writeJobFile(context, liveJob);
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
                JSONObject liveJob = readJobFile(context, jobId);
                if (liveJob != null && "running".equals(liveJob.optString("status")) && !liveJob.has("firstEventAt")) {
                    liveJob.put("firstEventAt", now);
                    liveJob.put("updatedAt", now);
                    writeJobFile(context, liveJob);
                }
            } catch (Exception ignored) { }
        }

        private void markFirstVisible(long now) {
            try {
                JSONObject liveJob = readJobFile(context, jobId);
                if (liveJob != null && "running".equals(liveJob.optString("status")) && !liveJob.has("firstVisibleAt")) {
                    liveJob.put("firstVisibleAt", now);
                    liveJob.put("updatedAt", now);
                    writeJobFile(context, liveJob);
                }
            } catch (Exception ignored) { }
        }

        private void persistPartial(long now) throws Exception {
            JSONObject liveJob = readJobFile(context, jobId);
            if (liveJob != null && "running".equals(liveJob.optString("status"))) {
                liveJob.put("partialContent", content.toString());
                liveJob.put("visibleChars", content.length());
                liveJob.put("reasoningChars", reasoningChars);
                liveJob.put("sseEvents", sseEvents);
                liveJob.put("updatedAt", now);
                writeJobFile(context, liveJob);
            }
            lastPersistAt = now;
        }

        synchronized void persistDiagnostics() {
            try {
                long now = System.currentTimeMillis();
                if (content.length() > 0) persistPartial(now);
                JSONObject liveJob = readJobFile(context, jobId);
                if (liveJob != null && "running".equals(liveJob.optString("status"))) {
                    liveJob.put("sseEvents", sseEvents);
                    liveJob.put("reasoningChars", reasoningChars);
                    liveJob.put("visibleChars", content.length());
                    if (finishReason != null) liveJob.put("streamFinishReason", finishReason);
                    liveJob.put("updatedAt", now);
                    writeJobFile(context, liveJob);
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
        File[] files = jobsDir(context).listFiles((dir, name) -> name.endsWith(".json"));
        if (files == null) return;
        for (File file : files) {
            try {
                String id = file.getName().substring(0, file.getName().length() - 5);
                JSONObject job = readJobFile(context, id);
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
