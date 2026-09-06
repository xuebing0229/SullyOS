package __APP_ID__.plugins;

import static org.junit.Assert.*;
import static org.robolectric.Shadows.shadowOf;
import android.app.Notification;
import android.app.NotificationManager;
import android.content.Intent;
import java.io.IOException;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.android.controller.ServiceController;
import org.robolectric.annotation.Config;
import org.robolectric.annotation.LooperMode;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 28)
@LooperMode(LooperMode.Mode.PAUSED)
public class SullyStoryCloudMonitorServiceTest {
    private static final int RUNNING_NOTIFICATION_ID = 23033;
    private static final int TERMINAL_NOTIFICATION_ID = 23034;

    private ServiceController<SullyStoryCloudMonitorService> controller;
    private SullyStoryCloudMonitorService service;
    private NotificationManager notifications;

    @Before public void setup() throws Exception {
        shadowOf(RuntimeEnvironment.getApplication()).grantPermissions(
            RuntimeEnvironment.getApplication().getPackageName() + ".DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION");
        controller = Robolectric.buildService(SullyStoryCloudMonitorService.class).create();
        service = controller.get();
        notifications = service.getSystemService(NotificationManager.class);
        set("jobId", "story_test_job_1");
        set("clientRequestId", "story_test_client_1");
        set("title", "测试剧情");
        set("generation", 7);
    }

    @After public void teardown() { if (controller != null) controller.destroy(); }

    @Test public void successDismissesRunningNotificationWithoutPostingCompletedNotification() throws Exception {
        finish("succeeded", "");

        assertNull(shadowOf(notifications).getNotification(RUNNING_NOTIFICATION_ID));
        assertNull(shadowOf(notifications).getNotification(TERMINAL_NOTIFICATION_ID));
    }

    @Test public void lateLookupCannotRestoreNotificationAfterSuccess() throws Exception {
        set("consecutiveLookupFailures", 4);
        finish("succeeded", "");

        deliverResult(7, null, new IOException("read timed out"));
        deliverResult(7, new JSONObject().put("status", "running"), null);
        deliverResult(7, new JSONObject().put("status", "succeeded"), null);
        finish("succeeded", ""); // duplicate push is stale after the first terminal cleared the active task

        assertNull(shadowOf(notifications).getNotification(RUNNING_NOTIFICATION_ID));
        assertNull(shadowOf(notifications).getNotification(TERMINAL_NOTIFICATION_ID));
    }

    @Test public void failureStillLeavesTerminalNotification() throws Exception {
        finish("failed", "upstream timeout");

        Notification failed = shadowOf(notifications).getNotification(TERMINAL_NOTIFICATION_ID);
        assertNotNull(failed);
        assertTrue(failed.extras.getCharSequence(Notification.EXTRA_TEXT).toString().contains("生成失败"));
        assertTrue(failed.extras.getCharSequence(Notification.EXTRA_TEXT).toString().contains("upstream timeout"));
        assertNull(shadowOf(notifications).getNotification(RUNNING_NOTIFICATION_ID));
    }

    @Test public void cancellationStillLeavesTerminalNotification() throws Exception {
        finish("cancelled", "");

        Notification cancelled = shadowOf(notifications).getNotification(TERMINAL_NOTIFICATION_ID);
        assertNotNull(cancelled);
        assertTrue(cancelled.extras.getCharSequence(Notification.EXTRA_TEXT).toString().contains("已取消"));
        assertNull(shadowOf(notifications).getNotification(RUNNING_NOTIFICATION_ID));
    }

    @Test public void oldLookupCannotFinishANewTask() throws Exception {
        set("generation", 8);
        set("jobId", "story_new_job_2");
        deliverResult(7, new JSONObject().put("status", "succeeded"), null);
        assertNull(shadowOf(notifications).getNotification(RUNNING_NOTIFICATION_ID));
        assertNull(shadowOf(notifications).getNotification(TERMINAL_NOTIFICATION_ID));
        Field job = SullyStoryCloudMonitorService.class.getDeclaredField("jobId");
        job.setAccessible(true);
        assertEquals("story_new_job_2", job.get(service));
    }

    private void finish(String status, String error) {
        service.onStartCommand(new Intent(SullyStoryCloudMonitorService.ACTION_FINISH)
            .putExtra("jobId", "story_test_job_1")
            .putExtra("clientRequestId", "story_test_client_1")
            .putExtra("title", "测试剧情")
            .putExtra("status", status)
            .putExtra("error", error), 0, 1);
    }

    private void deliverResult(int token, JSONObject job, Exception error) throws Exception {
        Method method = SullyStoryCloudMonitorService.class.getDeclaredMethod("handlePollResult", int.class, JSONObject.class, Exception.class);
        method.setAccessible(true);
        method.invoke(service, token, job, error);
    }

    private void set(String name, Object value) throws Exception {
        Field field = SullyStoryCloudMonitorService.class.getDeclaredField(name);
        field.setAccessible(true);
        field.set(service, value);
    }
}
