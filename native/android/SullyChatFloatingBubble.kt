package __APP_ID__.plugins

import android.app.Application
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.dropShadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.shadow.Shadow
import androidx.compose.ui.unit.DpOffset
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.currentStateAsState
import com.petterp.floatingx.compose.compose
import com.petterp.floatingx.core.FloatingX
import com.petterp.floatingx.core.FxControl
import com.petterp.floatingx.core.animation.FxAnimations
import com.petterp.floatingx.core.gesture.FxGesture
import com.petterp.floatingx.core.layout.FxAdsorb
import com.petterp.floatingx.core.layout.FxGravity
import com.petterp.floatingx.core.storage.FxSpStorage
import com.petterp.floatingx.system.permission.FxPermissionStrategy
import com.petterp.floatingx.system.systemHost
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import me.rerere.hugeicons.HugeIcons
import me.rerere.hugeicons.stroke.Alert01
import me.rerere.hugeicons.stroke.Tick01
import kotlin.math.ceil
import kotlin.math.floor

// Copied from RikkaHub ChatFloatingContent.kt + ChatFloatingWindows.kt (AGPL-3.0).
// SullyOS adaptation is intentionally narrow: its own generation state is mapped to
// generating/success/error while the bubble shape, morph timing, spin, badge layout,
// FloatingX placement, adsorption, persistence and scale animation stay the same.
// Sources:
// app/src/main/java/me/rerere/rikkahub/ui/floating/ChatFloatingContent.kt
// app/src/main/java/me/rerere/rikkahub/ui/floating/ChatFloatingWindows.kt

private val MorphSpring = spring<Float>(dampingRatio = 0.6f, stiffness = 200f, visibilityThreshold = 0.1f)
private const val MORPH_INTERVAL_MILLIS = 650L
private const val SPIN_DURATION_MILLIS = 4666
private const val BUBBLE_TAG = "sully-chat-generation-bubble"

data class SullyFloatingBubbleState(
    val generating: Boolean = true,
    val success: Boolean = false,
    val error: Boolean = false,
)

class SullyChatFloatingBubbleHost(
    private val context: Application,
    private val onClick: Runnable,
) {
    private val state = mutableStateOf(SullyFloatingBubbleState())

    fun install(): FxControl = FloatingX.install(BUBBLE_TAG) {
        compose {
            MaterialTheme {
                ChatFloatingBubble(state.value, onClick = { onClick.run() })
            }
        }
        anchor(FxGravity.CENTER_END, dy = -dp(96f))
        margin(left = dp(8f), right = dp(8f))
        adsorb(FxAdsorb.horizontal())
        persist(FxSpStorage(context))
        animation(FxAnimations.scale())
        systemHost(context) { permission(FxPermissionStrategy.skip()) }
    }

    fun update(generating: Boolean, success: Boolean, error: Boolean) {
        state.value = SullyFloatingBubbleState(generating = generating, success = success, error = error)
    }

    private fun dp(value: Float): Float = value * context.resources.displayMetrics.density
}

/** 收起时的小图标：应用 logo，生成中轮廓不停变形，结束后在角上标出结果 */
@Composable
private fun ChatFloatingBubble(state: SullyFloatingBubbleState, onClick: () -> Unit) {
    val colors = MaterialTheme.colorScheme
    val logoLayers = rememberAppLogoLayers()
    val shapePosition = androidx.compose.runtime.remember { Animatable(0f) }
    val spin = androidx.compose.runtime.remember { Animatable(0f) }
    // 收起到面板时窗口隐藏，帧还在跑，停下动画
    val lifecycleState by LocalLifecycleOwner.current.lifecycle.currentStateAsState()
    val morphing = state.generating && lifecycleState.isAtLeast(Lifecycle.State.RESUMED)
    // 节奏照搬 LoadingIndicator：固定间隔变一个形状，弹簧和计时同时跑，另外整体匀速自转
    LaunchedEffect(morphing) {
        if (!morphing) {
            // 停在一个完整的形状上
            shapePosition.animateTo(ceil(shapePosition.value), MorphSpring)
            return@LaunchedEffect
        }
        launch {
            spin.animateTo(
                targetValue = spin.value + 360f,
                animationSpec = infiniteRepeatable(tween(SPIN_DURATION_MILLIS, easing = LinearEasing)),
            )
        }
        while (true) {
            val morph = launch { shapePosition.animateTo(floor(shapePosition.value) + 1f, MorphSpring) }
            delay(MORPH_INTERVAL_MILLIS)
            morph.join()
        }
    }

    val logoShape = logoMorphShape(shapePosition.value, extraRotation = spin.value)

    // 不用 Surface：它会吃掉触摸事件，拖动交给 FloatingX 处理
    Box(modifier = Modifier.padding(6.dp)) {
        Box(
            modifier = Modifier
                .size(52.dp)
                // 不能用 elevation 阴影：轮廓是凹多边形，每帧都要重新三角剖分，变形时会把 RenderThread 卡住几十秒
                .dropShadow(logoShape, Shadow(radius = 6.dp, offset = DpOffset(0.dp, 2.dp), alpha = 0.3f))
                .clip(logoShape)
                .clickable(onClick = onClick)
                .drawAppLogo(logoLayers)
        )
        when {
            state.generating -> {}
            state.error -> StatusBadge(HugeIcons.Alert01, colors.error, colors.onError)
            state.success -> StatusBadge(HugeIcons.Tick01, colors.primary, colors.onPrimary)
        }
    }
}

@Composable
private fun BoxScope.StatusBadge(icon: androidx.compose.ui.graphics.vector.ImageVector, containerColor: Color, contentColor: Color) {
    Box(
        modifier = Modifier
            .align(Alignment.TopEnd)
            .size(20.dp)
            .border(2.dp, MaterialTheme.colorScheme.surface, CircleShape)
            .padding(2.dp)
            .clip(CircleShape)
            .background(containerColor),
        contentAlignment = Alignment.Center,
    ) {
        Icon(icon, contentDescription = null, tint = contentColor, modifier = Modifier.size(10.dp))
    }
}
