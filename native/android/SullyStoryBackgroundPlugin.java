package __APP_ID__.plugins;

import android.content.Context;
import android.content.Intent;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import org.json.JSONObject;

@CapacitorPlugin(name = "SullyStoryBackground")
public class SullyStoryBackgroundPlugin extends Plugin {
    @PluginMethod
    public void submit(PluginCall call) {
        JSObject spec = call.getObject("spec");
        if (spec == null) {
            call.reject("缺少剧情后台任务参数");
            return;
        }
        String jobId = spec.optString("jobId", "").trim();
        if (!jobId.matches("[A-Za-z0-9_-]{12,128}")) {
            call.reject("剧情后台任务 ID 无效");
            return;
        }
        try {
            JSONObject job = SullyStoryBackgroundService.enqueue(getContext(), spec);
            Intent intent = new Intent(getContext(), SullyStoryBackgroundService.class)
                .setAction(SullyStoryBackgroundService.ACTION_RUN);
            ContextCompat.startForegroundService(getContext(), intent);
            JSObject result = new JSObject();
            result.put("job", job);
            call.resolve(result);
        } catch (Exception error) {
            call.reject(error.getMessage() == null ? "无法启动剧情后台任务" : error.getMessage());
        }
    }

    @PluginMethod
    public void status(PluginCall call) {
        String jobId = call.getString("jobId", "").trim();
        if (!jobId.matches("[A-Za-z0-9_-]{12,128}")) {
            call.reject("剧情后台任务 ID 无效");
            return;
        }
        try {
            JSONObject job = SullyStoryBackgroundService.readJob(getContext(), jobId);
            JSObject result = new JSObject();
            result.put("job", job == null ? JSONObject.NULL : job);
            call.resolve(result);
        } catch (Exception error) {
            call.reject(error.getMessage() == null ? "读取剧情后台任务失败" : error.getMessage());
        }
    }

    @PluginMethod
    public void remove(PluginCall call) {
        String jobId = call.getString("jobId", "").trim();
        if (!jobId.matches("[A-Za-z0-9_-]{12,128}")) {
            call.reject("剧情后台任务 ID 无效");
            return;
        }
        try {
            SullyStoryBackgroundService.removeJob(getContext(), jobId);
            call.resolve();
        } catch (Exception error) {
            call.reject(error.getMessage() == null ? "清理剧情后台任务失败" : error.getMessage());
        }
    }
}
