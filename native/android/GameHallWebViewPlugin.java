package __APP_ID__.plugins;

import android.annotation.SuppressLint;
import android.graphics.Color;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "GameHallWebView")
public class GameHallWebViewPlugin extends Plugin {
    private WebView gameView;
    private FrameLayout.LayoutParams layout;
    private boolean loading;

    private int px(double cssPx) {
        return (int) Math.round(cssPx * getContext().getResources().getDisplayMetrics().density);
    }

    private JSObject state() {
        JSObject out = new JSObject();
        out.put("url", gameView == null || gameView.getUrl() == null ? "" : gameView.getUrl());
        out.put("title", gameView == null || gameView.getTitle() == null ? "" : gameView.getTitle());
        out.put("loading", loading);
        out.put("canGoBack", gameView != null && gameView.canGoBack());
        return out;
    }

    private void emitState() { notifyListeners("stateChange", state(), true); }

    private void applyFrame(PluginCall call) {
        if (gameView == null) return;
        int x = px(call.getDouble("x", 0.0));
        int y = px(call.getDouble("y", 0.0));
        int width = Math.max(1, px(call.getDouble("width", 1.0)));
        int height = Math.max(1, px(call.getDouble("height", 1.0)));
        layout = new FrameLayout.LayoutParams(width, height);
        layout.leftMargin = x;
        layout.topMargin = y;
        gameView.setLayoutParams(layout);
    }

    @SuppressLint("SetJavaScriptEnabled")
    @PluginMethod
    public void create(PluginCall call) {
        final String url = call.getString("url", "https://toy.cedarstar.org/");
        getActivity().runOnUiThread(() -> {
            try {
                if (gameView == null) {
                    gameView = new WebView(getContext());
                    gameView.setBackgroundColor(Color.WHITE);
                    WebSettings settings = gameView.getSettings();
                    settings.setJavaScriptEnabled(true);
                    settings.setDomStorageEnabled(true);
                    settings.setMediaPlaybackRequiresUserGesture(false);
                    settings.setMixedContentMode(WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE);
                    CookieManager.getInstance().setAcceptCookie(true);
                    CookieManager.getInstance().setAcceptThirdPartyCookies(gameView, true);
                    gameView.setWebChromeClient(new WebChromeClient() {
                        @Override public void onReceivedTitle(WebView view, String title) { emitState(); }
                    });
                    gameView.setWebViewClient(new WebViewClient() {
                        @Override public void onPageStarted(WebView view, String nextUrl, android.graphics.Bitmap favicon) { loading = true; emitState(); }
                        @Override public void onPageFinished(WebView view, String nextUrl) { loading = false; emitState(); }
                    });
                    getActivity().addContentView(gameView, new FrameLayout.LayoutParams(1, 1));
                }
                applyFrame(call);
                gameView.setVisibility(View.VISIBLE);
                if (gameView.getUrl() == null || !gameView.getUrl().equals(url)) gameView.loadUrl(url);
                call.resolve();
            } catch (Exception error) { call.reject("创建游戏 WebView 失败", error); }
        });
    }

    @PluginMethod public void setFrame(PluginCall call) { getActivity().runOnUiThread(() -> { applyFrame(call); call.resolve(); }); }
    @PluginMethod public void loadUrl(PluginCall call) {
        String url = call.getString("url");
        if (url == null || !(url.startsWith("https://") || url.startsWith("http://"))) { call.reject("URL 必须是 HTTP(S)"); return; }
        getActivity().runOnUiThread(() -> { if (gameView == null) call.reject("WebView 尚未创建"); else { gameView.loadUrl(url); call.resolve(); } });
    }
    @PluginMethod public void reload(PluginCall call) { getActivity().runOnUiThread(() -> { if (gameView != null) gameView.reload(); call.resolve(); }); }
    @PluginMethod public void goBack(PluginCall call) { getActivity().runOnUiThread(() -> { if (gameView != null && gameView.canGoBack()) gameView.goBack(); call.resolve(); }); }
    @PluginMethod public void setVisible(PluginCall call) {
        boolean visible = call.getBoolean("visible", true);
        getActivity().runOnUiThread(() -> { if (gameView != null) gameView.setVisibility(visible ? View.VISIBLE : View.GONE); call.resolve(); });
    }
    @PluginMethod public void getState(PluginCall call) { getActivity().runOnUiThread(() -> call.resolve(state())); }
    @PluginMethod public void destroy(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            if (gameView != null) {
                ViewGroup parent = (ViewGroup) gameView.getParent();
                if (parent != null) parent.removeView(gameView);
                gameView.stopLoading(); gameView.setWebChromeClient(null); gameView.setWebViewClient(null); gameView.destroy(); gameView = null;
            }
            call.resolve();
        });
    }
    @Override protected void handleOnPause() { if (gameView != null) gameView.onPause(); }
    @Override protected void handleOnResume() { if (gameView != null) gameView.onResume(); }
    @Override protected void handleOnDestroy() { if (gameView != null) { gameView.destroy(); gameView = null; } }
}
