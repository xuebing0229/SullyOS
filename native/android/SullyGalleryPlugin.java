package __APP_ID__.plugins;

import android.Manifest;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.media.MediaScannerConnection;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Locale;

@CapacitorPlugin(
    name = "SullyGallery",
    permissions = {
        @Permission(
            alias = "legacyStorage",
            strings = { Manifest.permission.WRITE_EXTERNAL_STORAGE }
        )
    }
)
public class SullyGalleryPlugin extends Plugin {

    private static final int MAX_BYTES = 32 * 1024 * 1024;
    private static final int CONNECT_TIMEOUT_MS = 20_000;
    private static final int READ_TIMEOUT_MS = 60_000;

    private static final class LoadedImage {
        final byte[] bytes;
        final String mimeType;

        LoadedImage(byte[] bytes, String mimeType) {
            this.bytes = bytes;
            this.mimeType = mimeType;
        }
    }

    private static final class SavedImage {
        final String uri;
        final String displayName;
        final String relativePath;

        SavedImage(String uri, String displayName, String relativePath) {
            this.uri = uri;
            this.displayName = displayName;
            this.relativePath = relativePath;
        }
    }

    @PluginMethod
    public void saveImage(PluginCall call) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q
            && getPermissionState("legacyStorage") != PermissionState.GRANTED) {
            requestPermissionForAlias(
                "legacyStorage",
                call,
                "legacyStoragePermissionCallback"
            );
            return;
        }
        saveImageAsync(call);
    }

    @PermissionCallback
    private void legacyStoragePermissionCallback(PluginCall call) {
        if (getPermissionState("legacyStorage") != PermissionState.GRANTED) {
            call.reject("未授予保存图片所需的旧版存储权限");
            return;
        }
        saveImageAsync(call);
    }

    private void saveImageAsync(PluginCall call) {
        final String base64 = trimToNull(call.getString("base64"));
        final String sourceUrl = trimToNull(call.getString("sourceUrl"));
        final String requestedMime = trimToNull(call.getString("mimeType"));
        final String requestedName = trimToNull(call.getString("displayName"));
        final String requestedAlbum = trimToNull(call.getString("albumName"));

        if ((base64 == null) == (sourceUrl == null)) {
            call.reject("必须且只能提供 base64 或 sourceUrl 之一");
            return;
        }
        if (requestedName == null) {
            call.reject("displayName 不能为空");
            return;
        }

        new Thread(() -> {
            try {
                LoadedImage loaded = base64 != null
                    ? loadBase64(base64, requestedMime)
                    : loadRemote(sourceUrl, requestedMime);

                String album = sanitizeSegment(
                    requestedAlbum,
                    "未命名角色",
                    48
                );
                String displayName = normalizeDisplayName(
                    requestedName,
                    loaded.mimeType
                );

                SavedImage saved = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q
                    ? saveModern(loaded, displayName, album)
                    : saveLegacy(loaded, displayName, album);

                JSObject result = new JSObject();
                result.put("uri", saved.uri);
                result.put("displayName", saved.displayName);
                result.put("relativePath", saved.relativePath);
                resolveOnMain(call, result);
            } catch (Exception error) {
                rejectOnMain(
                    call,
                    error.getMessage() == null
                        ? "保存到系统相册失败"
                        : error.getMessage()
                );
            }
        }, "sully-gallery-save").start();
    }

    private LoadedImage loadBase64(
        String encoded,
        String requestedMime
    ) throws Exception {
        String raw = encoded;
        int comma = raw.indexOf(',');
        if (raw.startsWith("data:") && comma >= 0) {
            raw = raw.substring(comma + 1);
        }

        byte[] bytes;
        try {
            bytes = Base64.decode(raw, Base64.DEFAULT);
        } catch (IllegalArgumentException error) {
            throw new Exception("图片 Base64 数据无效");
        }
        return validateLoaded(bytes, requestedMime);
    }

    private LoadedImage loadRemote(
        String rawUrl,
        String requestedMime
    ) throws Exception {
        URL url;
        try {
            url = new URL(rawUrl);
        } catch (Exception error) {
            throw new Exception("旧图片地址无效");
        }

        String protocol = url.getProtocol().toLowerCase(Locale.ROOT);
        if (!protocol.equals("https") && !protocol.equals("http")) {
            throw new Exception("只允许从 HTTP(S) 图片地址导出");
        }

        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) url.openConnection();
            connection.setConnectTimeout(CONNECT_TIMEOUT_MS);
            connection.setReadTimeout(READ_TIMEOUT_MS);
            connection.setInstanceFollowRedirects(true);
            connection.setRequestProperty("Accept", "image/*");
            connection.setRequestProperty("User-Agent", "SullyOS-Gallery/1.0");

            int status = connection.getResponseCode();
            if (status < 200 || status >= 300) {
                throw new Exception("旧图片下载失败：HTTP " + status);
            }

            long declaredLength = connection.getContentLengthLong();
            if (declaredLength > MAX_BYTES) {
                throw new Exception("图片超过 32 MiB，无法安全导出");
            }

            String responseMime = normalizeMime(
                connection.getContentType()
            );
            try (InputStream input = connection.getInputStream()) {
                byte[] bytes = readBounded(input);
                return validateLoaded(
                    bytes,
                    responseMime != null ? responseMime : requestedMime
                );
            }
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    private byte[] readBounded(InputStream input) throws Exception {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        byte[] buffer = new byte[64 * 1024];
        int total = 0;
        int read;

        while ((read = input.read(buffer)) != -1) {
            total += read;
            if (total > MAX_BYTES) {
                throw new Exception("图片超过 32 MiB，无法安全导出");
            }
            output.write(buffer, 0, read);
        }

        byte[] bytes = output.toByteArray();
        if (bytes.length == 0) throw new Exception("图片内容为空");
        return bytes;
    }

    private LoadedImage validateLoaded(
        byte[] bytes,
        String requestedMime
    ) throws Exception {
        if (bytes == null || bytes.length == 0) {
            throw new Exception("图片内容为空");
        }
        if (bytes.length > MAX_BYTES) {
            throw new Exception("图片超过 32 MiB，无法安全导出");
        }

        String detected = detectMime(bytes);
        String normalizedRequested = normalizeMime(requestedMime);
        String mime = detected != null ? detected : normalizedRequested;
        if (!isSupportedMime(mime)) {
            throw new Exception("暂不支持这种图片格式");
        }
        return new LoadedImage(bytes, mime);
    }

    private SavedImage saveModern(
        LoadedImage image,
        String displayName,
        String album
    ) throws Exception {
        ContentResolver resolver = getContext().getContentResolver();
        String relativePath =
            Environment.DIRECTORY_PICTURES + "/SullyOS/" + album;

        ContentValues values = new ContentValues();
        values.put(MediaStore.Images.Media.DISPLAY_NAME, displayName);
        values.put(MediaStore.Images.Media.MIME_TYPE, image.mimeType);
        values.put(MediaStore.Images.Media.RELATIVE_PATH, relativePath);
        values.put(MediaStore.Images.Media.IS_PENDING, 1);

        Uri collection = MediaStore.Images.Media.getContentUri(
            MediaStore.VOLUME_EXTERNAL_PRIMARY
        );
        Uri uri = resolver.insert(collection, values);
        if (uri == null) {
            throw new Exception("系统相册无法创建图片记录");
        }

        boolean published = false;
        try {
            try (OutputStream output = resolver.openOutputStream(uri, "w")) {
                if (output == null) {
                    throw new Exception("系统相册无法打开图片文件");
                }
                output.write(image.bytes);
                output.flush();
            }

            ContentValues publish = new ContentValues();
            publish.put(MediaStore.Images.Media.IS_PENDING, 0);
            resolver.update(uri, publish, null, null);
            published = true;

            return new SavedImage(
                uri.toString(),
                displayName,
                relativePath
            );
        } finally {
            if (!published) {
                try {
                    resolver.delete(uri, null, null);
                } catch (Exception ignored) {
                    // best effort rollback
                }
            }
        }
    }

    @SuppressWarnings("deprecation")
    private SavedImage saveLegacy(
        LoadedImage image,
        String displayName,
        String album
    ) throws Exception {
        File pictures = Environment.getExternalStoragePublicDirectory(
            Environment.DIRECTORY_PICTURES
        );
        File directory = new File(
            new File(pictures, "SullyOS"),
            album
        );
        if (!directory.exists() && !directory.mkdirs()) {
            throw new Exception("无法创建系统相册目录");
        }

        File target = uniqueFile(directory, displayName);
        try (FileOutputStream output = new FileOutputStream(target)) {
            output.write(image.bytes);
            output.flush();
        }

        MediaScannerConnection.scanFile(
            getContext(),
            new String[] { target.getAbsolutePath() },
            new String[] { image.mimeType },
            null
        );

        return new SavedImage(
            Uri.fromFile(target).toString(),
            target.getName(),
            "Pictures/SullyOS/" + album
        );
    }

    private File uniqueFile(File directory, String displayName) {
        File target = new File(directory, displayName);
        if (!target.exists()) return target;

        int dot = displayName.lastIndexOf('.');
        String stem = dot > 0
            ? displayName.substring(0, dot)
            : displayName;
        String extension = dot > 0
            ? displayName.substring(dot)
            : "";

        int suffix = 2;
        while (target.exists()) {
            target = new File(
                directory,
                stem + " (" + suffix + ")" + extension
            );
            suffix++;
        }
        return target;
    }

    private String normalizeDisplayName(
        String requested,
        String mime
    ) {
        String name = sanitizeSegment(
            new File(requested).getName(),
            "SullyOS_image",
            96
        );
        name = name.replaceFirst(
            "(?i)\\.(png|jpe?g|gif|webp|avif)$",
            ""
        );
        return name + "." + extensionForMime(mime);
    }

    private String sanitizeSegment(
        String value,
        String fallback,
        int maxLength
    ) {
        String cleaned = value == null
            ? ""
            : value
                .replaceAll("[\\\\/:*?\"<>|\\p{Cntrl}]+", "_")
                .replaceAll("\\s+", " ")
                .replaceAll("^\\.+|\\.+$", "")
                .trim();

        if (cleaned.length() > maxLength) {
            cleaned = cleaned.substring(0, maxLength).trim();
        }
        return cleaned.isEmpty() ? fallback : cleaned;
    }

    private String normalizeMime(String value) {
        if (value == null) return null;
        String normalized = value
            .toLowerCase(Locale.ROOT)
            .split(";", 2)[0]
            .trim();
        if (normalized.equals("image/jpg")) return "image/jpeg";
        return normalized;
    }

    private boolean isSupportedMime(String mime) {
        return "image/png".equals(mime)
            || "image/jpeg".equals(mime)
            || "image/gif".equals(mime)
            || "image/webp".equals(mime)
            || "image/avif".equals(mime);
    }

    private String extensionForMime(String mime) {
        if ("image/jpeg".equals(mime)) return "jpg";
        if ("image/gif".equals(mime)) return "gif";
        if ("image/webp".equals(mime)) return "webp";
        if ("image/avif".equals(mime)) return "avif";
        return "png";
    }

    private String detectMime(byte[] bytes) {
        if (
            bytes.length >= 8
            && (bytes[0] & 0xff) == 0x89
            && bytes[1] == 0x50
            && bytes[2] == 0x4e
            && bytes[3] == 0x47
            && bytes[4] == 0x0d
            && bytes[5] == 0x0a
            && bytes[6] == 0x1a
            && bytes[7] == 0x0a
        ) {
            return "image/png";
        }

        if (
            bytes.length >= 3
            && (bytes[0] & 0xff) == 0xff
            && (bytes[1] & 0xff) == 0xd8
            && (bytes[2] & 0xff) == 0xff
        ) {
            return "image/jpeg";
        }

        if (bytes.length >= 6) {
            String gif = new String(
                bytes,
                0,
                6,
                StandardCharsets.US_ASCII
            );
            if (gif.equals("GIF87a") || gif.equals("GIF89a")) {
                return "image/gif";
            }
        }

        if (
            bytes.length >= 12
            && ascii(bytes, 0, 4).equals("RIFF")
            && ascii(bytes, 8, 12).equals("WEBP")
        ) {
            return "image/webp";
        }

        if (
            bytes.length >= 12
            && ascii(bytes, 4, 8).equals("ftyp")
            && (
                ascii(bytes, 8, 12).equals("avif")
                || ascii(bytes, 8, 12).equals("avis")
            )
        ) {
            return "image/avif";
        }

        return null;
    }

    private String ascii(byte[] bytes, int start, int end) {
        return new String(
            bytes,
            start,
            end - start,
            StandardCharsets.US_ASCII
        );
    }

    private String trimToNull(String value) {
        if (value == null) return null;
        String trimmed = value.trim();
        return trimmed.isEmpty() ? null : trimmed;
    }

    private void resolveOnMain(PluginCall call, JSObject result) {
        getActivity().runOnUiThread(() -> call.resolve(result));
    }

    private void rejectOnMain(PluginCall call, String message) {
        getActivity().runOnUiThread(() -> call.reject(message));
    }
}
