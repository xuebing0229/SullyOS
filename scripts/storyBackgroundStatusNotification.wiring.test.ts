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

  it('status pushes are consumed as non-chat results and poll fallback updates by messageId', () => {
    const results = read('utils/amsgResults.ts');
    const poll = read('native/android/SullyAmsgPollService.java');
    expect(results).toContain('case STORY_BACKGROUND_STATUS_RESULT_KIND:');
    expect(poll).toContain('payload.optString("messageId", "")');
    expect(poll).toContain('messageId.hashCode() & 0x7fffffff');
  });
});
