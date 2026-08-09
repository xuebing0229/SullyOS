package __APP_ID__.plugins;

import android.app.DownloadManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.Settings;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;

@CapacitorPlugin(name = "SullyAppUpdater")
public class SullyAppUpdaterPlugin extends Plugin {
    private long activeDownloadId = -1;
    private BroadcastReceiver downloadReceiver;
    private File activeApk;

    @PluginMethod
    public void downloadAndInstall(PluginCall call) {
        String url = call.getString("url", "");
        String requestedName = call.getString("fileName", "SullyOS-update.apk");
        if (!url.startsWith("https://") || !url.toLowerCase().contains("github")) {
            call.reject("仅允许从 SullyOS GitHub Release 下载更新");
            return;
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !getContext().getPackageManager().canRequestPackageInstalls()) {
            Intent permission = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + getContext().getPackageName()));
            permission.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(permission);
            JSObject result = new JSObject();
            result.put("status", "permission_required");
            call.resolve(result);
            return;
        }

        String fileName = requestedName.replaceAll("[^A-Za-z0-9._-]", "_");
        if (!fileName.toLowerCase().endsWith(".apk")) fileName += ".apk";
        File downloads = new File(getContext().getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS), "updates");
        if (!downloads.exists() && !downloads.mkdirs()) {
            call.reject("无法创建更新下载目录");
            return;
        }
        activeApk = new File(downloads, fileName);
        if (activeApk.exists()) activeApk.delete();

        DownloadManager.Request request = new DownloadManager.Request(Uri.parse(url));
        request.setTitle("SullyOS 更新");
        request.setDescription("正在下载 " + fileName);
        request.setMimeType("application/vnd.android.package-archive");
        request.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
        request.setDestinationUri(Uri.fromFile(activeApk));
        request.setAllowedOverMetered(true);
        request.setAllowedOverRoaming(false);

        DownloadManager manager = (DownloadManager) getContext().getSystemService(Context.DOWNLOAD_SERVICE);
        unregisterReceiver();
        downloadReceiver = new BroadcastReceiver() {
            @Override public void onReceive(Context context, Intent intent) {
                long id = intent.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1);
                if (id != activeDownloadId) return;
                try {
                    DownloadManager.Query query = new DownloadManager.Query().setFilterById(id);
                    try (Cursor cursor = manager.query(query)) {
                        if (cursor.moveToFirst() && cursor.getInt(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS)) == DownloadManager.STATUS_SUCCESSFUL) {
                            openInstaller(activeApk);
                        }
                    }
                } finally {
                    unregisterReceiver();
                }
            }
        };
        IntentFilter filter = new IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            getContext().registerReceiver(downloadReceiver, filter, Context.RECEIVER_NOT_EXPORTED);
        } else {
            getContext().registerReceiver(downloadReceiver, filter);
        }
        activeDownloadId = manager.enqueue(request);
        JSObject result = new JSObject();
        result.put("status", "downloading");
        call.resolve(result);
    }

    private void openInstaller(File apk) {
        Uri uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".sullyos.updates", apk);
        Intent install = new Intent(Intent.ACTION_VIEW);
        install.setDataAndType(uri, "application/vnd.android.package-archive");
        install.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(install);
    }

    private void unregisterReceiver() {
        if (downloadReceiver == null) return;
        try { getContext().unregisterReceiver(downloadReceiver); } catch (IllegalArgumentException ignored) { }
        downloadReceiver = null;
    }

    @Override protected void handleOnDestroy() {
        unregisterReceiver();
        super.handleOnDestroy();
    }
}
