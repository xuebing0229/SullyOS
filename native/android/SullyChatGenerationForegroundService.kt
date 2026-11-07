package __APP_ID__.plugins

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat

// Copied from RikkaHub's ChatGenerationForegroundService.kt (AGPL-3.0).
// SullyOS changes are intentionally limited to package/app integration and String IDs.
private const val TAG = "ChatGenerationFgs"
private const val CHANNEL_ID = "sully_chat_background_v1"

/**
 * Keeps the app process in the foreground while one or more chat generations are active.
 *
 * Generation itself remains owned by SullyOS' native generation owner. This service only provides the Android
 * foreground-service lifetime required for streaming to continue after the activity is hidden.
 */
class SullyChatGenerationForegroundService : Service() {
    companion object {
        private const val ACTION_ACQUIRE = "__APP_ID__.action.CHAT_GENERATION_ACQUIRE"
        private const val ACTION_RELEASE = "__APP_ID__.action.CHAT_GENERATION_RELEASE"
        private const val EXTRA_GENERATION_ID = "generation_id"
        private const val EXTRA_CONVERSATION_ID = "conversation_id"

        const val NOTIFICATION_ID = 23035

        fun acquire(context: Context, generationId: String, conversationId: String): Boolean {
            val intent = Intent(context, SullyChatGenerationForegroundService::class.java).apply {
                action = ACTION_ACQUIRE
                putExtra(EXTRA_GENERATION_ID, generationId.toString())
                putExtra(EXTRA_CONVERSATION_ID, conversationId.toString())
            }
            return runCatching {
                ContextCompat.startForegroundService(context, intent)
                true
            }.onFailure {
                Log.e(TAG, "Unable to start chat generation foreground service", it)
            }.getOrDefault(false)
        }

        fun release(context: Context, generationId: String) {
            val intent = Intent(context, SullyChatGenerationForegroundService::class.java).apply {
                action = ACTION_RELEASE
                putExtra(EXTRA_GENERATION_ID, generationId.toString())
            }
            runCatching {
                context.startService(intent)
            }.onFailure {
                Log.e(TAG, "Unable to release chat generation foreground service", it)
            }
        }
    }

    private val activeGenerations = linkedMapOf<String, String>()
    private var isForeground = false

    override fun onCreate() {
        super.onCreate()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            getSystemService(NotificationManager::class.java)?.createNotificationChannel(
                NotificationChannel(CHANNEL_ID, "后台生成", NotificationManager.IMPORTANCE_LOW)
            )
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_ACQUIRE -> acquire(intent, startId)
            ACTION_RELEASE -> release(intent, startId)
            else -> stopSelf(startId)
        }
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        activeGenerations.clear()
        if (isForeground) {
            stopForeground(STOP_FOREGROUND_REMOVE)
            isForeground = false
        }
        super.onDestroy()
    }

    private fun acquire(intent: Intent, startId: Int) {
        val generationId = intent.getStringExtra(EXTRA_GENERATION_ID) ?: return stopSelf(startId)
        val conversationId = intent.getStringExtra(EXTRA_CONVERSATION_ID) ?: return stopSelf(startId)
        activeGenerations[generationId] = conversationId
        updateForegroundNotification(conversationId)
    }

    private fun release(intent: Intent, startId: Int) {
        intent.getStringExtra(EXTRA_GENERATION_ID)?.let(activeGenerations::remove)
        if (activeGenerations.isEmpty()) {
            // Only stop if no newer start request is queued. A pending ACQUIRE came from
            // startForegroundService(), and stopping before it calls startForeground() crashes
            // with ForegroundServiceDidNotStartInTimeException. onDestroy() removes the notification.
            stopSelf(startId)
        } else {
            updateForegroundNotification(activeGenerations.values.last())
        }
    }

    private fun updateForegroundNotification(conversationId: String) {
        try {
            val notification = buildNotification(conversationId)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                ServiceCompat.startForeground(
                    this,
                    NOTIFICATION_ID,
                    notification,
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC,
                )
            } else {
                startForeground(NOTIFICATION_ID, notification)
            }
            isForeground = true
        } catch (e: Exception) {
            Log.e(TAG, "Failed to enter foreground", e)
            activeGenerations.clear()
            stopSelf()
        }
    }

    private fun stopService() {
        if (isForeground) {
            stopForeground(STOP_FOREGROUND_REMOVE)
            isForeground = false
        }
        stopSelf()
    }

    private fun buildNotification(conversationId: String) =
        NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(__APP_ID__.R.drawable.sully_story_notification)
            .setContentTitle(conversationId.ifBlank { "聊天" })
            .setContentText("正在后台生成回复")
            .setContentIntent(getConversationPendingIntent())
            .setCategory(NotificationCompat.CATEGORY_PROGRESS)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .build()

    private fun getConversationPendingIntent(): PendingIntent? {
        val intent = packageManager.getLaunchIntentForPackage(packageName) ?: return null
        return PendingIntent.getActivity(
            this,
            NOTIFICATION_ID,
            intent,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
    }
}
