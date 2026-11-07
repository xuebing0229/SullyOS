package __APP_ID__.plugins

import android.graphics.Rect
import android.graphics.drawable.AdaptiveIconDrawable
import android.graphics.drawable.Drawable
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Matrix
import androidx.compose.ui.graphics.Outline
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.asComposePath
import androidx.compose.ui.graphics.drawscope.drawIntoCanvas
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.LayoutDirection
import androidx.core.content.ContextCompat
import androidx.graphics.shapes.Morph
import androidx.graphics.shapes.toPath
import __APP_ID__.R
import kotlin.math.floor
import kotlin.math.roundToInt

// Copied from RikkaHub AppLogo.kt (AGPL-3.0).
// The only compatibility change is sourcing the same seven Material shape definitions
// from local copied AndroidX source instead of Material3 1.5, because current RikkaHub
// Material3 binaries require compileSdk 37 while SullyOS intentionally stays on 34.
// Source: app/src/main/java/me/rerere/rikkahub/ui/components/ui/AppLogo.kt

@Composable
fun rememberAppLogoLayers(): List<Drawable> {
    val context = LocalContext.current
    return remember(context) {
        val icon = ContextCompat.getDrawable(context, R.mipmap.ic_launcher)
        if (icon is AdaptiveIconDrawable) listOfNotNull(icon.background, icon.foreground)
        else listOfNotNull(icon)
    }
}

fun Modifier.drawAppLogo(layers: List<Drawable>): Modifier = drawBehind {
    drawIntoCanvas { canvas ->
        layers.forEach { layer ->
            layer.bounds = logoLayerBounds(size)
            layer.draw(canvas.nativeCanvas)
        }
    }
}

fun logoMorphShape(position: Float, extraRotation: Float = 0f): Shape {
    val segment = floor(position).toInt()
    return MorphShape(
        morph = LogoMorphs[segment.mod(LogoMorphs.size)],
        progress = position - segment,
        rotation = position * 90f + extraRotation,
    )
}

private fun logoLayerBounds(size: Size): Rect {
    val insetX = (size.width / 4f).roundToInt()
    val insetY = (size.height / 4f).roundToInt()
    return Rect(-insetX, -insetY, size.width.roundToInt() + insetX, size.height.roundToInt() + insetY)
}

private val LogoShapes = listOf(
    SullyMaterialShapes.Cookie12Sided,
    SullyMaterialShapes.Clover4Leaf,
    SullyMaterialShapes.Cookie9Sided,
    SullyMaterialShapes.Sunny,
    SullyMaterialShapes.Cookie6Sided,
    SullyMaterialShapes.Flower,
    SullyMaterialShapes.Cookie4Sided,
)

private val LogoMorphs = LogoShapes.indices.map { index ->
    Morph(LogoShapes[index], LogoShapes[(index + 1) % LogoShapes.size])
}

private class MorphShape(
    private val morph: Morph,
    private val progress: Float,
    private val rotation: Float,
) : Shape {
    override fun createOutline(size: Size, layoutDirection: LayoutDirection, density: Density): Outline {
        // graphics-shapes 1.0.1 already exposes the Android Path conversion used by
        // Material3. Convert that path to Compose instead of pulling Material3 1.5.
        val path = morph.toPath(progress).asComposePath()
        val matrix = Matrix().apply {
            translate(size.width / 2f, size.height / 2f)
            rotateZ(rotation)
            translate(-size.width / 2f, -size.height / 2f)
            scale(size.width, size.height)
        }
        path.transform(matrix)
        return Outline.Generic(path)
    }
}
