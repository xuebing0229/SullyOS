package __APP_ID__.plugins;

import static org.junit.Assert.*;
import android.util.Base64;
import okhttp3.mockwebserver.MockWebServer;
import okhttp3.mockwebserver.MockResponse;
import okhttp3.mockwebserver.RecordedRequest;
import java.nio.charset.StandardCharsets;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 28)
public class SullyStoryReferenceUploadsTest {
    private MockWebServer server;

    @Before public void setup() throws Exception {
        server = new MockWebServer();
        server.start();
    }

    @After public void teardown() throws Exception { server.shutdown(); }

    @Test public void newReferenceIsUploadedAndBytesAreRemovedFromCloudSpec() throws Exception {
        JSONObject handoff = handoff();
        server.enqueue(new MockResponse().setResponseCode(404));
        server.enqueue(new MockResponse().setResponseCode(204));
        SullyStoryReferenceUploads.prepare(handoff);
        assertEquals("HEAD", server.takeRequest().getMethod());
        RecordedRequest upload = server.takeRequest();
        assertEquals("PUT", upload.getMethod());
        assertEquals("new image", upload.getBody().readUtf8());
        assertEquals("Bearer selected-tenant", upload.getHeader("Authorization"));
        assertFalse(tool(handoff).has("referenceUploads"));
        assertFalse(handoff.has("referenceSources"));
        assertEquals(0, tool(handoff).getJSONObject("referenceErrors").length());
    }

    @Test public void replacementOverwritesTheExistingSlot() throws Exception {
        server.enqueue(new MockResponse().setHeader("X-Reference-Sha256", "old-image"));
        server.enqueue(new MockResponse().setResponseCode(204));
        SullyStoryReferenceUploads.prepare(handoff());
        assertEquals("HEAD", server.takeRequest().getMethod());
        assertEquals("new image", server.takeRequest().getBody().readUtf8());
    }

    @Test public void matchingImageSkipsUpload() throws Exception {
        server.enqueue(new MockResponse().setHeader("X-Reference-Sha256", "new-image"));
        SullyStoryReferenceUploads.prepare(handoff());
        assertEquals(1, server.getRequestCount());
        assertEquals("HEAD", server.takeRequest().getMethod());
    }

    @Test public void uploadFailureIsCarriedToWorkerWithoutDroppingTheStory() throws Exception {
        server.enqueue(new MockResponse().setResponseCode(404));
        server.enqueue(new MockResponse().setResponseCode(503));
        JSONObject handoff = handoff();
        SullyStoryReferenceUploads.prepare(handoff);
        assertTrue(tool(handoff).getJSONObject("referenceErrors").getString("slot").contains("503"));
        assertFalse(tool(handoff).has("referenceUploads"));
    }

    private JSONObject handoff() throws Exception {
        JSONObject upload = new JSONObject().put("slotId", "slot").put("sha256", "new-image");
        JSONObject tool = new JSONObject().put("controlBaseUrl", server.url("/").toString())
            .put("token", "selected-tenant").put("referenceUploads", new JSONArray().put(upload));
        return new JSONObject().put("tools", new JSONArray().put(tool))
            .put("referenceSources", new JSONObject().put("slot", Base64.encodeToString("new image".getBytes(StandardCharsets.UTF_8), Base64.NO_WRAP)));
    }

    private JSONObject tool(JSONObject handoff) throws Exception { return handoff.getJSONArray("tools").getJSONObject(0); }
}
