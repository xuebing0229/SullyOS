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

    @Test public void lateFifthLookupFailureCannotOverwriteCompletedPush() throws Exception {
        set("consecutiveLookupFailures", 4);
        finish();
        Notification completed = shadowOf(notifications).getNotification(23033);
        assertTrue(completed.extras.getCharSequence(Notification.EXTRA_TEXT).toString().contains("已生成完成"));
        deliverResult(7, null, new IOException("read timed out"));
        assertSame(completed, shadowOf(notifications).getNotification(23033));
    }

    @Test public void lateSuccessCannotRestoreRunningNotificationOrRepeatTerminalAlert() throws Exception {
        set("showingSyncWarning", true);
        finish();
        Notification completed = shadowOf(notifications).getNotification(23033);
        deliverResult(7, new JSONObject().put("status", "running"), null);
        deliverResult(7, new JSONObject().put("status", "succeeded"), null);
        finish(); // duplicate push
        assertSame(completed, shadowOf(notifications).getNotification(23033));
    }

    @Test public void oldLookupCannotFinishANewTask() throws Exception {
        set("generation", 8);
        set("jobId", "story_new_job_2");
        deliverResult(7, new JSONObject().put("status", "succeeded"), null);
        assertNull(shadowOf(notifications).getNotification(23033));
        Field job = SullyStoryCloudMonitorService.class.getDeclaredField("jobId");
        job.setAccessible(true);
        assertEquals("story_new_job_2", job.get(service));
    }

    private void finish() {
        service.onStartCommand(new Intent(SullyStoryCloudMonitorService.ACTION_FINISH)
            .putExtra("jobId", "story_test_job_1")
            .putExtra("clientRequestId", "story_test_client_1")
            .putExtra("title", "测试剧情").putExtra("status", "succeeded"), 0, 1);
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
