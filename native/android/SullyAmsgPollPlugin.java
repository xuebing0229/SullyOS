package __APP_ID__.plugins;

import android.Manifest;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import org.json.JSONArray;

@CapacitorPlugin(
    name = "SullyAmsgPoll",
    permissions = { @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS }) }
)
public class SullyAmsgPollPlugin extends Plugin {
    private static final String PREFS = "sully_amsg_poll";

    @PluginMethod
    public void start(PluginCall call) {
        if (Build.VERSION.SDK_INT >= 33 && getPermissionState("notifications") != PermissionState.GRANTED) {
            requestPermissionForAlias("notifications", call, "notificationPermissionResult");
            return;
        }
        startService(call);
    }

    @PermissionCallback
    private void notificationPermissionResult(PluginCall call) {
        if (getPermissionState("notifications") != PermissionState.GRANTED) {
            call.reject("通知权限未开启");
            return;
        }
        startService(call);
    }

    private void startService(PluginCall call) {
        String workerUrl = call.getString("workerUrl", "").trim().replaceAll("/+$", "");
        String deviceToken = call.getString("deviceToken", "").trim();
        if (!workerUrl.startsWith("https://") || !deviceToken.matches("[A-Za-z0-9_-]{32,128}")) {
            call.reject("Worker 地址或设备令牌无效");
            return;
        }
        getContext().getSharedPreferences(PREFS, 0).edit()
            .putString("workerUrl", workerUrl)
            .putString("deviceToken", deviceToken)
            .putBoolean("enabled", true)
            .apply();
        Intent intent = new Intent(getContext(), SullyAmsgPollService.class).setAction("START");
        ContextCompat.startForegroundService(getContext(), intent);
        JSObject result = new JSObject();
        result.put("running", true);
        call.resolve(result);
    }

    @PluginMethod
    public void stop(PluginCall call) {
        getContext().getSharedPreferences(PREFS, 0).edit().putBoolean("enabled", false).apply();
        getContext().stopService(new Intent(getContext(), SullyAmsgPollService.class));
        call.resolve();
    }

    @PluginMethod
    public void status(PluginCall call) {
        SharedPreferences prefs = getContext().getSharedPreferences(PREFS, 0);
        JSObject result = new JSObject();
        result.put("supported", true);
        result.put("running", prefs.getBoolean("enabled", false));
        result.put("permission", Build.VERSION.SDK_INT < 33 || getPermissionState("notifications") == PermissionState.GRANTED ? "granted" : "prompt");
        call.resolve(result);
    }

    @PluginMethod
    public void drain(PluginCall call) {
        SharedPreferences prefs = getContext().getSharedPreferences(PREFS, 0);
        String raw = prefs.getString("pending", "[]");
        prefs.edit().putString("pending", "[]").apply();
        JSObject result = new JSObject();
        try { result.put("messages", new JSArray(raw)); }
        catch (Exception ignored) { result.put("messages", new JSArray()); }
        call.resolve(result);
    }
}
