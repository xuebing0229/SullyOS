import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(resolve(__dirname, '..', path), 'utf8');

describe('Story Theater background status notifications', () => {
  it('Worker reports running, succeeded and failed without coupling notification success to the story result', () => {
    const jobs = read('worker/amsg/src/storyJobs.ts');
    expect(jobs).toContain("storyStatusJob(liveRow), 'running'");
    expect(jobs).toContain("'succeeded',");
    expect(jobs).toContain("'failed',");
    expect(jobs).toContain('sendStoryBackgroundStatusPush');
  });

  it('all status updates share one deterministic notification identity', () => {
    const sender = read('worker/amsg/src/storyStatusPush.ts');
    expect(sender).toContain('storyBackgroundStatusMessageId(job.clientRequestId)');
    expect(sender).toContain('`story_${clientRequestId}`');
    expect(sender).toContain('tag: `story:${job.ownerKey}`');
    expect(sender).toContain("silent: status === 'running'");
    expect(sender).toContain("renotify: status !== 'running'");
  });

  it('Android cloud Story monitor is independent from active-message push subscriptions', () => {
    const client = read('utils/backgroundStoryJobs.ts');
    const native = read('utils/nativeStoryBackground.ts');
    const service = read('native/android/SullyStoryCloudMonitorService.java');
    const installer = read('scripts/install-android-story-background.mjs');
    expect(client).toContain('startNativeCloudStoryMonitor');
    expect(client).toContain('finishNativeCloudStoryMonitor');
    expect(native).toContain('LocalNotifications.requestPermissions()');
    expect(service).toContain('/story-jobs/');
    expect(service).toContain('startForeground');
    expect(installer).toContain('SullyStoryCloudMonitorService.java');
  });

  it('status pushes are consumed as non-chat results and poll fallback updates by messageId', () => {
    const results = read('utils/amsgResults.ts');
    const poll = read('native/android/SullyAmsgPollService.java');
    expect(results).toContain('case STORY_BACKGROUND_STATUS_RESULT_KIND:');
    expect(poll).toContain('payload.optString("messageId", "")');
    expect(poll).toContain('messageId.hashCode() & 0x7fffffff');
  });
});
