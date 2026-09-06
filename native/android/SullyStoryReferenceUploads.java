package __APP_ID__.plugins;

import android.util.Base64;
import java.io.IOException;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import org.json.JSONArray;
import org.json.JSONObject;

/** Runs only on the native story submission thread, never on the WebView/UI thread. */
public final class SullyStoryReferenceUploads {
    private SullyStoryReferenceUploads() { }

    public static void prepare(JSONObject handoff) throws Exception {
        JSONArray tools = handoff == null ? null : handoff.optJSONArray("tools");
        if (tools == null) return;
        JSONObject sources = handoff.optJSONObject("referenceSources");
        handoff.remove("referenceSources");
        for (int i = 0; i < tools.length(); i++) {
            JSONObject tool = tools.getJSONObject(i);
            JSONArray uploads = tool.optJSONArray("referenceUploads");
            // Never POST image bytes into the encrypted D1 story request (2 MB limit).
            tool.remove("referenceUploads");
            if (uploads == null) continue;
            JSONObject errors = tool.optJSONObject("referenceErrors");
            if (errors == null) errors = new JSONObject();
            for (int j = 0; j < uploads.length(); j++) {
                JSONObject upload = uploads.getJSONObject(j);
                String slot = upload.getString("slotId");
                try {
                    sync(tool, upload, sources);
                    errors.remove(slot);
                } catch (Exception error) {
                    // Preserve the story. Worker will fail only a picture that actually selects this slot.
                    String message = error.getMessage() == null ? error.getClass().getSimpleName() : error.getMessage();
                    errors.put(slot, message.substring(0, Math.min(300, message.length())));
                }
            }
            tool.put("referenceErrors", errors);
        }
    }

    private static HttpURLConnection open(JSONObject tool, JSONObject upload, String method) throws Exception {
        String base = tool.getString("controlBaseUrl").replaceAll("/+$", "");
        HttpURLConnection connection = (HttpURLConnection) new URL(base + "/references/" + upload.getString("slotId")).openConnection();
        connection.setRequestMethod(method);
        connection.setConnectTimeout(10000);
        connection.setReadTimeout("PUT".equals(method) ? 90000 : 30000);
        connection.setUseCaches(false);
        connection.setRequestProperty("Authorization", "Bearer " + tool.optString("token", ""));
        return connection;
    }

    private static void sync(JSONObject tool, JSONObject upload, JSONObject sources) throws Exception {
        String sha = upload.optString("sha256", "");
        HttpURLConnection head = open(tool, upload, "HEAD");
        try {
            int status = head.getResponseCode();
            if (status >= 200 && status < 300 && !sha.isEmpty() && sha.equals(head.getHeaderField("X-Reference-Sha256"))) return;
            if (status != 404 && (status < 200 || status >= 300)) throw new IOException("参考图查询失败（HTTP " + status + "）");
        } finally {
            head.disconnect();
        }
        String base64 = sources == null ? "" : sources.optString(upload.getString("slotId"), "");
        if (base64.isEmpty()) throw new IOException("本次参考图数据缺失");
        byte[] bytes = Base64.decode(base64, Base64.DEFAULT);
        HttpURLConnection put = open(tool, upload, "PUT");
        try {
            put.setDoOutput(true);
            put.setFixedLengthStreamingMode(bytes.length);
            put.setRequestProperty("Content-Type", "image/png");
            if (!sha.isEmpty()) put.setRequestProperty("X-Reference-Sha256", sha);
            try (OutputStream output = put.getOutputStream()) { output.write(bytes); }
            int status = put.getResponseCode();
            if (status < 200 || status >= 300) throw new IOException("参考图上传失败（HTTP " + status + "）");
        } finally {
            put.disconnect();
        }
    }
}
