package __APP_ID__.plugins

import android.graphics.Matrix
import androidx.graphics.shapes.CornerRounding
import androidx.graphics.shapes.RoundedPolygon
import androidx.graphics.shapes.star
import androidx.graphics.shapes.transformed
import kotlin.math.PI
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.sin

// Copied from AndroidX Material3 MaterialShapes.kt (Apache-2.0), trimmed to the
// seven shapes RikkaHub's floating bubble actually cycles through.
// Source: androidx/androidx compose/material3/.../MaterialShapes.kt
internal object SullyMaterialShapes {
    private val cornerRound15 = CornerRounding(radius = .15f)
    private val cornerRound50 = CornerRounding(radius = .5f)
    private val rotateNeg90 = Matrix().apply { postRotate(-90f) }

    val Cookie12Sided: RoundedPolygon by lazy {
        RoundedPolygon.star(
            numVerticesPerRadius = 12,
            innerRadius = .8f,
            rounding = cornerRound50,
        ).transformed(rotateNeg90).normalized()
    }

    val Clover4Leaf: RoundedPolygon by lazy {
        customPolygon(
            listOf(
                PointNRound(0.500f, 0.074f),
                PointNRound(0.725f, -0.099f, CornerRounding(0.476f)),
            ),
            reps = 4,
            mirroring = true,
        ).normalized()
    }

    val Cookie9Sided: RoundedPolygon by lazy {
        RoundedPolygon.star(
            numVerticesPerRadius = 9,
            innerRadius = .8f,
            rounding = cornerRound50,
        ).transformed(rotateNeg90).normalized()
    }

    val Sunny: RoundedPolygon by lazy {
        RoundedPolygon.star(
            numVerticesPerRadius = 8,
            innerRadius = .8f,
            rounding = cornerRound15,
        ).normalized()
    }

    val Cookie6Sided: RoundedPolygon by lazy {
        customPolygon(
            listOf(
                PointNRound(0.723f, 0.884f, CornerRounding(0.394f)),
                PointNRound(0.500f, 1.099f, CornerRounding(0.398f)),
            ),
            reps = 6,
        ).normalized()
    }

    val Flower: RoundedPolygon by lazy {
        customPolygon(
            listOf(
                PointNRound(0.370f, 0.187f),
                PointNRound(0.416f, 0.049f, CornerRounding(0.381f)),
                PointNRound(0.479f, 0.001f, CornerRounding(0.095f)),
            ),
            reps = 8,
            mirroring = true,
        ).normalized()
    }

    val Cookie4Sided: RoundedPolygon by lazy {
        customPolygon(
            listOf(
                PointNRound(1.237f, 1.236f, CornerRounding(0.258f)),
                PointNRound(0.500f, 0.918f, CornerRounding(0.233f)),
            ),
            reps = 4,
        ).normalized()
    }

    private data class PointNRound(
        val x: Float,
        val y: Float,
        val r: CornerRounding = CornerRounding.Unrounded,
    )

    private data class Point(val x: Float, val y: Float)

    private fun doRepeat(
        points: List<PointNRound>,
        reps: Int,
        center: Point,
        mirroring: Boolean,
    ): List<PointNRound> =
        if (mirroring) {
            buildList {
                val angles = points.map { angleDegrees(it.x - center.x, it.y - center.y) }
                val distances = points.map {
                    val dx = it.x - center.x
                    val dy = it.y - center.y
                    kotlin.math.sqrt(dx * dx + dy * dy)
                }
                val actualReps = reps * 2
                val sectionAngle = 360f / actualReps
                repeat(actualReps) { rep ->
                    points.indices.forEach { index ->
                        val i = if (rep % 2 == 0) index else points.lastIndex - index
                        if (i > 0 || rep % 2 == 0) {
                            val a = (
                                sectionAngle * rep +
                                    if (rep % 2 == 0) angles[i]
                                    else sectionAngle - angles[i] + 2 * angles[0]
                                ).toRadians()
                            add(
                                PointNRound(
                                    cos(a) * distances[i] + center.x,
                                    sin(a) * distances[i] + center.y,
                                    points[i].r,
                                )
                            )
                        }
                    }
                }
            }
        } else {
            val np = points.size
            (0 until np * reps).map { ix ->
                val p = points[ix % np]
                val a = (ix / np) * 360f / reps
                val rotated = rotateDegrees(p.x, p.y, a, center)
                PointNRound(rotated.x, rotated.y, p.r)
            }
        }

    private fun rotateDegrees(x: Float, y: Float, angle: Float, center: Point): Point {
        val a = angle.toRadians()
        val dx = x - center.x
        val dy = y - center.y
        return Point(
            dx * cos(a) - dy * sin(a) + center.x,
            dx * sin(a) + dy * cos(a) + center.y,
        )
    }

    private fun Float.toRadians(): Float = this / 360f * 2f * PI.toFloat()
    private fun angleDegrees(x: Float, y: Float): Float = atan2(y, x) * 180f / PI.toFloat()

    private fun customPolygon(
        pnr: List<PointNRound>,
        reps: Int,
        center: Point = Point(0.5f, 0.5f),
        mirroring: Boolean = false,
    ): RoundedPolygon {
        val actualPoints = doRepeat(pnr, reps, center, mirroring)
        return RoundedPolygon(
            vertices = FloatArray(actualPoints.size * 2) { ix ->
                actualPoints[ix / 2].let { if (ix % 2 == 0) it.x else it.y }
            },
            perVertexRounding = actualPoints.map { it.r },
            centerX = center.x,
            centerY = center.y,
        )
    }
}
