package __APP_ID__.plugins;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.util.Log;
import androidx.core.app.NotificationCompat;
import androidx.core.app.ServiceCompat;
import androidx.core.content.ContextCompat;
import java.util.LinkedHashMap;
import java.util.Map;

public class SullyStoryKeepAliveService extends Service {
    public static final String ACTION_ACQUIRE = "SULLY_STORY_KEEPALIVE_ACQUIRE";
    public static final String ACTION_RELEASE = "SULLY_STORY_KEEPALIVE_RELEASE";
    public static final String EXTRA_LEASE_ID = "leaseId";
    public static final String EXTRA_TITLE = "title";

    private static final String TAG = "SullyStoryFgs";
    private static final String CHANNEL_ID = "sully_story_keepalive";
    private static final int NOTIFICATION_ID = 23032;

    private final LinkedHashMap<String, String> activeGenerations = new LinkedHashMap<>();
    private boolean isForeground = false;

    public static boolean acquire(android.content.Context context, String generationId, String title) {
        Intent intent = new Intent(context, SullyStoryKeepAliveService.class)
            .setAction(ACTION_ACQUIRE)
            .putExtra(EXTRA_LEASE_ID, generationId)
            .putExtra(EXTRA_TITLE, title == null ? "剧情" : title);
        try {
            ContextCompat.startForegroundService(context, intent);
            return true;
        } catch (Exception error) {
            Log.e(TAG, "Unable to start story generation foreground service", error);
            return false;
        }
    }

    public static void release(android.content.Context context, String generationId) {
        Intent intent = new Intent(context, SullyStoryKeepAliveService.class)
            .setAction(ACTION_RELEASE)
            .putExtra(EXTRA_LEASE_ID, generationId);
        try {
            context.startService(intent);
        } catch (Exception error) {
            Log.e(TAG, "Unable to release story generation foreground service", error);
        }
    }

    @Override
    public void onCreate() {
        super.onCreate();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationManager manager = getSystemService(NotificationManager.class);
            manager.createNotificationChannel(new NotificationChannel(
                CHANNEL_ID,
                "剧情后台续写",
                NotificationManager.IMPORTANCE_LOW
            ));
        }
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null) {
            stopService();
            return START_NOT_STICKY;
        }
        String action = intent.getAction();
        if (ACTION_ACQUIRE.equals(action)) {
            acquire(intent);
        } else if (ACTION_RELEASE.equals(action)) {
            release(intent);
        } else {
            stopService();
        }
        return START_NOT_STICKY;
    }

    @Override
    public void onDestroy() {
        activeGenerations.clear();
        if (isForeground) {
            stopForeground(STOP_FOREGROUND_REMOVE);
            isForeground = false;
        }
        super.onDestroy();
    }

    @Override
    public void onTimeout(int startId, int fgsType) {
        Log.e(TAG, "Foreground service timed out (type=" + fgsType + ")");
        for (String generationId : activeGenerations.keySet()) {
            SullyStoryGenerationManager.get(this).cancel(generationId);
        }
        stopService();
    }

    private void acquire(Intent intent) {
        String generationId = intent.getStringExtra(EXTRA_LEASE_ID);
        String title = intent.getStringExtra(EXTRA_TITLE);
        if (generationId == null || generationId.trim().isEmpty()) {
            stopService();
            return;
        }
        activeGenerations.put(generationId.trim(), title == null ? "剧情" : title.trim());
        updateForegroundNotification(title == null ? "剧情" : title.trim());
    }

    private void release(Intent intent) {
        String generationId = intent.getStringExtra(EXTRA_LEASE_ID);
        if (generationId != null) activeGenerations.remove(generationId.trim());
        if (activeGenerations.isEmpty()) {
            stopService();
        } else {
            String latestTitle = "剧情";
            for (Map.Entry<String, String> entry : activeGenerations.entrySet()) {
                latestTitle = entry.getValue();
            }
            updateForegroundNotification(latestTitle);
        }
    }

    private void updateForegroundNotification(String title) {
        try {
            android.app.Notification notification = buildNotification(title);
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
            isForeground = true;
        } catch (Exception error) {
            Log.e(TAG, "Failed to enter foreground", error);
            activeGenerations.clear();
            stopSelf();
        }
    }

    private void stopService() {
        if (isForeground) {
            stopForeground(STOP_FOREGROUND_REMOVE);
            isForeground = false;
        }
        stopSelf();
    }

    private android.app.Notification buildNotification(String title) {
        Intent launch = getPackageManager().getLaunchIntentForPackage(getPackageName());
        PendingIntent pending = launch == null ? null : PendingIntent.getActivity(
            this,
            NOTIFICATION_ID,
            launch,
            PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT
        );
        return new NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(getApplicationInfo().icon)
            .setContentTitle("剧情剧场")
            .setContentText("正在后台续写《" + (title == null || title.isEmpty() ? "剧情" : title) + "》")
            .setContentIntent(pending)
            .setCategory(NotificationCompat.CATEGORY_PROGRESS)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .build();
    }
}
