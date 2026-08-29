package __APP_ID__.plugins;

import android.Manifest;
import android.content.SharedPreferences;
import android.os.Build;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.util.List;
import kotlin.Unit;
import org.json.JSONArray;
import org.unifiedpush.android.connector.ConstantsKt;
import org.unifiedpush.android.connector.UnifiedPush;

@CapacitorPlugin(
    name = "AmsgUnifiedPush",
    permissions = { @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS }) }
)
public class AmsgUnifiedPushPlugin extends Plugin {
    static final String PREFS = "sully_amsg_unified_push";
    private static AmsgUnifiedPushPlugin current;

    @Override
    public void load() {
        current = this;
    }

    @Override
    protected void handleOnDestroy() {
        if (current == this) current = null;
        super.handleOnDestroy();
    }

    static void emit(String eventName, JSObject data) {
        AmsgUnifiedPushPlugin plugin = current;
        if (plugin == null || plugin.getActivity() == null) return;
        plugin.getActivity().runOnUiThread(() -> plugin.notifyListeners(eventName, data, true));
    }

    @PluginMethod
    public void getStatus(PluginCall call) {
        SharedPreferences prefs = getContext().getSharedPreferences(PREFS, 0);
        JSObject result = new JSObject();
        result.put("native", true);
        List<String> distributors = UnifiedPush.getDistributors(getContext());
        result.put("distributors", new JSArray(distributors));
        String distributor = UnifiedPush.getSavedDistributor(getContext());
        result.put("distributor", distributor == null ? JSObject.NULL : distributor);
        result.put("lastError", nullable(prefs.getString("lastError", null)));

        String endpoint = prefs.getString("endpoint", "");
        String p256dh = prefs.getString("p256dh", "");
        String auth = prefs.getString("auth", "");
        String vapid = prefs.getString("vapid", "");
        if (!endpoint.isEmpty() && !p256dh.isEmpty() && !auth.isEmpty()) {
            JSObject keys = new JSObject();
            keys.put("p256dh", p256dh);
            keys.put("auth", auth);
            JSObject subscription = new JSObject();
            subscription.put("endpoint", endpoint);
            subscription.put("keys", keys);
            subscription.put("distributor", distributor == null ? "" : distributor);
            subscription.put("temporary", false);
            subscription.put("vapidPublicKey", vapid);
            result.put("subscription", subscription);
        } else {
            result.put("subscription", JSObject.NULL);
        }
        call.resolve(result);
    }

    @PluginMethod
    public void register(PluginCall call) {
        if (Build.VERSION.SDK_INT >= 33 && getPermissionState("notifications") != PermissionState.GRANTED) {
            requestPermissionForAlias("notifications", call, "notificationPermissionResult");
            return;
        }
        registerWithDistributor(call);
    }

    @PermissionCallback
    private void notificationPermissionResult(PluginCall call) {
        if (getPermissionState("notifications") != PermissionState.GRANTED) {
            call.reject("通知权限未开启");
            return;
        }
        registerWithDistributor(call);
    }

    private void registerWithDistributor(PluginCall call) {
        String vapid = call.getString("vapidPublicKey", "").trim();
        if (vapid.isEmpty()) {
            call.reject("VAPID 公钥为空");
            return;
        }
        getContext().getSharedPreferences(PREFS, 0).edit()
            .putString("vapid", vapid)
            .remove("lastError")
            .apply();
        try {
            UnifiedPush.tryUseCurrentOrDefaultDistributor(getActivity(), success -> {
                if (!success) {
                    getContext().getSharedPreferences(PREFS, 0).edit()
                        .putString("lastError", "没有选中 UnifiedPush 服务")
                        .apply();
                    call.reject("没有选中 UnifiedPush 服务，请先安装并打开 ntfy");
                    return Unit.INSTANCE;
                }
                try {
                    UnifiedPush.register(
                        getContext(),
                        ConstantsKt.INSTANCE_DEFAULT,
                        "SullyOS 主动消息",
                        vapid
                    );
                    JSObject result = new JSObject();
                    result.put("pending", true);
                    call.resolve(result);
                } catch (Exception error) {
                    getContext().getSharedPreferences(PREFS, 0).edit()
                        .putString("lastError", error.getMessage())
                        .apply();
                    call.reject("UnifiedPush 注册失败", error);
                }
                return Unit.INSTANCE;
            });
        } catch (Exception error) {
            call.reject("UnifiedPush 注册失败", error);
        }
    }

    @PluginMethod
    public void unregister(PluginCall call) {
        try {
            UnifiedPush.unregister(getContext(), ConstantsKt.INSTANCE_DEFAULT);
            getContext().getSharedPreferences(PREFS, 0).edit()
                .remove("endpoint").remove("p256dh").remove("auth")
                .remove("vapid").remove("lastError").apply();
            call.resolve();
        } catch (Exception error) {
            call.reject("UnifiedPush 取消注册失败", error);
        }
    }

    @PluginMethod
    public void drainPendingPushes(PluginCall call) {
        SharedPreferences prefs = getContext().getSharedPreferences(PREFS, 0);
        String raw = prefs.getString("pending", "[]");
        prefs.edit().putString("pending", "[]").apply();
        JSObject result = new JSObject();
        try {
            JSONArray array = new JSONArray(raw);
            JSArray messages = new JSArray();
            for (int i = 0; i < array.length(); i++) {
                JSObject item = new JSObject();
                item.put("payload", array.optString(i, ""));
                item.put("receivedAt", System.currentTimeMillis());
                messages.put(item);
            }
            result.put("messages", messages);
        } catch (Exception ignored) {
            result.put("messages", new JSArray());
        }
        call.resolve(result);
    }

    private Object nullable(String value) {
        return value == null ? JSObject.NULL : value;
    }
}
