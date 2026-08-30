package __APP_ID__.plugins;

import android.app.Activity;
import android.content.ContentResolver;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.provider.DocumentsContract;

import androidx.activity.result.ActivityResult;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.UUID;

@CapacitorPlugin(name = "SullyLive2DDirectory")
public class SullyLive2DDirectoryPlugin extends Plugin {

    private static final long MAX_IMPORT_BYTES = 250L * 1024L * 1024L;
    private static final String CACHE_FOLDER = "live2d-directory-import";

    private static final class DocumentNode {
        final String documentId;
        final String name;
        final String mimeType;
        final long size;

        DocumentNode(String documentId, String name, String mimeType, long size) {
            this.documentId = documentId;
            this.name = name;
            this.mimeType = mimeType;
            this.size = size;
        }

        boolean isDirectory() {
            return DocumentsContract.Document.MIME_TYPE_DIR.equals(mimeType);
        }
    }

    private static final class CopiedFile {
        final String relativePath;
        final Uri uri;
        final long size;
        final String mimeType;

        CopiedFile(String relativePath, Uri uri, long size, String mimeType) {
            this.relativePath = relativePath;
            this.uri = uri;
            this.size = size;
            this.mimeType = mimeType;
        }
    }

    private static final class CopyState {
        long totalBytes = 0;
        final List<CopiedFile> files = new ArrayList<>();
    }

    @PluginMethod
    public void pickDirectory(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
        intent.addFlags(
            Intent.FLAG_GRANT_READ_URI_PERMISSION
                | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION
                | Intent.FLAG_GRANT_PREFIX_URI_PERMISSION
        );
        startActivityForResult(call, intent, "pickDirectoryResult");
    }

    @ActivityCallback
    private void pickDirectoryResult(PluginCall call, ActivityResult activityResult) {
        Intent data = activityResult.getData();
        if (activityResult.getResultCode() != Activity.RESULT_OK || data == null || data.getData() == null) {
            JSObject cancelled = new JSObject();
            cancelled.put("cancelled", true);
            call.resolve(cancelled);
            return;
        }

        Uri treeUri = data.getData();
        int grantedFlags = data.getFlags() & (
            Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION
        );
        try {
            // The import is copied immediately into private cache. Persisting the grant keeps
            // slow, large copies valid even if Android recreates the activity mid-selection.
            getContext().getContentResolver().takePersistableUriPermission(
                treeUri,
                grantedFlags & Intent.FLAG_GRANT_READ_URI_PERMISSION
            );
        } catch (Exception ignored) {
            // Some document providers only offer a grant for the current activity. That is
            // sufficient because this plugin finishes the copy before resolving the call.
        }

        new Thread(() -> importTree(call, treeUri), "sully-live2d-directory").start();
    }

    @PluginMethod
    public void clearImport(PluginCall call) {
        String sessionId = call.getString("sessionId");
        if (sessionId == null || !sessionId.matches("[0-9a-fA-F-]{36}")) {
            call.reject("Live2D 暂存会话无效");
            return;
        }
        File cacheRoot = new File(getContext().getCacheDir(), CACHE_FOLDER);
        File target = new File(cacheRoot, sessionId);
        try {
            String rootPath = cacheRoot.getCanonicalPath() + File.separator;
            if (!target.getCanonicalPath().startsWith(rootPath)) {
                call.reject("Live2D 暂存路径无效");
                return;
            }
            deleteRecursively(target);
            call.resolve();
        } catch (Exception error) {
            call.reject("清理 Live2D 暂存文件失败", error);
        }
    }

    private void importTree(PluginCall call, Uri treeUri) {
        String sessionId = UUID.randomUUID().toString();
        File sessionRoot = new File(new File(getContext().getCacheDir(), CACHE_FOLDER), sessionId);
        try {
            ContentResolver resolver = getContext().getContentResolver();
            String rootDocumentId = DocumentsContract.getTreeDocumentId(treeUri);
            List<DocumentNode> rootChildren = listChildren(resolver, treeUri, rootDocumentId);
            List<DocumentNode> modelEntries = new ArrayList<>();
            for (DocumentNode child : rootChildren) {
                if (!child.isDirectory() && child.name.toLowerCase(Locale.ROOT).endsWith(".model3.json")) {
                    modelEntries.add(child);
                }
            }
            if (modelEntries.isEmpty()) {
                throw new Exception("所选文件夹不是有效的 Live2D 模型目录，未找到 *.model3.json");
            }
            if (modelEntries.size() > 1) {
                throw new Exception("所选文件夹检测到多个 *.model3.json，请一次只导入一个模型");
            }
            if (!sessionRoot.mkdirs()) throw new Exception("无法创建 Live2D 暂存目录");

            CopyState state = new CopyState();
            copyChildren(resolver, treeUri, rootDocumentId, sessionRoot, "", state);
            JSArray files = new JSArray();
            for (CopiedFile copied : state.files) {
                JSObject item = new JSObject();
                item.put("relativePath", copied.relativePath);
                item.put("uri", copied.uri.toString());
                item.put("size", copied.size);
                if (copied.mimeType != null) item.put("mimeType", copied.mimeType);
                files.put(item);
            }

            JSObject result = new JSObject();
            result.put("cancelled", false);
            result.put("sessionId", sessionId);
            result.put("directoryName", queryDisplayName(resolver, treeUri, rootDocumentId));
            result.put("totalBytes", state.totalBytes);
            result.put("files", files);
            resolveOnMain(call, result);
        } catch (Exception error) {
            deleteRecursively(sessionRoot);
            rejectOnMain(call, error.getMessage() == null ? "读取 Live2D 文件夹失败" : error.getMessage(), error);
        } finally {
            try {
                getContext().getContentResolver().releasePersistableUriPermission(
                    treeUri,
                    Intent.FLAG_GRANT_READ_URI_PERMISSION
                );
            } catch (Exception ignored) {
                // No persisted grant was acquired from this provider.
            }
        }
    }

    private void copyChildren(
        ContentResolver resolver,
        Uri treeUri,
        String parentDocumentId,
        File targetDirectory,
        String relativeDirectory,
        CopyState state
    ) throws Exception {
        for (DocumentNode child : listChildren(resolver, treeUri, parentDocumentId)) {
            validateName(child.name);
            String relativePath = relativeDirectory.isEmpty()
                ? child.name
                : relativeDirectory + "/" + child.name;
            File target = new File(targetDirectory, child.name);
            if (child.isDirectory()) {
                if (!target.mkdir() && !target.isDirectory()) {
                    throw new Exception("无法暂存模型子目录：" + relativePath);
                }
                copyChildren(resolver, treeUri, child.documentId, target, relativePath, state);
                continue;
            }

            Uri documentUri = DocumentsContract.buildDocumentUriUsingTree(treeUri, child.documentId);
            long copiedBytes = copyDocument(resolver, documentUri, target, state.totalBytes);
            state.totalBytes += copiedBytes;
            state.files.add(new CopiedFile(
                relativePath,
                Uri.fromFile(target),
                copiedBytes,
                child.mimeType
            ));
        }
    }

    private long copyDocument(ContentResolver resolver, Uri source, File target, long alreadyCopied) throws Exception {
        long copied = 0;
        try (InputStream input = resolver.openInputStream(source);
             OutputStream output = new FileOutputStream(target)) {
            if (input == null) throw new Exception("系统文件提供方无法打开模型文件");
            byte[] buffer = new byte[64 * 1024];
            int read;
            while ((read = input.read(buffer)) != -1) {
                copied += read;
                if (alreadyCopied + copied > MAX_IMPORT_BYTES) {
                    throw new Exception("Live2D 文件夹超过 250 MB，请先压缩纹理尺寸或删掉无关文件");
                }
                output.write(buffer, 0, read);
            }
        }
        return copied;
    }

    private List<DocumentNode> listChildren(ContentResolver resolver, Uri treeUri, String parentDocumentId) throws Exception {
        Uri childrenUri = DocumentsContract.buildChildDocumentsUriUsingTree(treeUri, parentDocumentId);
        String[] projection = {
            DocumentsContract.Document.COLUMN_DOCUMENT_ID,
            DocumentsContract.Document.COLUMN_DISPLAY_NAME,
            DocumentsContract.Document.COLUMN_MIME_TYPE,
            DocumentsContract.Document.COLUMN_SIZE,
        };
        List<DocumentNode> children = new ArrayList<>();
        try (Cursor cursor = resolver.query(childrenUri, projection, null, null, null)) {
            if (cursor == null) throw new Exception("系统文件提供方无法列出所选目录");
            int idIndex = cursor.getColumnIndexOrThrow(DocumentsContract.Document.COLUMN_DOCUMENT_ID);
            int nameIndex = cursor.getColumnIndexOrThrow(DocumentsContract.Document.COLUMN_DISPLAY_NAME);
            int mimeIndex = cursor.getColumnIndexOrThrow(DocumentsContract.Document.COLUMN_MIME_TYPE);
            int sizeIndex = cursor.getColumnIndex(DocumentsContract.Document.COLUMN_SIZE);
            while (cursor.moveToNext()) {
                String id = cursor.getString(idIndex);
                String name = cursor.getString(nameIndex);
                String mime = cursor.getString(mimeIndex);
                long size = sizeIndex >= 0 && !cursor.isNull(sizeIndex) ? cursor.getLong(sizeIndex) : 0;
                if (id != null && name != null) children.add(new DocumentNode(id, name, mime, size));
            }
        }
        return children;
    }

    private String queryDisplayName(ContentResolver resolver, Uri treeUri, String documentId) {
        Uri uri = DocumentsContract.buildDocumentUriUsingTree(treeUri, documentId);
        try (Cursor cursor = resolver.query(
            uri,
            new String[] { DocumentsContract.Document.COLUMN_DISPLAY_NAME },
            null,
            null,
            null
        )) {
            if (cursor != null && cursor.moveToFirst()) return cursor.getString(0);
        } catch (Exception ignored) {
            // The model entry remains authoritative if a provider omits the root display name.
        }
        return "Live2D";
    }

    private void validateName(String name) throws Exception {
        if (name.isEmpty() || name.equals(".") || name.equals("..") || name.contains("/") || name.contains("\\")) {
            throw new Exception("Live2D 文件夹包含无效文件名");
        }
    }

    private void deleteRecursively(File file) {
        if (file == null || !file.exists()) return;
        File[] children = file.listFiles();
        if (children != null) {
            for (File child : children) deleteRecursively(child);
        }
        // Best effort: cache cleanup failure must not invalidate an already imported model.
        file.delete();
    }

    private void resolveOnMain(PluginCall call, JSObject result) {
        getActivity().runOnUiThread(() -> call.resolve(result));
    }

    private void rejectOnMain(PluginCall call, String message, Exception error) {
        getActivity().runOnUiThread(() -> call.reject(message, error));
    }
}
