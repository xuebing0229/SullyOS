package __APP_ID__.plugins;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.IBinder;
import androidx.core.app.NotificationCompat;
import androidx.core.app.ServiceCompat;
import androidx.core.content.ContextCompat;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import org.json.JSONObject;

/**
 * 云端 Story Jobs 的 Android 侧状态牌。
 *
 * 这条链不依赖 WebView timer，也不依赖主动消息 push subscription：只要 POST /story-jobs
 * 已经成功，原生前台服务就自己轮询同一个 job，并用同一个 notification id 从“生成中”
 * 更新到“完成/失败”。因此切屏、锁屏、WebView 冻结都不会让通知凭空消失。
 */
public class SullyStoryCloudMonitorService extends Service {
    public static final String ACTION_START = "SULLY_STORY_CLOUD_MONITOR_START";
    public static final String ACTION_FINISH = "SULLY_STORY_CLOUD_MONITOR_FINISH";
    public static final String EXTRA_JOB_ID = "jobId";
    public static final String EXTRA_TITLE = "title";
    public static final String EXTRA_WORKER_URL = "workerUrl";
    public static final String EXTRA_USER_ID = "userId";
    public static final String EXTRA_SERVER_TOKEN = "serverToken";
    public static final String EXTRA_STATUS = "status";
    public static final String EXTRA_ERROR = "error";

    private static final String CHANNEL_ID = "sully_story_cloud_status_v1";
    private static final int NOTIFICATION_ID = 23033;
    private static final long POLL_MS = 3000L;

    private HandlerThread workerThread;
    private Handler handler;
    private int generation = 0;
    private String jobId = "";
    private String title = "剧情";
    private String workerUrl = "";
    private String userId = "";
    private String serverToken = "";

    public static boolean start(
        Context context,
        String jobId,
        String title,
        String workerUrl,
        String userId,
        String serverToken
    ) {
        Intent intent = new Intent(context, SullyStoryCloudMonitorService.class)
            .setAction(ACTION_START)
            .putExtra(EXTRA_JOB_ID, jobId)
            .putExtra(EXTRA_TITLE, title)
            .putExtra(EXTRA_WORKER_URL, workerUrl)
            .putExtra(EXTRA_USER_ID, userId)
            .putExtra(EXTRA_SERVER_TOKEN, serverToken == null ? "" : serverToken);
        try {
            ContextCompat.startForegroundService(context, intent);
            return true;
        } catch (Exception ignored) {
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
        } catch (Exception ignored) { }
    }

    @Override
    public void onCreate() {
        super.onCreate();
        createChannel();
        workerThread = new HandlerThread("SullyStoryCloudMonitor");
        workerThread.start();
        handler = new Handler(workerThread.getLooper());
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null) return START_NOT_STICKY;
        String action = intent.getAction();
        if (ACTION_START.equals(action)) {
            handleStart(intent);
        } else if (ACTION_FINISH.equals(action)) {
            handleFinish(intent);
        }
        return START_NOT_STICKY;
    }

    @Override
    public void onDestroy() {
        generation += 1;
        if (handler != null) handler.removeCallbacksAndMessages(null);
        if (workerThread != null) workerThread.quitSafely();
        super.onDestroy();
    }

    private void handleStart(Intent intent) {
        String nextJobId = clean(intent.getStringExtra(EXTRA_JOB_ID));
        String nextWorkerUrl = clean(intent.getStringExtra(EXTRA_WORKER_URL)).replaceAll("/+$", "");
        String nextUserId = clean(intent.getStringExtra(EXTRA_USER_ID));
        if (!nextJobId.matches("[A-Za-z0-9_-]{12,160}") || !nextWorkerUrl.startsWith("https://") || nextUserId.isEmpty()) {
            stopSelf();
            return;
        }
        this.jobId = nextJobId;
        this.title = fallbackTitle(intent.getStringExtra(EXTRA_TITLE));
        this.workerUrl = nextWorkerUrl;
        this.userId = nextUserId;
        this.serverToken = clean(intent.getStringExtra(EXTRA_SERVER_TOKEN));
        final int token = ++generation;
        enterForeground(buildRunningNotification(this.title));
        handler.removeCallbacksAndMessages(null);
        handler.post(() -> poll(token));
    }

    private void handleFinish(Intent intent) {
        String targetJobId = clean(intent.getStringExtra(EXTRA_JOB_ID));
        if (!targetJobId.isEmpty() && !jobId.isEmpty() && !targetJobId.equals(jobId)) return;
        String nextTitle = fallbackTitle(intent.getStringExtra(EXTRA_TITLE));
        String status = clean(intent.getStringExtra(EXTRA_STATUS));
        String error = clean(intent.getStringExtra(EXTRA_ERROR));
        finishTerminal(status, nextTitle, error);
    }

    private void poll(int token) {
        if (token != generation || jobId.isEmpty()) return;
        try {
            JSONObject job = fetchJob();
            if (job != null) {
                String status = job.optString("status", "");
                if ("succeeded".equals(status) || "failed".equals(status) || "cancelled".equals(status)) {
                    finishTerminal(status, title, job.optString("error", ""));
                    return;
                }
            }
        } catch (Exception ignored) {
            // 网络暂时不可用时继续守着同一 job；绝不因为状态查询失败把正文任务判失败。
        }
        if (token == generation && handler != null) handler.postDelayed(() -> poll(token), POLL_MS);
    }

    private JSONObject fetchJob() throws Exception {
        String encoded = URLEncoder.encode(jobId, StandardCharsets.UTF_8.name());
        HttpURLConnection connection = (HttpURLConnection) new URL(workerUrl + "/story-jobs/" + encoded).openConnection();
        connection.setRequestMethod("GET");
        connection.setConnectTimeout(10000);
        connection.setReadTimeout(12000);
        connection.setRequestProperty("Accept", "application/json");
        connection.setRequestProperty("X-User-Id", userId);
        if (!serverToken.isEmpty()) connection.setRequestProperty("X-Client-Token", serverToken);
        int code = connection.getResponseCode();
        if (code != 200) {
            connection.disconnect();
            return null;
        }
        StringBuilder text = new StringBuilder();
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(connection.getInputStream(), StandardCharsets.UTF_8))) {
            String line;
            while ((line = reader.readLine()) != null) text.append(line);
        } finally {
            connection.disconnect();
        }
        JSONObject root = new JSONObject(text.toString());
        JSONObject job = root.optJSONObject("job");
        if (job != null) return job;
        JSONObject data = root.optJSONObject("data");
        return data == null ? null : data.optJSONObject("job");
    }

    private void finishTerminal(String status, String title, String error) {
        generation += 1;
        if (handler != null) handler.removeCallbacksAndMessages(null);
        if (Build.VERSION.SDK_INT >= 24) {
            stopForeground(STOP_FOREGROUND_REMOVE);
        } else {
            //noinspection deprecation
            stopForeground(true);
        }
        getSystemService(NotificationManager.class).notify(
            NOTIFICATION_ID,
            buildTerminalNotification(status, title, error).build()
        );
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

    private android.app.Notification buildRunningNotification(String title) {
        return baseBuilder()
            .setContentTitle("剧情剧场")
            .setContentText("正在后台生成《" + title + "》")
            .setStyle(new NotificationCompat.BigTextStyle().bigText("正在后台生成《" + title + "》"))
            .setCategory(NotificationCompat.CATEGORY_PROGRESS)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .build();
    }

    private NotificationCompat.Builder buildTerminalNotification(String status, String title, String error) {
        String body;
        if ("succeeded".equals(status)) {
            body = "《" + title + "》剧情已生成完成，点开即可查看";
        } else if ("cancelled".equals(status)) {
            body = "《" + title + "》后台生成已取消";
        } else {
            String detail = error == null ? "" : error.replaceAll("\\s+", " ").trim();
            if (detail.length() > 120) detail = detail.substring(0, 120);
            body = detail.isEmpty()
                ? "《" + title + "》后台生成失败，点开可重试"
                : "《" + title + "》后台生成失败：" + detail;
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
        NotificationCompat.Builder builder = new NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(__APP_ID__.R.drawable.sully_story_notification)
            .setContentIntent(pending);
        return builder;
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
