package __APP_ID__.plugins;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;
import androidx.core.app.NotificationCompat;
import java.nio.charset.StandardCharsets;
import org.json.JSONArray;
import org.json.JSONObject;
import org.unifiedpush.android.connector.FailedReason;
import org.unifiedpush.android.connector.PushService;
import org.unifiedpush.android.connector.data.PublicKeySet;
import org.unifiedpush.android.connector.data.PushEndpoint;
import org.unifiedpush.android.connector.data.PushMessage;

public class AmsgUnifiedPushService extends PushService {
    private static final String CHANNEL_ID = "amsg2";

    @Override
    public void onNewEndpoint(PushEndpoint endpoint, String instance) {
        PublicKeySet keys = endpoint.getPubKeySet();
        if (keys == null) {
            recordError("UnifiedPush 服务没有返回 Web Push 密钥");
            return;
        }
        getSharedPreferences(AmsgUnifiedPushPlugin.PREFS, 0).edit()
            .putString("endpoint", endpoint.getUrl())
            .putString("p256dh", keys.getPubKey())
            .putString("auth", keys.getAuth())
            .remove("lastError")
            .apply();
        JSObjectCompat.emitRegistrationChanged();
    }

    @Override
    public void onMessage(PushMessage message, String instance) {
        if (!message.getDecrypted()) {
            recordError("收到了无法解密的 UnifiedPush 消息");
            return;
        }
        String payload = new String(message.getContent(), StandardCharsets.UTF_8);
        savePending(payload);
        showNotification(payload);
        JSObjectCompat.emitPush(payload);
    }

    @Override
    public void onRegistrationFailed(FailedReason reason, String instance) {
        recordError(String.valueOf(reason));
    }

    @Override
    public void onUnregistered(String instance) {
        getSharedPreferences(AmsgUnifiedPushPlugin.PREFS, 0).edit()
            .remove("endpoint").remove("p256dh").remove("auth")
            .putString("lastError", "UnifiedPush 订阅已被取消")
            .apply();
        JSObjectCompat.emitRegistrationChanged();
    }

    private void recordError(String detail) {
        getSharedPreferences(AmsgUnifiedPushPlugin.PREFS, 0).edit()
            .putString("lastError", detail == null ? "UnifiedPush 未知错误" : detail)
            .apply();
        JSObjectCompat.emitRegistrationChanged();
    }

    private void savePending(String payload) {
        SharedPreferences prefs = getSharedPreferences(AmsgUnifiedPushPlugin.PREFS, 0);
        try {
            JSONArray pending = new JSONArray(prefs.getString("pending", "[]"));
            pending.put(payload);
            while (pending.length() > 100) pending.remove(0);
            prefs.edit().putString("pending", pending.toString()).apply();
        } catch (Exception ignored) { }
    }

    private void showNotification(String raw) {
        try {
            JSONObject payload = new JSONObject(raw);
            JSONObject metadata = payload.optJSONObject("metadata");
            String title = payload.optString("contactName", metadata == null
                ? "主动消息" : metadata.optString("charName", "主动消息"));
            String body = payload.optString("message", payload.optString("body", "有一条新消息"));
            String messageId = payload.optString("messageId", String.valueOf(System.currentTimeMillis()));
            int notificationId = messageId.hashCode() & 0x7fffffff;

            createNotificationChannel();
            Intent launch = getPackageManager().getLaunchIntentForPackage(getPackageName());
            PendingIntent pending = PendingIntent.getActivity(
                this,
                notificationId,
                launch,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
            );
            NotificationCompat.Builder notification = new NotificationCompat.Builder(this, CHANNEL_ID)
                .setSmallIcon(getApplicationInfo().icon)
                .setContentTitle(title)
                .setContentText(body)
                .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
                .setAutoCancel(true)
                .setContentIntent(pending)
                .setPriority(NotificationCompat.PRIORITY_HIGH);
            getSystemService(NotificationManager.class).notify(notificationId, notification.build());
        } catch (Exception ignored) { }
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager manager = getSystemService(NotificationManager.class);
        manager.createNotificationChannel(new NotificationChannel(
            CHANNEL_ID,
            "主动消息",
            NotificationManager.IMPORTANCE_HIGH
        ));
    }

    /** 把 Capacitor 事件细节留在一处，PushService 只管接收。 */
    private static final class JSObjectCompat {
        static void emitPush(String payload) {
            com.getcapacitor.JSObject data = new com.getcapacitor.JSObject();
            data.put("payload", payload);
            AmsgUnifiedPushPlugin.emit("pushReceived", data);
        }

        static void emitRegistrationChanged() {
            AmsgUnifiedPushPlugin.emit("registrationChanged", new com.getcapacitor.JSObject());
        }
    }
}
