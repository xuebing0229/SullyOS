package __APP_ID__.plugins;

import android.content.Intent;
import androidx.core.content.ContextCompat;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "SullyStoryBackground")
public class SullyStoryBackgroundPlugin extends Plugin {
    @PluginMethod
    public void acquireKeepAlive(PluginCall call) {
        String leaseId = call.getString("leaseId", "").trim();
        String title = call.getString("title", "剧情");
        if (!leaseId.matches("[A-Za-z0-9:_-]{8,160}")) {
            call.reject("剧情后台保活 leaseId 无效");
            return;
        }
        try {
            Intent intent = new Intent(getContext(), SullyStoryKeepAliveService.class)
                .setAction(SullyStoryKeepAliveService.ACTION_ACQUIRE)
                .putExtra(SullyStoryKeepAliveService.EXTRA_LEASE_ID, leaseId)
                .putExtra(SullyStoryKeepAliveService.EXTRA_TITLE, title == null ? "剧情" : title);
            ContextCompat.startForegroundService(getContext(), intent);
            call.resolve();
        } catch (Exception error) {
            call.reject(error.getMessage() == null ? "无法启动剧情后台保活" : error.getMessage());
        }
    }

    @PluginMethod
    public void releaseKeepAlive(PluginCall call) {
        String leaseId = call.getString("leaseId", "").trim();
        if (!leaseId.matches("[A-Za-z0-9:_-]{8,160}")) {
            call.reject("剧情后台保活 leaseId 无效");
            return;
        }
        try {
            Intent intent = new Intent(getContext(), SullyStoryKeepAliveService.class)
                .setAction(SullyStoryKeepAliveService.ACTION_RELEASE)
                .putExtra(SullyStoryKeepAliveService.EXTRA_LEASE_ID, leaseId);
            ContextCompat.startForegroundService(getContext(), intent);
            call.resolve();
        } catch (Exception error) {
            call.reject(error.getMessage() == null ? "无法停止剧情后台保活" : error.getMessage());
        }
    }
}
