package __APP_ID__.plugins;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.IBinder;
import android.os.PowerManager;
import android.util.Log;
import androidx.core.app.NotificationCompat;
import androidx.core.app.ServiceCompat;
import androidx.core.content.ContextCompat;
import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import org.json.JSONObject;

/**
 * 云端 Story Jobs 的 Android 侧状态牌。
 *
 * 这条链必须独立于 WebView：App 一切到后台，正文/配图继续在 Worker 跑，
 * 这里仍然自己查同一个 job，并把同一条通知从“生成中”原地更新成“完成/失败”。
 */
public class SullyStoryCloudMonitorService extends Service {
    public static final String ACTION_START = "SULLY_STORY_CLOUD_MONITOR_START";
    public static final String ACTION_FINISH = "SULLY_STORY_CLOUD_MONITOR_FINISH";
    public static final String EXTRA_JOB_ID = "jobId";
    public static final String EXTRA_CLIENT_REQUEST_ID = "clientRequestId";
    public static final String EXTRA_TITLE = "title";
    public static final String EXTRA_WORKER_URL = "workerUrl";
    public static final String EXTRA_USER_ID = "userId";
    public static final String EXTRA_SERVER_TOKEN = "serverToken";
    public static final String EXTRA_STATUS = "status";
    public static final String EXTRA_ERROR = "error";

    private static final String TAG = "SullyStoryCloudMonitor";
    private static final String CHANNEL_ID = "sully_story_cloud_status_v1";
    private static final String PREFS = "sully_story_cloud_monitor_v1";
    private static final int NOTIFICATION_ID = 23033;
    private static final long POLL_MS = 3000L;
    private static final long WAKE_LOCK_TIMEOUT_MS = 2L * 60L * 60L * 1000L;
    private static final int SYNC_WARNING_AFTER_FAILURES = 5;

    private HandlerThread workerThread;
    private Handler handler;
    private PowerManager.WakeLock wakeLock;
    private int generation = 0;
    private int consecutiveLookupFailures = 0;
    private boolean showingSyncWarning = false;
    private String jobId = "";
    private String clientRequestId = "";
    private String title = "剧情";
    private String workerUrl = "";
    private String userId = "";
    private String serverToken = "";

    public static boolean start(
        Context context,
        String jobId,
        String clientRequestId,
        String title,
        String workerUrl,
        String userId,
        String serverToken
    ) {
        Intent intent = new Intent(context, SullyStoryCloudMonitorService.class)
            .setAction(ACTION_START)
            .putExtra(EXTRA_JOB_ID, jobId)
            .putExtra(EXTRA_CLIENT_REQUEST_ID, clientRequestId == null ? "" : clientRequestId)
            .putExtra(EXTRA_TITLE, title)
            .putExtra(EXTRA_WORKER_URL, workerUrl)
            .putExtra(EXTRA_USER_ID, userId)
            .putExtra(EXTRA_SERVER_TOKEN, serverToken == null ? "" : serverToken);
        try {
            ContextCompat.startForegroundService(context, intent);
            return true;
        } catch (Exception error) {
            Log.e(TAG, "Unable to start cloud story foreground service", error);
            return false;
        }
    }

    public static void finish(Context context, String jobId, String title, String status, String error) {
        Intent intent = new Intent(context, SullyStoryCloudMonitorService.class)
            .setAction(ACTION_FINISH)
            .putExtra(EXTRA_JOB_ID, jobId)
            .putExtra(EXTRA_TITLE, title)
            .putExtra(EXTRA_STATUS, status)
            .putExtra(EXTRA_ERROR, error == null ? "" : error);
        try {
            context.startService(intent);
        } catch (Exception finishError) {
            Log.w(TAG, "Unable to deliver cloud story terminal state", finishError);
        }
    }

    @Override
    public void onCreate() {
        super.onCreate();
        createChannel();
        PowerManager powerManager = (PowerManager) getSystemService(POWER_SERVICE);
        if (powerManager != null) {
            wakeLock = powerManager.newWakeLock(
                PowerManager.PARTIAL_WAKE_LOCK,
                getPackageName() + ":story-cloud-monitor"
            );
            wakeLock.setReferenceCounted(false);
        }
        workerThread = new HandlerThread("SullyStoryCloudMonitor");
        workerThread.start();
        handler = new Handler(workerThread.getLooper());
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        // START_STICKY 被系统重建时 intent 可能为 null。以前这里直接放弃，留下的只会是
        // 一条永远不更新的“正在生成”通知。现在从进程私有 prefs 恢复同一任务继续查账。
        if (intent == null) {
            if (!restorePersistedMonitor()) {
                stopSelf();
                return START_NOT_STICKY;
            }
            return START_STICKY;
        }

        String action = intent.getAction();
        if (ACTION_START.equals(action)) {
            handleStart(intent);
        } else if (ACTION_FINISH.equals(action)) {
            handleFinish(intent);
        }
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        generation += 1;
        if (handler != null) handler.removeCallbacksAndMessages(null);
        if (workerThread != null) workerThread.quitSafely();
        releaseWakeLock();
        super.onDestroy();
    }

    private void handleStart(Intent intent) {
        String nextJobId = clean(intent.getStringExtra(EXTRA_JOB_ID));
        String nextClientRequestId = clean(intent.getStringExtra(EXTRA_CLIENT_REQUEST_ID));
        String nextWorkerUrl = clean(intent.getStringExtra(EXTRA_WORKER_URL)).replaceAll("/+$", "");
        String nextUserId = clean(intent.getStringExtra(EXTRA_USER_ID));
        String nextTitle = fallbackTitle(intent.getStringExtra(EXTRA_TITLE));
        String nextServerToken = clean(intent.getStringExtra(EXTRA_SERVER_TOKEN));

        if (!applyMonitorState(
            nextJobId,
            nextClientRequestId,
            nextTitle,
            nextWorkerUrl,
            nextUserId,
            nextServerToken,
            true
        )) {
            clearPersistedMonitor();
            stopSelf();
        }
    }

    private void handleFinish(Intent intent) {
        String targetJobId = clean(intent.getStringExtra(EXTRA_JOB_ID));
        if (!targetJobId.isEmpty() && !jobId.isEmpty() && !targetJobId.equals(jobId)) return;
        String nextTitle = fallbackTitle(intent.getStringExtra(EXTRA_TITLE));
        String status = clean(intent.getStringExtra(EXTRA_STATUS));
        String error = clean(intent.getStringExtra(EXTRA_ERROR));
        finishTerminal(status, nextTitle, error);
    }

    private boolean applyMonitorState(
        String nextJobId,
        String nextClientRequestId,
        String nextTitle,
        String nextWorkerUrl,
        String nextUserId,
        String nextServerToken,
        boolean persist
    ) {
        if (!nextJobId.matches("[A-Za-z0-9_-]{12,160}")
            || !nextWorkerUrl.startsWith("https://")
            || nextUserId.isEmpty()) {
            return false;
        }

        this.jobId = nextJobId;
        this.clientRequestId = nextClientRequestId.matches("[A-Za-z0-9_-]{12,160}")
            ? nextClientRequestId
            : "";
        this.title = fallbackTitle(nextTitle);
        this.workerUrl = nextWorkerUrl.replaceAll("/+$", "");
        this.userId = nextUserId;
        this.serverToken = nextServerToken;
        this.consecutiveLookupFailures = 0;
        this.showingSyncWarning = false;

        if (persist) persistMonitor();

        final int token = ++generation;
        enterForeground(buildRunningNotification(this.title));
        acquireWakeLock();
        handler.removeCallbacksAndMessages(null);
        handler.post(() -> poll(token));
        return true;
    }

    private void persistMonitor() {
        getSharedPreferences(PREFS, MODE_PRIVATE).edit()
            .putString(EXTRA_JOB_ID, jobId)
            .putString(EXTRA_CLIENT_REQUEST_ID, clientRequestId)
            .putString(EXTRA_TITLE, title)
            .putString(EXTRA_WORKER_URL, workerUrl)
            .putString(EXTRA_USER_ID, userId)
            .putString(EXTRA_SERVER_TOKEN, serverToken)
            .apply();
    }

    private boolean restorePersistedMonitor() {
        SharedPreferences prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        String restoredJobId = clean(prefs.getString(EXTRA_JOB_ID, ""));
        if (restoredJobId.isEmpty()) return false;
        return applyMonitorState(
            restoredJobId,
            clean(prefs.getString(EXTRA_CLIENT_REQUEST_ID, "")),
            fallbackTitle(prefs.getString(EXTRA_TITLE, "剧情")),
            clean(prefs.getString(EXTRA_WORKER_URL, "")),
            clean(prefs.getString(EXTRA_USER_ID, "")),
            clean(prefs.getString(EXTRA_SERVER_TOKEN, "")),
            false
        );
    }

    private void clearPersistedMonitor() {
        getSharedPreferences(PREFS, MODE_PRIVATE).edit().clear().apply();
    }

    private void poll(int token) {
        if (token != generation || jobId.isEmpty()) return;
        try {
            JSONObject job = fetchJob();
            consecutiveLookupFailures = 0;
            if (showingSyncWarning) {
                showingSyncWarning = false;
                updateRunningNotification(buildRunningNotification(title));
            }
            String status = job.optString("status", "");
            Log.d(TAG, "Story status poll jobId=" + jobId + " status=" + status);
            if ("succeeded".equals(status) || "failed".equals(status) || "cancelled".equals(status)) {
                finishTerminal(status, title, job.optString("error", ""));
                return;
            }
        } catch (Exception error) {
            consecutiveLookupFailures += 1;
            Log.w(
                TAG,
                "Story status lookup failed #" + consecutiveLookupFailures
                    + " jobId=" + jobId
                    + (clientRequestId.isEmpty() ? "" : " clientRequestId=" + clientRequestId),
                error
            );
            if (consecutiveLookupFailures >= SYNC_WARNING_AFTER_FAILURES && !showingSyncWarning) {
                showingSyncWarning = true;
                updateRunningNotification(buildSyncWarningNotification(title));
            }
        }
        if (token == generation && handler != null) handler.postDelayed(() -> poll(token), POLL_MS);
    }

    /**
     * 先按 jobId 查；拿不到时再按 clientRequestId 查同一任务。
     * 两条都是只读 GET，不会创建第二次模型请求。
     */
    private JSONObject fetchJob() throws Exception {
        Exception jobIdFailure;
        try {
            return fetchJobAtPath("/story-jobs/" + encode(jobId));
        } catch (Exception error) {
            jobIdFailure = error;
        }

        if (!clientRequestId.isEmpty()) {
            try {
                return fetchJobAtPath("/story-jobs/by-client/" + encode(clientRequestId));
            } catch (Exception clientError) {
                clientError.addSuppressed(jobIdFailure);
                throw clientError;
            }
        }
        throw jobIdFailure;
    }

    private JSONObject fetchJobAtPath(String path) throws Exception {
        String separator = path.contains("?") ? "&" : "?";
        URL url = new URL(workerUrl + path + separator + "_sullyPoll=" + System.currentTimeMillis());
        HttpURLConnection connection = (HttpURLConnection) url.openConnection();
        try {
            connection.setRequestMethod("GET");
            connection.setConnectTimeout(10000);
            connection.setReadTimeout(12000);
            connection.setUseCaches(false);
            connection.setRequestProperty("Accept", "application/json");
            connection.setRequestProperty("Cache-Control", "no-cache, no-store, max-age=0");
            connection.setRequestProperty("Pragma", "no-cache");
            connection.setRequestProperty("Connection", "close");
            connection.setRequestProperty("X-User-Id", userId);
            if (!serverToken.isEmpty()) connection.setRequestProperty("X-Client-Token", serverToken);
            int code = connection.getResponseCode();
            if (code != 200) {
                throw new IOException("剧情状态查询 HTTP " + code + " @ " + path);
            }
            StringBuilder text = new StringBuilder();
            try (BufferedReader reader = new BufferedReader(new InputStreamReader(connection.getInputStream(), StandardCharsets.UTF_8))) {
                String line;
                while ((line = reader.readLine()) != null) text.append(line);
            }
            JSONObject root = new JSONObject(text.toString());
            JSONObject job = root.optJSONObject("job");
            if (job == null) {
                JSONObject data = root.optJSONObject("data");
                job = data == null ? null : data.optJSONObject("job");
            }
            if (job == null) {
                throw new IOException("剧情状态查询 HTTP 200 但没有 job @ " + path);
            }
            return job;
        } finally {
            connection.disconnect();
        }
    }

    private static String encode(String value) throws Exception {
        return URLEncoder.encode(value, StandardCharsets.UTF_8.name());
    }

    private void acquireWakeLock() {
        if (wakeLock == null || wakeLock.isHeld()) return;
        try {
            wakeLock.acquire(WAKE_LOCK_TIMEOUT_MS);
        } catch (Exception error) {
            Log.w(TAG, "Unable to acquire story monitor wake lock", error);
        }
    }

    private void releaseWakeLock() {
        if (wakeLock == null || !wakeLock.isHeld()) return;
        try {
            wakeLock.release();
        } catch (Exception error) {
            Log.w(TAG, "Unable to release story monitor wake lock", error);
        }
    }

    private void updateRunningNotification(android.app.Notification notification) {
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager != null) manager.notify(NOTIFICATION_ID, notification);
    }

    private void finishTerminal(String status, String terminalTitle, String error) {
        generation += 1;
        if (handler != null) handler.removeCallbacksAndMessages(null);
        releaseWakeLock();
        clearPersistedMonitor();

        String normalizedStatus = "succeeded".equals(status) || "cancelled".equals(status)
            ? status
            : "failed";
        String resolvedTitle = fallbackTitle(terminalTitle);

        // 不再先 REMOVE 再重发同一 id。先把正在生成的 foreground notification 原地改成终态，
        // 再 DETACH 服务；这样即使系统处理 stopForeground 有延迟，也不会把完成通知一起删掉。
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager != null) {
            manager.notify(
                NOTIFICATION_ID,
                buildTerminalNotification(normalizedStatus, resolvedTitle, error).build()
            );
        }
        if (Build.VERSION.SDK_INT >= 24) {
            stopForeground(STOP_FOREGROUND_DETACH);
        } else {
            //noinspection deprecation
            stopForeground(false);
        }
        stopSelf();
    }

    private void enterForeground(android.app.Notification notification) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            ServiceCompat.startForeground(
                this,
                NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
            );
        } else {
            startForeground(NOTIFICATION_ID, notification);
        }
    }

    private android.app.Notification buildRunningNotification(String notificationTitle) {
        return baseBuilder()
            .setContentTitle("剧情剧场")
            .setContentText("正在后台生成《" + notificationTitle + "》")
            .setStyle(new NotificationCompat.BigTextStyle().bigText("正在后台生成《" + notificationTitle + "》"))
            .setCategory(NotificationCompat.CATEGORY_PROGRESS)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .build();
    }

    private android.app.Notification buildSyncWarningNotification(String notificationTitle) {
        String body = "《" + notificationTitle + "》仍在后台生成 · 状态同步暂时中断，正在重试";
        return baseBuilder()
            .setContentTitle("剧情剧场")
            .setContentText(body)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
            .setCategory(NotificationCompat.CATEGORY_PROGRESS)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .build();
    }

    private NotificationCompat.Builder buildTerminalNotification(String status, String notificationTitle, String error) {
        String body;
        if ("succeeded".equals(status)) {
            body = "《" + notificationTitle + "》剧情已生成完成，点开即可查看";
        } else if ("cancelled".equals(status)) {
            body = "《" + notificationTitle + "》后台生成已取消";
        } else {
            String detail = error == null ? "" : error.replaceAll("\\s+", " ").trim();
            if (detail.length() > 120) detail = detail.substring(0, 120);
            body = detail.isEmpty()
                ? "《" + notificationTitle + "》后台生成失败，点开可重试"
                : "《" + notificationTitle + "》后台生成失败：" + detail;
        }
        return baseBuilder()
            .setContentTitle("剧情剧场")
            .setContentText(body)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
            .setCategory(NotificationCompat.CATEGORY_STATUS)
            .setOngoing(false)
            .setAutoCancel(true)
            .setOnlyAlertOnce(false)
            .setPriority(NotificationCompat.PRIORITY_HIGH);
    }

    private NotificationCompat.Builder baseBuilder() {
        Intent launch = getPackageManager().getLaunchIntentForPackage(getPackageName());
        PendingIntent pending = launch == null ? null : PendingIntent.getActivity(
            this,
            NOTIFICATION_ID,
            launch,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
        return new NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(__APP_ID__.R.drawable.sully_story_notification)
            .setContentIntent(pending);
    }

    private void createChannel() {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager manager = getSystemService(NotificationManager.class);
        NotificationChannel channel = new NotificationChannel(
            CHANNEL_ID,
            "剧情后台状态",
            NotificationManager.IMPORTANCE_DEFAULT
        );
        channel.setDescription("剧情剧场后台生成的进行中、完成与失败状态");
        manager.createNotificationChannel(channel);
    }

    private static String clean(String value) {
        return value == null ? "" : value.trim();
    }

    private static String fallbackTitle(String value) {
        String clean = clean(value);
        return clean.isEmpty() ? "剧情" : clean;
    }
}
