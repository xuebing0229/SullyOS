package __APP_ID__.plugins;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.graphics.Color;
import android.graphics.PixelFormat;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.provider.Settings;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;

import androidx.core.app.NotificationCompat;
import androidx.core.app.ServiceCompat;
import androidx.core.content.ContextCompat;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Chat background keep-alive + system floating window.
 *
 * Behaviour intentionally follows RikkaHub's floating-chat lifecycle:
 * - generation ownership stays in the existing SullyOS chat pipeline;
 * - the foreground service only keeps the app process alive;
 * - the floating window appears only while the app is in background;
 * - a finished reply leaves a completion notification and a short-lived finished bubble.
 *
 * This is a clean-room Android Views implementation for SullyOS' Capacitor stack.
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

    private static final String CHANNEL_ID = "sully_chat_background_v1";
    private static final int FOREGROUND_NOTIFICATION_ID = 23035;
    private static final int COMPLETE_NOTIFICATION_BASE = 23100;
    private static final long FINISHED_RETENTION_MS = 45_000L;

    private final LinkedHashMap<String, GenerationState> generations = new LinkedHashMap<>();
    private final Handler mainHandler = new Handler(Looper.getMainLooper());

    private WindowManager windowManager;
    private View bubbleView;
    private View panelView;
    private WindowManager.LayoutParams bubbleParams;
    private TextView bubbleBadge;
    private TextView panelTitle;
    private TextView panelStatus;
    private TextView panelPreview;

    private boolean appForeground = true;
    private boolean foregroundStarted = false;
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
        try {
            Intent intent = serviceIntent(context, ACTION_START)
                .putExtra(EXTRA_ID, id)
                .putExtra(EXTRA_TITLE, title)
                .putExtra(EXTRA_PHASE, phase)
                .putExtra(EXTRA_PREVIEW, preview)
                .putExtra(EXTRA_FOREGROUND, appForeground);
            ContextCompat.startForegroundService(context, intent);
            return true;
        } catch (Exception error) {
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
    }

    public static void release(Context context, String id) {
        send(context, serviceIntent(context, ACTION_RELEASE).putExtra(EXTRA_ID, id));
    }

    public static void setAppForeground(Context context, boolean foreground) {
        send(context, serviceIntent(context, ACTION_APP_VISIBILITY).putExtra(EXTRA_FOREGROUND, foreground));
    }

    private static Intent serviceIntent(Context context, String action) {
        return new Intent(context, SullyChatFloatingService.class).setAction(action);
    }

    private static void send(Context context, Intent intent) {
        try {
            context.startService(intent);
        } catch (Exception ignored) {
            try { ContextCompat.startForegroundService(context, intent); } catch (Exception ignoredAgain) { }
        }
    }

    @Override
    public void onCreate() {
        super.onCreate();
        windowManager = (WindowManager) getSystemService(WINDOW_SERVICE);
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
        if (!"done".equals(state.phase) && !"failed".equals(state.phase)) {
            // 原生首轮失败后 JS 可能走已有兼容重试；新的真实进度到来就把同一浮窗复活，
            // 不创建第二个 generation。
            state.generating = true;
            state.success = false;
            state.error = "";
            state.finishedAt = 0L;
            cancelCompletionNotification(id);
        }
        state.updatedAt = System.currentTimeMillis();
        if (id.equals(dismissedGenerationId)) dismissedGenerationId = null;
        ensureForeground();
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
        state.updatedAt = System.currentTimeMillis();
        updateForegroundNotification();
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
        if (!hasRunningGeneration()) stopForegroundKeepServiceAlive();
        maybeStopWhenEmpty();
    }

    private void handleRelease(Intent intent) {
        String id = cleanId(intent.getStringExtra(EXTRA_ID));
        GenerationState state = generations.get(id);
        if (state != null && state.generating) {
            generations.remove(id);
        } else if (state == null) {
            generations.remove(id);
        }
        if (id.equals(dismissedGenerationId) && !generations.containsKey(id)) dismissedGenerationId = null;
        refreshUi();
        if (!hasRunningGeneration()) stopForegroundKeepServiceAlive();
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

    private boolean hasRunningGeneration() {
        for (GenerationState state : generations.values()) if (state.generating) return true;
        return false;
    }

    private GenerationState targetState() {
        GenerationState target = null;
        for (Map.Entry<String, GenerationState> entry : generations.entrySet()) target = entry.getValue();
        return target;
    }

    private GenerationState runningTargetState() {
        GenerationState target = null;
        for (Map.Entry<String, GenerationState> entry : generations.entrySet()) {
            if (entry.getValue().generating) target = entry.getValue();
        }
        return target;
    }

    private void maybeStopWhenEmpty() {
        if (!generations.isEmpty()) return;
        removeOverlay();
        stopForegroundKeepServiceAlive();
        stopSelf();
    }

    private void ensureForeground() {
        GenerationState state = runningTargetState();
        if (state == null) return;
        android.app.Notification notification = buildRunningNotification(state);
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                ServiceCompat.startForeground(
                    this,
                    FOREGROUND_NOTIFICATION_ID,
                    notification,
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
                );
            } else {
                startForeground(FOREGROUND_NOTIFICATION_ID, notification);
            }
            foregroundStarted = true;
        } catch (Exception ignored) { }
    }

    private void updateForegroundNotification() {
        if (!foregroundStarted) {
            if (hasRunningGeneration()) ensureForeground();
            return;
        }
        GenerationState target = runningTargetState();
        if (target == null) return;
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager != null) manager.notify(FOREGROUND_NOTIFICATION_ID, buildRunningNotification(target));
    }

    private void stopForegroundKeepServiceAlive() {
        if (!foregroundStarted) return;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) stopForeground(STOP_FOREGROUND_REMOVE);
        else stopForeground(true);
        foregroundStarted = false;
    }

    private android.app.Notification buildRunningNotification(GenerationState state) {
        String body = statusText(state);
        if (!state.preview.isEmpty()) body = body + " · " + trimForNotification(state.preview);
        return baseBuilder(FOREGROUND_NOTIFICATION_ID)
            .setContentTitle(state.title)
            .setContentText(body)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
            .setCategory(NotificationCompat.CATEGORY_PROGRESS)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .build();
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
        updateForegroundNotification();
        if (appForeground || !canDrawOverlays()) {
            removeOverlay();
            return;
        }
        GenerationState state = targetState();
        if (state == null || state.id.equals(dismissedGenerationId)) {
            removeOverlay();
            return;
        }
        if (panelView != null) updatePanel(state);
        else ensureBubble(state);
    }

    private boolean canDrawOverlays() {
        return Build.VERSION.SDK_INT < Build.VERSION_CODES.M || Settings.canDrawOverlays(this);
    }

    private void ensureBubble(GenerationState state) {
        if (bubbleView == null) {
            FrameLayout root = new FrameLayout(this);
            int outer = dp(64);
            root.setLayoutParams(new FrameLayout.LayoutParams(outer, outer));

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

            bubbleView = root;
            bubbleParams = new WindowManager.LayoutParams(
                outer,
                outer,
                overlayType(),
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                    | WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
                PixelFormat.TRANSLUCENT
            );
            bubbleParams.gravity = Gravity.TOP | Gravity.START;
            bubbleParams.x = getResources().getDisplayMetrics().widthPixels - outer - dp(10);
            bubbleParams.y = getSharedPreferences("sully_chat_float", MODE_PRIVATE).getInt("bubble_y", dp(180));
            installBubbleTouch(root);
            try { windowManager.addView(root, bubbleParams); }
            catch (Exception ignored) { bubbleView = null; bubbleBadge = null; }
        }
        updateBubble(state);
    }

    private void updateBubble(GenerationState state) {
        if (bubbleBadge == null) return;
        bubbleBadge.setVisibility(state.generating ? View.GONE : View.VISIBLE);
        bubbleBadge.setText(state.success ? "✓" : "!");
    }

    private void installBubbleTouch(View view) {
        view.setOnTouchListener(new View.OnTouchListener() {
            float downRawX;
            float downRawY;
            int startX;
            int startY;
            boolean moved;

            @Override
            public boolean onTouch(View v, MotionEvent event) {
                if (bubbleParams == null || bubbleView == null) return false;
                switch (event.getActionMasked()) {
                    case MotionEvent.ACTION_DOWN:
                        downRawX = event.getRawX();
                        downRawY = event.getRawY();
                        startX = bubbleParams.x;
                        startY = bubbleParams.y;
                        moved = false;
                        return true;
                    case MotionEvent.ACTION_MOVE:
                        float dx = event.getRawX() - downRawX;
                        float dy = event.getRawY() - downRawY;
                        if (Math.abs(dx) > dp(4) || Math.abs(dy) > dp(4)) moved = true;
                        bubbleParams.x = startX + Math.round(dx);
                        bubbleParams.y = Math.max(0, startY + Math.round(dy));
                        try { windowManager.updateViewLayout(bubbleView, bubbleParams); } catch (Exception ignored) { }
                        return true;
                    case MotionEvent.ACTION_UP:
                        if (!moved) {
                            expandPanel();
                        } else {
                            int screenWidth = getResources().getDisplayMetrics().widthPixels;
                            bubbleParams.x = bubbleParams.x + dp(32) < screenWidth / 2 ? dp(8) : screenWidth - dp(72);
                            getSharedPreferences("sully_chat_float", MODE_PRIVATE)
                                .edit().putInt("bubble_y", bubbleParams.y).apply();
                            try { windowManager.updateViewLayout(bubbleView, bubbleParams); } catch (Exception ignored) { }
                        }
                        return true;
                    default:
                        return false;
                }
            }
        });
    }

    private void expandPanel() {
        GenerationState state = targetState();
        if (state == null || !canDrawOverlays()) return;
        removeBubble();

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

        WindowManager.LayoutParams params = new WindowManager.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT,
            overlayType(),
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                | WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN
                | WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL,
            PixelFormat.TRANSLUCENT
        );
        params.gravity = Gravity.TOP | Gravity.CENTER_HORIZONTAL;
        params.x = 0;
        params.y = dp(16);
        try {
            windowManager.addView(panel, params);
            panelView = panel;
            updatePanel(state);
        } catch (Exception ignored) {
            panelView = null;
            ensureBubble(state);
        }
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
        updateBubble(state);
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
        if (bubbleView == null) return;
        try { windowManager.removeView(bubbleView); } catch (Exception ignored) { }
        bubbleView = null;
        bubbleBadge = null;
        bubbleParams = null;
    }

    private void removePanel() {
        if (panelView == null) return;
        try { windowManager.removeView(panelView); } catch (Exception ignored) { }
        panelView = null;
        panelTitle = null;
        panelStatus = null;
        panelPreview = null;
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

    private int overlayType() {
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
            ? WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
            : WindowManager.LayoutParams.TYPE_PHONE;
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
