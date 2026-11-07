package __APP_ID__.plugins

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.PathFillType
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.path
import androidx.compose.ui.unit.dp

// Copied from rikkahub/hugeicons-compose Tick01.kt + Alert01.kt.
// Only package/owner names are adapted so the two vectors do not pull the whole
// current HugeIcons/Compose dependency graph into SullyOS.
internal object SullyFloatingIcons {
    val Tick01: ImageVector by lazy {
        ImageVector.Builder(
            name = "Tick01",
            defaultWidth = 24.dp,
            defaultHeight = 24.dp,
            viewportWidth = 24f,
            viewportHeight = 24f,
        ).apply {
            path(
                fill = null,
                stroke = SolidColor(Color(0xFF141B34)),
                fillAlpha = 1f,
                strokeAlpha = 1f,
                strokeLineWidth = 1.5f,
                strokeLineCap = StrokeCap.Round,
                strokeLineJoin = StrokeJoin.Round,
                pathFillType = PathFillType.NonZero,
            ) {
                moveTo(5f, 14.5f)
                curveTo(5f, 14.5f, 6.5f, 14.5f, 8.5f, 18f)
                curveTo(8.5f, 18f, 14.0588f, 8.83333f, 19f, 7f)
            }
        }.build()
    }

    val Alert01: ImageVector by lazy {
        ImageVector.Builder(
            name = "Alert01",
            defaultWidth = 24.dp,
            defaultHeight = 24.dp,
            viewportWidth = 24f,
            viewportHeight = 24f,
        ).apply {
            path(
                fill = null,
                stroke = SolidColor(Color(0xFF141B34)),
                fillAlpha = 1f,
                strokeAlpha = 1f,
                strokeLineWidth = 1.5f,
                strokeLineCap = StrokeCap.Round,
                strokeLineJoin = StrokeJoin.Round,
                pathFillType = PathFillType.NonZero,
            ) {
                moveTo(13.9248f, 21f)
                horizontalLineTo(10.0752f)
                curveTo(5.44476f, 21f, 3.12955f, 21f, 2.27636f, 19.4939f)
                curveTo(1.42317f, 17.9879f, 2.60736f, 15.9914f, 4.97574f, 11.9985f)
                lineTo(6.90057f, 8.75333f)
                curveTo(9.17559f, 4.91778f, 10.3131f, 3f, 12f, 3f)
                curveTo(13.6869f, 3f, 14.8244f, 4.91777f, 17.0994f, 8.75332f)
                lineTo(19.0243f, 11.9985f)
                curveTo(21.3926f, 15.9914f, 22.5768f, 17.9879f, 21.7236f, 19.4939f)
                curveTo(20.8704f, 21f, 18.5552f, 21f, 13.9248f, 21f)
                close()
            }
            path(
                fill = null,
                stroke = SolidColor(Color(0xFF141B34)),
                fillAlpha = 1f,
                strokeAlpha = 1f,
                strokeLineWidth = 1.5f,
                strokeLineCap = StrokeCap.Round,
                strokeLineJoin = StrokeJoin.Round,
                pathFillType = PathFillType.NonZero,
            ) {
                moveTo(12f, 17f)
                verticalLineTo(13f)
            }
            path(
                fill = null,
                stroke = SolidColor(Color(0xFF141B34)),
                fillAlpha = 1f,
                strokeAlpha = 1f,
                strokeLineWidth = 1.5f,
                strokeLineCap = StrokeCap.Round,
                strokeLineJoin = StrokeJoin.Round,
                pathFillType = PathFillType.NonZero,
            ) {
                moveTo(12f, 9.25f)
                horizontalLineTo(12.125f)
                moveTo(12.25f, 9.25f)
                curveTo(12.25f, 9.11193f, 12.1381f, 9f, 12f, 9f)
                curveTo(11.8619f, 9f, 11.75f, 9.11193f, 11.75f, 9.25f)
                curveTo(11.75f, 9.38807f, 11.8619f, 9.5f, 12f, 9.5f)
                curveTo(12.1381f, 9.5f, 12.25f, 9.38807f, 12.25f, 9.25f)
                close()
            }
        }.build()
    }
}
