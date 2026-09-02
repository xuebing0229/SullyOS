package __APP_ID__.plugins;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import androidx.core.app.NotificationCompat;
import java.util.HashSet;
import java.util.Set;

public class SullyStoryKeepAliveService extends Service {
    public static final String ACTION_ACQUIRE = "SULLY_STORY_KEEPALIVE_ACQUIRE";
    public static final String ACTION_RELEASE = "SULLY_STORY_KEEPALIVE_RELEASE";
    public static final String EXTRA_LEASE_ID = "leaseId";
    public static final String EXTRA_TITLE = "title";

    private static final String CHANNEL_ID = "sully_story_keepalive";
    private static final int NOTIFICATION_ID = 23032;

    private final Set<String> leases = new HashSet<>();
    private PowerManager.WakeLock wakeLock;

    @Override
    public void onCreate() {
        super.onCreate();
        createChannel();
        // startForegroundService() 后必须尽快进入前台。真正的标题会在 onStartCommand 刷新。
        startForeground(NOTIFICATION_ID, buildNotification("剧情后台保活已启动"));
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null) {
            if (leases.isEmpty()) stopNow();
            return START_NOT_STICKY;
        }

        String action = intent.getAction();
        String leaseId = intent.getStringExtra(EXTRA_LEASE_ID);
        if (leaseId == null) leaseId = "";
        leaseId = leaseId.trim();

        if (ACTION_RELEASE.equals(action)) {
            if (!leaseId.isEmpty()) leases.remove(leaseId);
            if (leases.isEmpty()) {
                stopNow();
            }
            return START_NOT_STICKY;
        }

        if (ACTION_ACQUIRE.equals(action)) {
            if (!leaseId.isEmpty()) leases.add(leaseId);
            ensureWakeLock();
            String title = intent.getStringExtra(EXTRA_TITLE);
            if (title == null || title.trim().isEmpty()) title = "剧情";
            getSystemService(NotificationManager.class).notify(
                NOTIFICATION_ID,
                buildNotification("正在后台续写《" + title.trim() + "》")
            );
        }

        return START_NOT_STICKY;
    }

    private void ensureWakeLock() {
        if (wakeLock != null && wakeLock.isHeld()) return;
        try {
            PowerManager power = (PowerManager) getSystemService(Context.POWER_SERVICE);
            if (power == null) return;
            wakeLock = power.newWakeLock(
                PowerManager.PARTIAL_WAKE_LOCK,
                getPackageName() + ":story-webview-keepalive"
            );
            wakeLock.setReferenceCounted(false);
            // 防止异常路径永久持锁；正常完成会立即 release。
            wakeLock.acquire(30L * 60L * 1000L);
        } catch (Exception ignored) { }
    }

    private void releaseWakeLock() {
        try {
            if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        } catch (Exception ignored) { }
        wakeLock = null;
    }

    private void createChannel() {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager manager = getSystemService(NotificationManager.class);
        manager.createNotificationChannel(new NotificationChannel(
            CHANNEL_ID,
            "剧情后台续写",
            NotificationManager.IMPORTANCE_LOW
        ));
    }

    private NotificationCompat.Builder baseNotification() {
        Intent launch = getPackageManager().getLaunchIntentForPackage(getPackageName());
        PendingIntent pending = launch == null ? null : PendingIntent.getActivity(
            this,
            NOTIFICATION_ID,
            launch,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
        return new NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(getApplicationInfo().icon)
            .setContentIntent(pending)
            .setOngoing(true)
            .setSilent(true)
            .setPriority(NotificationCompat.PRIORITY_LOW);
    }

    private android.app.Notification buildNotification(String text) {
        return baseNotification()
            .setContentTitle("剧情剧场")
            .setContentText(text)
            .build();
    }

    private void stopNow() {
        releaseWakeLock();
        stopForeground(true);
        stopSelf();
    }

    @Override
    public void onDestroy() {
        releaseWakeLock();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
