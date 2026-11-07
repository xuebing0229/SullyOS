package __APP_ID__.plugins;

import android.app.Application;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.provider.Settings;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;

import androidx.core.app.NotificationCompat;

import com.petterp.floatingx.core.FloatingX;
import com.petterp.floatingx.core.FxControl;
import com.petterp.floatingx.core.FxListener;
import com.petterp.floatingx.core.config.FxConfig;
import com.petterp.floatingx.core.config.FxContent;
import com.petterp.floatingx.core.gesture.FxGesture;
import com.petterp.floatingx.core.layout.FxAdsorb;
import com.petterp.floatingx.core.layout.FxEdge;
import com.petterp.floatingx.core.layout.FxGravity;
import com.petterp.floatingx.core.layout.FxHalfHide;
import com.petterp.floatingx.core.storage.FxSpStorage;
import com.petterp.floatingx.system.SystemHost;
import com.petterp.floatingx.system.permission.FxPermissionStrategy;

import java.util.EnumSet;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * 聊天系统悬浮窗与完成通知。
 *
 * 前台保活已交给直接移植自 RikkaHub 的 SullyChatGenerationForegroundService；
 * 本类只负责 FloatingX 窗口状态、内容展示和完成通知。
 */
public class SullyChatFloatingService extends Service {
    public static final String ACTION_START = "SULLY_CHAT_FLOATING_START";
    public static final String ACTION_UPDATE = "SULLY_CHAT_FLOATING_UPDATE";
    public static final String ACTION_FINISH = "SULLY_CHAT_FLOATING_FINISH";
    public static final String ACTION_RELEASE = "SULLY_CHAT_FLOATING_RELEASE";
    public static final String ACTION_APP_VISIBILITY = "SULLY_CHAT_FLOATING_APP_VISIBILITY";

    public static final String EXTRA_ID = "generationId";
    public static final String EXTRA_TITLE = "title";
    public static final String EXTRA_PHASE = "phase";
    public static final String EXTRA_PREVIEW = "preview";
    public static final String EXTRA_SUCCESS = "success";
    public static final String EXTRA_ERROR = "error";
    public static final String EXTRA_FOREGROUND = "appForeground";

    private static final String CHANNEL_ID = "sully_chat_completed_v1";
    private static final int COMPLETE_NOTIFICATION_BASE = 23100;
    private static final long FINISHED_RETENTION_MS = 45_000L;

    private static final String FLOATING_BUBBLE_TAG = "sully-chat-generation-bubble";
    private static final String FLOATING_PANEL_TAG = "sully-chat-generation-panel";

    private final LinkedHashMap<String, GenerationState> generations = new LinkedHashMap<>();
    private final Handler mainHandler = new Handler(Looper.getMainLooper());

    private FxControl bubbleControl;
    private FxControl panelControl;
    private TextView bubbleBadge;
    private TextView panelTitle;
    private TextView panelStatus;
    private TextView panelPreview;

    private boolean appForeground = true;
    private String dismissedGenerationId = null;

    private static final class GenerationState {
        final String id;
        String title;
        String phase;
        String preview;
        String error;
        boolean generating;
        boolean success;
        long updatedAt;
        long finishedAt;

        GenerationState(String id, String title) {
            this.id = id;
            this.title = cleanTitle(title);
            this.phase = "waiting";
            this.preview = "";
            this.error = "";
            this.generating = true;
            this.success = false;
            this.updatedAt = System.currentTimeMillis();
            this.finishedAt = 0L;
        }
    }

    public static boolean start(
        Context context,
        String id,
        String title,
        String phase,
        String preview,
        boolean appForeground
    ) {
        if (!SullyChatGenerationForegroundService.Companion.acquire(
            context,
            id,
            title == null || title.trim().isEmpty() ? "聊天" : title.trim()
        )) {
            return false;
        }
        try {
            Intent intent = serviceIntent(context, ACTION_START)
                .putExtra(EXTRA_ID, id)
                .putExtra(EXTRA_TITLE, title)
                .putExtra(EXTRA_PHASE, phase)
                .putExtra(EXTRA_PREVIEW, preview)
                .putExtra(EXTRA_FOREGROUND, appForeground);
            context.startService(intent);
            return true;
        } catch (Exception error) {
            SullyChatGenerationForegroundService.Companion.release(context, id);
            return false;
        }
    }

    public static void update(Context context, String id, String title, String phase, String preview) {
        send(context, serviceIntent(context, ACTION_UPDATE)
            .putExtra(EXTRA_ID, id)
            .putExtra(EXTRA_TITLE, title)
            .putExtra(EXTRA_PHASE, phase)
            .putExtra(EXTRA_PREVIEW, preview));
    }

    public static void finish(Context context, String id, String title, boolean success, String error) {
        send(context, serviceIntent(context, ACTION_FINISH)
            .putExtra(EXTRA_ID, id)
            .putExtra(EXTRA_TITLE, title)
            .putExtra(EXTRA_SUCCESS, success)
            .putExtra(EXTRA_ERROR, error == null ? "" : error));
        SullyChatGenerationForegroundService.Companion.release(context, id);
    }

    public static void release(Context context, String id) {
        send(context, serviceIntent(context, ACTION_RELEASE).putExtra(EXTRA_ID, id));
        SullyChatGenerationForegroundService.Companion.release(context, id);
    }

    public static void setAppForeground(Context context, boolean foreground) {
        send(context, serviceIntent(context, ACTION_APP_VISIBILITY).putExtra(EXTRA_FOREGROUND, foreground));
    }

    private static Intent serviceIntent(Context context, String action) {
        return new Intent(context, SullyChatFloatingService.class).setAction(action);
    }

    private static void send(Context context, Intent intent) {
        try { context.startService(intent); } catch (Exception ignored) { }
    }

    @Override
    public void onCreate() {
        super.onCreate();
        createChannel();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null) return START_NOT_STICKY;
        String action = intent.getAction();
        if (ACTION_START.equals(action)) handleStart(intent);
        else if (ACTION_UPDATE.equals(action)) handleUpdate(intent);
        else if (ACTION_FINISH.equals(action)) handleFinish(intent);
        else if (ACTION_RELEASE.equals(action)) handleRelease(intent);
        else if (ACTION_APP_VISIBILITY.equals(action)) handleVisibility(intent);
        return START_NOT_STICKY;
    }

    private void handleStart(Intent intent) {
        String id = cleanId(intent.getStringExtra(EXTRA_ID));
        if (id.isEmpty()) return;
        appForeground = intent.getBooleanExtra(EXTRA_FOREGROUND, appForeground);
        GenerationState state = generations.get(id);
        if (state == null) {
            state = new GenerationState(id, intent.getStringExtra(EXTRA_TITLE));
            generations.put(id, state);
        }
        state.generating = true;
        state.finishedAt = 0L;
        state.success = false;
        cancelCompletionNotification(id);
        state.error = "";
        state.title = cleanTitle(intent.getStringExtra(EXTRA_TITLE));
        state.phase = cleanPhase(intent.getStringExtra(EXTRA_PHASE));
        state.preview = cleanPreview(intent.getStringExtra(EXTRA_PREVIEW));
        state.updatedAt = System.currentTimeMillis();
        if (id.equals(dismissedGenerationId)) dismissedGenerationId = null;
        refreshUi();
    }

    private void handleUpdate(Intent intent) {
        String id = cleanId(intent.getStringExtra(EXTRA_ID));
        GenerationState state = generations.get(id);
        if (state == null) return;
        String title = intent.getStringExtra(EXTRA_TITLE);
        if (title != null && !title.trim().isEmpty()) state.title = cleanTitle(title);
        state.phase = cleanPhase(intent.getStringExtra(EXTRA_PHASE));
        state.preview = cleanPreview(intent.getStringExtra(EXTRA_PREVIEW));
        if (!"done".equals(state.phase) && !"failed".equals(state.phase)) {
            state.generating = true;
            state.success = false;
            state.error = "";
            state.finishedAt = 0L;
            cancelCompletionNotification(id);
        }
        state.updatedAt = System.currentTimeMillis();
        refreshUi();
    }

    private void handleFinish(Intent intent) {
        String id = cleanId(intent.getStringExtra(EXTRA_ID));
        GenerationState state = generations.get(id);
        if (state == null) {
            state = new GenerationState(id, intent.getStringExtra(EXTRA_TITLE));
            generations.put(id, state);
        }
        state.generating = false;
        state.success = intent.getBooleanExtra(EXTRA_SUCCESS, true);
        state.error = cleanPreview(intent.getStringExtra(EXTRA_ERROR));
        state.phase = state.success ? "done" : "failed";
        state.updatedAt = System.currentTimeMillis();
        state.finishedAt = state.updatedAt;
        postCompletionNotification(state);
        if (appForeground) {
            generations.remove(id);
        } else {
            scheduleFinishedCleanup(id, state.finishedAt);
        }
        refreshUi();
        maybeStopWhenEmpty();
    }

    private void handleRelease(Intent intent) {
        String id = cleanId(intent.getStringExtra(EXTRA_ID));
        GenerationState state = generations.get(id);
        if (state != null && state.generating) generations.remove(id);
        else if (state == null) generations.remove(id);
        if (id.equals(dismissedGenerationId) && !generations.containsKey(id)) dismissedGenerationId = null;
        refreshUi();
        maybeStopWhenEmpty();
    }

    private void handleVisibility(Intent intent) {
        appForeground = intent.getBooleanExtra(EXTRA_FOREGROUND, true);
        if (appForeground) {
            removeOverlay();
            removeFinishedStates();
            dismissedGenerationId = null;
        } else {
            refreshUi();
        }
        maybeStopWhenEmpty();
    }

    private void scheduleFinishedCleanup(final String id, final long finishedAt) {
        mainHandler.postDelayed(() -> {
            GenerationState state = generations.get(id);
            if (state != null && !state.generating && state.finishedAt == finishedAt) {
                generations.remove(id);
                if (id.equals(dismissedGenerationId)) dismissedGenerationId = null;
                refreshUi();
                maybeStopWhenEmpty();
            }
        }, FINISHED_RETENTION_MS);
    }

    private void removeFinishedStates() {
        java.util.Iterator<Map.Entry<String, GenerationState>> iterator = generations.entrySet().iterator();
        while (iterator.hasNext()) {
            if (!iterator.next().getValue().generating) iterator.remove();
        }
    }

    private GenerationState targetState() {
        GenerationState target = null;
        for (Map.Entry<String, GenerationState> entry : generations.entrySet()) target = entry.getValue();
        return target;
    }

    private void maybeStopWhenEmpty() {
        if (!generations.isEmpty()) return;
        removeOverlay();
        stopSelf();
    }


    private void postCompletionNotification(GenerationState state) {
        if (appForeground) return;
        String body = state.success
            ? state.title + " 的回复已经生成好了"
            : state.title + " 的回复生成失败" + (state.error.isEmpty() ? "" : "：" + trimForNotification(state.error));
        int id = completionNotificationId(state.id);
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager != null) {
            manager.notify(id, baseBuilder(id)
                .setContentTitle(state.success ? "回复已完成" : "回复生成失败")
                .setContentText(body)
                .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
                .setCategory(NotificationCompat.CATEGORY_STATUS)
                .setAutoCancel(true)
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .build());
        }
    }

    private int completionNotificationId(String generationId) {
        return COMPLETE_NOTIFICATION_BASE + Math.abs(generationId.hashCode() % 500);
    }

    private void cancelCompletionNotification(String generationId) {
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager != null) manager.cancel(completionNotificationId(generationId));
    }

    private NotificationCompat.Builder baseBuilder(int requestCode) {
        Intent launch = getPackageManager().getLaunchIntentForPackage(getPackageName());
        PendingIntent pending = launch == null ? null : PendingIntent.getActivity(
            this,
            requestCode,
            launch,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
        return new NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(__APP_ID__.R.drawable.sully_story_notification)
            .setContentIntent(pending)
            .setColor(Color.rgb(102, 187, 153));
    }

    private void createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager == null) return;
        NotificationChannel channel = new NotificationChannel(
            CHANNEL_ID,
            "后台生成",
            NotificationManager.IMPORTANCE_DEFAULT
        );
        channel.setDescription("聊天后台生成进度与完成提醒");
        manager.createNotificationChannel(channel);
    }

    private void refreshUi() {
        if (appForeground || !canDrawOverlays()) {
            removeOverlay();
            return;
        }
        GenerationState state = targetState();
        if (state == null || state.id.equals(dismissedGenerationId)) {
            removeOverlay();
            return;
        }
        if (panelControl != null) updatePanel(state);
        else ensureBubble(state);
    }

    private boolean canDrawOverlays() {
        return Build.VERSION.SDK_INT < Build.VERSION_CODES.M || Settings.canDrawOverlays(this);
    }

    /**
     * 系统浮窗 Host 直接用 FloatingX。权限已由设置页显式引导；
     * 这里只在权限已存在时安装，不让库自己突然弹系统页。
     */
    private SystemHost createSystemHost() {
        Application app = getApplication();
        return SystemHost.builder(app)
            .permission(FxPermissionStrategy.auto())
            .build();
    }

    private void ensureBubble(GenerationState state) {
        if (bubbleControl == null) {
            View bubble = createBubbleView();
            Application app = getApplication();
            FxConfig config = FxConfig.builder(FxContent.view(bubble))
                .anchor(FxGravity.TOP_END, 12f, 180f)
                .margin(8f, 16f, 8f, 16f)
                .adsorb(new FxAdsorb.Edges(
                    EnumSet.of(FxEdge.START, FxEdge.END),
                    new FxHalfHide(0f),
                    true
                ))
                .gesture(FxGesture.Normal)
                .storage(new FxSpStorage(app))
                .build();

            try {
                bubbleControl = FloatingX.install(FLOATING_BUBBLE_TAG, config, createSystemHost());
                bubbleControl.addListener(new FxListener() {
                    @Override
                    public void onClick(FxControl control, View view) {
                        expandPanel();
                    }
                });
                bubbleControl.show();
            } catch (Exception error) {
                bubbleControl = null;
                bubbleBadge = null;
            }
        }
        updateBubble(state);
    }

    private View createBubbleView() {
        FrameLayout root = new FrameLayout(this);
        int outer = dp(64);
        root.setLayoutParams(new ViewGroup.LayoutParams(outer, outer));

        ImageView icon = new ImageView(this);
        FrameLayout.LayoutParams iconLp = new FrameLayout.LayoutParams(dp(50), dp(50), Gravity.CENTER);
        GradientDrawable circle = new GradientDrawable();
        circle.setShape(GradientDrawable.OVAL);
        circle.setColor(Color.WHITE);
        icon.setBackground(circle);
        icon.setPadding(dp(4), dp(4), dp(4), dp(4));
        icon.setImageDrawable(getApplicationInfo().loadIcon(getPackageManager()));
        icon.setScaleType(ImageView.ScaleType.CENTER_INSIDE);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            icon.setClipToOutline(true);
            icon.setElevation(dp(6));
        }
        root.addView(icon, iconLp);

        bubbleBadge = new TextView(this);
        bubbleBadge.setTextColor(Color.WHITE);
        bubbleBadge.setTextSize(10f);
        bubbleBadge.setGravity(Gravity.CENTER);
        GradientDrawable badgeBg = new GradientDrawable();
        badgeBg.setShape(GradientDrawable.OVAL);
        badgeBg.setColor(Color.rgb(65, 155, 120));
        bubbleBadge.setBackground(badgeBg);
        FrameLayout.LayoutParams badgeLp = new FrameLayout.LayoutParams(dp(20), dp(20), Gravity.TOP | Gravity.END);
        badgeLp.setMargins(0, dp(2), dp(2), 0);
        root.addView(bubbleBadge, badgeLp);
        return root;
    }

    private void updateBubble(GenerationState state) {
        if (bubbleBadge == null) return;
        bubbleBadge.setVisibility(state.generating ? View.GONE : View.VISIBLE);
        bubbleBadge.setText(state.success ? "✓" : "!");
    }

    private void expandPanel() {
        GenerationState state = targetState();
        if (state == null || !canDrawOverlays()) return;
        removeBubble();

        View panel = createPanelView();
        int width = Math.max(dp(280), getResources().getDisplayMetrics().widthPixels - dp(24));
        panel.setLayoutParams(new ViewGroup.LayoutParams(width, ViewGroup.LayoutParams.WRAP_CONTENT));

        FxConfig config = FxConfig.builder(FxContent.view(panel))
            .anchor(FxGravity.TOP_CENTER, 0f, 16f)
            .margin(12f, 12f, 12f, 12f)
            .gesture(FxGesture.ClickOnly)
            .build();

        try {
            panelControl = FloatingX.install(FLOATING_PANEL_TAG, config, createSystemHost());
            panelControl.show();
            updatePanel(state);
        } catch (Exception error) {
            panelControl = null;
            panelTitle = null;
            panelStatus = null;
            panelPreview = null;
            ensureBubble(state);
        }
    }

    private View createPanelView() {
        LinearLayout panel = new LinearLayout(this);
        panel.setOrientation(LinearLayout.VERTICAL);
        panel.setPadding(dp(16), dp(14), dp(16), dp(14));
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(Color.rgb(248, 249, 250));
        bg.setCornerRadius(dp(22));
        panel.setBackground(bg);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) panel.setElevation(dp(10));

        LinearLayout header = new LinearLayout(this);
        header.setOrientation(LinearLayout.HORIZONTAL);
        header.setGravity(Gravity.CENTER_VERTICAL);

        LinearLayout textBox = new LinearLayout(this);
        textBox.setOrientation(LinearLayout.VERTICAL);
        textBox.setLayoutParams(new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));

        panelTitle = new TextView(this);
        panelTitle.setTextColor(Color.rgb(30, 34, 38));
        panelTitle.setTextSize(15f);
        panelTitle.setMaxLines(1);
        textBox.addView(panelTitle);

        panelStatus = new TextView(this);
        panelStatus.setTextColor(Color.rgb(100, 108, 116));
        panelStatus.setTextSize(12f);
        panelStatus.setMaxLines(1);
        textBox.addView(panelStatus);
        header.addView(textBox);

        TextView open = headerButton("打开");
        open.setOnClickListener(v -> openApp());
        header.addView(open);

        TextView collapse = headerButton("—");
        collapse.setOnClickListener(v -> collapsePanel());
        header.addView(collapse);

        TextView close = headerButton("×");
        close.setOnClickListener(v -> dismissOverlayForCurrent());
        header.addView(close);
        panel.addView(header);

        panelPreview = new TextView(this);
        panelPreview.setTextColor(Color.rgb(45, 50, 56));
        panelPreview.setTextSize(13f);
        panelPreview.setLineSpacing(0f, 1.15f);
        panelPreview.setMaxLines(12);
        panelPreview.setPadding(0, dp(12), 0, 0);
        panel.addView(panelPreview, new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        ));
        return panel;
    }

    private TextView headerButton(String text) {
        TextView button = new TextView(this);
        button.setText(text);
        button.setTextColor(Color.rgb(65, 75, 82));
        button.setTextSize(13f);
        button.setGravity(Gravity.CENTER);
        button.setPadding(dp(10), dp(8), dp(10), dp(8));
        return button;
    }

    private void updatePanel(GenerationState state) {
        if (panelTitle != null) panelTitle.setText(state.title);
        if (panelStatus != null) panelStatus.setText(statusText(state));
        if (panelPreview != null) {
            String preview = state.preview;
            if (preview.isEmpty()) {
                preview = state.generating ? "正在等待模型返回内容…" : (state.success ? "回复已生成完成" : state.error);
            }
            panelPreview.setText(preview);
        }
    }

    private void collapsePanel() {
        removePanel();
        GenerationState state = targetState();
        if (state != null && !appForeground && !state.id.equals(dismissedGenerationId)) ensureBubble(state);
    }

    private void dismissOverlayForCurrent() {
        GenerationState state = targetState();
        if (state != null) dismissedGenerationId = state.id;
        removeOverlay();
    }

    private void openApp() {
        Intent launch = getPackageManager().getLaunchIntentForPackage(getPackageName());
        if (launch == null) return;
        launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        try { startActivity(launch); } catch (Exception ignored) { }
    }

    private void removeBubble() {
        FxControl control = bubbleControl;
        bubbleControl = null;
        bubbleBadge = null;
        if (control == null) return;
        try { control.cancel(); } catch (Exception ignored) { }
    }

    private void removePanel() {
        FxControl control = panelControl;
        panelControl = null;
        panelTitle = null;
        panelStatus = null;
        panelPreview = null;
        if (control == null) return;
        try { control.cancel(); } catch (Exception ignored) { }
    }

    private void removeOverlay() {
        removeBubble();
        removePanel();
    }

    @Override
    public void onDestroy() {
        removeOverlay();
        mainHandler.removeCallbacksAndMessages(null);
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private String statusText(GenerationState state) {
        if (!state.generating) return state.success ? "已完成" : "生成失败";
        switch (state.phase) {
            case "thinking": return "正在思考";
            case "writing": return "正在生成回复";
            case "tool": return "正在执行工具";
            case "cloud": return "正在云端生成";
            default: return "正在等待回复";
        }
    }

    private static String cleanId(String value) {
        if (value == null) return "";
        String result = value.trim().replaceAll("[^A-Za-z0-9:_-]", "_");
        return result.length() > 160 ? result.substring(0, 160) : result;
    }

    private static String cleanTitle(String value) {
        String result = value == null ? "" : value.trim();
        if (result.isEmpty()) result = "聊天";
        return result.length() > 80 ? result.substring(0, 80) : result;
    }

    private static String cleanPhase(String value) {
        String result = value == null ? "" : value.trim().toLowerCase();
        if ("thinking".equals(result) || "writing".equals(result) || "tool".equals(result)
            || "cloud".equals(result) || "done".equals(result) || "failed".equals(result)) return result;
        return "waiting";
    }

    private static String cleanPreview(String value) {
        if (value == null) return "";
        String result = value.trim();
        return result.length() > 6000 ? result.substring(result.length() - 6000) : result;
    }

    private static String trimForNotification(String value) {
        String result = cleanPreview(value).replaceAll("\\s+", " ").trim();
        return result.length() > 180 ? result.substring(result.length() - 180) : result;
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }
}
