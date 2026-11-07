package __APP_ID__.plugins

import android.app.Application
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.Recomposer
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ColorFilter
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.rememberVectorPainter
import androidx.compose.ui.platform.AndroidUiDispatcher
import androidx.compose.ui.platform.ComposeView
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import com.petterp.floatingx.core.FloatingX
import com.petterp.floatingx.core.FxControl
import com.petterp.floatingx.core.animation.FxAnimations
import com.petterp.floatingx.core.config.FxConfig
import com.petterp.floatingx.core.config.FxContent
import com.petterp.floatingx.core.gesture.FxGesture
import com.petterp.floatingx.core.layout.FxAdsorb
import com.petterp.floatingx.core.layout.FxGravity
import com.petterp.floatingx.core.storage.FxSpStorage
import com.petterp.floatingx.system.SystemHost
import com.petterp.floatingx.system.permission.FxPermissionStrategy
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlin.math.ceil
import kotlin.math.floor

// Copied from RikkaHub ChatFloatingContent.kt + ChatFloatingWindows.kt (AGPL-3.0).
// The morph cadence, spin cadence, logo sizing, status badge sizing and FloatingX
// placement are retained. ComposeView replaces FloatingX's compose helper only because
// FloatingX 3's current compose artifact is built against a newer Compose/SDK toolchain.
// Sources:
// app/src/main/java/me/rerere/rikkahub/ui/floating/ChatFloatingContent.kt
// app/src/main/java/me/rerere/rikkahub/ui/floating/ChatFloatingWindows.kt

private val MorphSpring = spring<Float>(dampingRatio = 0.6f, stiffness = 200f, visibilityThreshold = 0.1f)
private const val MORPH_INTERVAL_MILLIS = 650L
private const val SPIN_DURATION_MILLIS = 4666
private const val BUBBLE_TAG = "sully-chat-generation-bubble"

private val SuccessContainer = Color(0xFFB8C7FF)
private val SuccessContent = Color(0xFF203A73)
private val ErrorContainer = Color(0xFFFFB4AB)
private val ErrorContent = Color(0xFF690005)
private val BadgeBorder = Color.White

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
    private var recomposer: Recomposer? = null
    private var recomposeScope: CoroutineScope? = null
    private var owner: SullyFloatingComposeOwner? = null

    fun install(): FxControl {
        // FloatingX FxComposeContent is not just a Recomposer: it also installs its own
        // Lifecycle / ViewModelStore / SavedStateRegistry owners on the overlay view.
        // System WindowManager views do not inherit those from an Activity.
        val overlayOwner = SullyFloatingComposeOwner()
        overlayOwner.moveTo(Lifecycle.State.RESUMED)
        owner = overlayOwner

        val dispatcher = AndroidUiDispatcher.CurrentThread
        val r = Recomposer(dispatcher)
        val scope = CoroutineScope(dispatcher)
        recomposer = r
        recomposeScope = scope
        scope.launch { r.runRecomposeAndApplyChanges() }

        val view = ComposeView(context).apply {
            overlayOwner.attachTo(this)
            setParentCompositionContext(r)
            setContent {
                ChatFloatingBubble(state.value, onClick = { onClick.run() })
            }
        }
        val config = FxConfig.builder(FxContent.view(view))
            .anchor(FxGravity.CENTER_END, 0f, -dp(96f))
            .margin(dp(8f), 0f, dp(8f), 0f)
            .adsorb(FxAdsorb.horizontal())
            .gesture(FxGesture.Normal)
            .storage(FxSpStorage(context))
            .animation(FxAnimations.scale())
            .build()
        val host = SystemHost.builder(context)
            .permission(FxPermissionStrategy.skip())
            .build()

        return try {
            FloatingX.install(BUBBLE_TAG, config, host)
        } catch (error: Throwable) {
            release()
            throw error
        }
    }

    fun update(generating: Boolean, success: Boolean, error: Boolean) {
        state.value = SullyFloatingBubbleState(generating = generating, success = success, error = error)
    }

    fun release() {
        owner?.destroy()
        owner = null
        recomposer?.cancel()
        recomposer = null
        recomposeScope?.cancel()
        recomposeScope = null
    }

    private fun dp(value: Float): Float = value * context.resources.displayMetrics.density
}

@Composable
private fun ChatFloatingBubble(state: SullyFloatingBubbleState, onClick: () -> Unit) {
    val logoLayers = rememberAppLogoLayers()
    val shapePosition = remember { Animatable(0f) }
    val spin = remember { Animatable(0f) }
    val morphing = state.generating

    LaunchedEffect(morphing) {
        if (!morphing) {
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

    // Kept from RikkaHub: no Surface, because FloatingX owns drag gestures.
    Box(modifier = Modifier.padding(6.dp)) {
        Box(
            modifier = Modifier
                .size(52.dp)
                .clip(logoShape)
                .clickable(onClick = onClick)
                .drawAppLogo(logoLayers)
        )
        when {
            state.generating -> {}
            state.error -> StatusBadge(SullyFloatingIcons.Alert01, ErrorContainer, ErrorContent)
            state.success -> StatusBadge(SullyFloatingIcons.Tick01, SuccessContainer, SuccessContent)
        }
    }
}

@Composable
private fun BoxScope.StatusBadge(icon: ImageVector, containerColor: Color, contentColor: Color) {
    Box(
        modifier = Modifier
            .align(Alignment.TopEnd)
            .size(20.dp)
            .border(2.dp, BadgeBorder, CircleShape)
            .padding(2.dp)
            .clip(CircleShape)
            .background(containerColor),
        contentAlignment = Alignment.Center,
    ) {
        Image(
            painter = rememberVectorPainter(icon),
            contentDescription = null,
            colorFilter = ColorFilter.tint(contentColor),
            modifier = Modifier.size(10.dp),
        )
    }
}
