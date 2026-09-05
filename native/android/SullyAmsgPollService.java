package __APP_ID__.plugins;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.IBinder;
import androidx.core.app.NotificationCompat;
import java.io.OutputStream;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import org.json.JSONArray;
import org.json.JSONObject;

public class SullyAmsgPollService extends Service {
    private static final String PREFS = "sully_amsg_poll";
    private static final int SERVICE_ID = 22020;
    private static final long INTERVAL_MS = 45_000L;
    private HandlerThread thread;
    private Handler handler;
    private final Runnable poll = new Runnable() {
        @Override public void run() {
            try { pollOnce(); } catch (Exception ignored) { }
            if (handler != null) handler.postDelayed(this, INTERVAL_MS);
        }
    };

    @Override public void onCreate() {
        super.onCreate();
        createChannels();
        startForeground(SERVICE_ID, new NotificationCompat.Builder(this, "amsg2_service")
            .setSmallIcon(getApplicationInfo().icon)
            .setContentTitle("主动消息 2.0 运行中")
            .setContentText("正在等待角色消息")
            .setOngoing(true).setSilent(true).build());
        thread = new HandlerThread("SullyAmsgPoll");
        thread.start();
        handler = new Handler(thread.getLooper());
        handler.post(poll);
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        if (!getSharedPreferences(PREFS, 0).getBoolean("enabled", false)) {
            stopSelf();
            return START_NOT_STICKY;
        }
        return START_STICKY;
    }

    @Override public void onDestroy() {
        if (handler != null) handler.removeCallbacksAndMessages(null);
        if (thread != null) thread.quitSafely();
        super.onDestroy();
    }

    @Override public IBinder onBind(Intent intent) { return null; }

    private void createChannels() {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager manager = getSystemService(NotificationManager.class);
        manager.createNotificationChannel(new NotificationChannel("amsg2_service", "主动消息后台服务", NotificationManager.IMPORTANCE_LOW));
        manager.createNotificationChannel(new NotificationChannel("amsg2", "主动消息", NotificationManager.IMPORTANCE_HIGH));
    }

    private void pollOnce() throws Exception {
        SharedPreferences prefs = getSharedPreferences(PREFS, 0);
        String base = prefs.getString("workerUrl", "");
        String token = prefs.getString("deviceToken", "");
        if (!base.startsWith("https://") || token.length() < 32) return;
        HttpURLConnection connection = open(base + "/native-poll", token, "GET");
        if (connection.getResponseCode() != 200) { connection.disconnect(); return; }
        String text = readBody(connection);
        connection.disconnect();
        JSONArray messages = new JSONObject(text).optJSONObject("data").optJSONArray("messages");
        if (messages == null || messages.length() == 0) return;
        List<Long> ids = new ArrayList<>();
        for (int i = 0; i < messages.length(); i++) {
            JSONObject item = messages.optJSONObject(i);
            if (item == null) continue;
            long id = item.optLong("id", 0);
            String payload = item.optString("payload", "");
            if (id <= 0 || payload.isEmpty()) continue;
            savePending(payload);
            showMessage(id, payload);
            ids.add(id);
        }
        if (!ids.isEmpty()) acknowledge(base, token, ids);
    }

    private HttpURLConnection open(String url, String token, String method) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setRequestMethod(method);
        c.setConnectTimeout(12_000);
        c.setReadTimeout(15_000);
        c.setRequestProperty("X-Device-Token", token);
        c.setRequestProperty("Accept", "application/json");
        return c;
    }

    private String readBody(HttpURLConnection connection) throws Exception {
        StringBuilder result = new StringBuilder();
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(connection.getInputStream(), StandardCharsets.UTF_8))) {
            String line;
            while ((line = reader.readLine()) != null) result.append(line);
        }
        return result.toString();
    }

    private void acknowledge(String base, String token, List<Long> ids) throws Exception {
        JSONArray array = new JSONArray();
        for (Long id : ids) array.put(id);
        byte[] body = new JSONObject().put("ids", array).toString().getBytes(StandardCharsets.UTF_8);
        HttpURLConnection c = open(base + "/native-poll/ack", token, "POST");
        c.setDoOutput(true);
        c.setRequestProperty("Content-Type", "application/json");
        try (OutputStream out = c.getOutputStream()) { out.write(body); }
        c.getResponseCode();
        c.disconnect();
    }

    private void savePending(String payload) {
        SharedPreferences prefs = getSharedPreferences(PREFS, 0);
        try {
            JSONArray pending = new JSONArray(prefs.getString("pending", "[]"));
            pending.put(payload);
            while (pending.length() > 100) pending.remove(0);
            prefs.edit().putString("pending", pending.toString()).apply();
        } catch (Exception ignored) { }
    }

    private void showMessage(long id, String raw) {
        try {
            JSONObject payload = new JSONObject(raw);
            String title = payload.optString("contactName", payload.optJSONObject("metadata") != null
                ? payload.optJSONObject("metadata").optString("charName", "主动消息") : "主动消息");
            String body = payload.optString("message", payload.optString("body", "有一条新消息"));
            String messageId = payload.optString("messageId", "");
            int notificationId = messageId.isEmpty()
                ? (int) (id & 0x7fffffff)
                : (messageId.hashCode() & 0x7fffffff);
            Intent launch = getPackageManager().getLaunchIntentForPackage(getPackageName());
            PendingIntent pending = PendingIntent.getActivity(this, notificationId, launch, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
            NotificationCompat.Builder notification = new NotificationCompat.Builder(this, "amsg2")
                .setSmallIcon(getApplicationInfo().icon).setContentTitle(title).setContentText(body)
                .setStyle(new NotificationCompat.BigTextStyle().bigText(body)).setAutoCancel(true)
                .setContentIntent(pending).setPriority(NotificationCompat.PRIORITY_HIGH);
            getSystemService(NotificationManager.class).notify(notificationId, notification.build());
        } catch (Exception ignored) { }
    }
}
