import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = (path: string) => readFileSync(resolve(__dirname, '..', path), 'utf8');

const expectOrdered = (text: string, needles: string[]) => {
  let cursor = -1;
  for (const needle of needles) {
    const next = text.indexOf(needle, cursor + 1);
    expect(next, `missing/out-of-order: ${needle}`).toBeGreaterThan(cursor);
    cursor = next;
  }
};

describe('Android story terminal status native routing', () => {
  it('UnifiedPush persists and forwards story status but suppresses ordinary AMSG notification', () => {
    const unified = source('native/android/AmsgUnifiedPushService.java');
    expectOrdered(unified, [
      'savePending(payload);',
      'boolean storyStatus = SullyStoryStatusPush.handle(this, payload);',
      'if (!storyStatus) showNotification(payload);',
      'JSObjectCompat.emitPush(payload);',
    ]);
  });

  it('native poll persists and acknowledges story status but suppresses ordinary AMSG notification', () => {
    const poll = source('native/android/SullyAmsgPollService.java');
    expectOrdered(poll, [
      'savePending(payload);',
      'boolean storyStatus = SullyStoryStatusPush.handle(this, payload);',
      'if (!storyStatus) showMessage(id, payload);',
      'ids.add(id);',
    ]);
    expect(poll).toContain('acknowledge(base, token, ids)');
  });

  it('routes only terminal story states to the cloud monitor with both task identifiers', () => {
    const router = source('native/android/SullyStoryStatusPush.java');
    expect(router).toContain('story-background-status');
    expect(router).toContain('amsgStoryBackgroundStatus');
    expect(router).toContain('payload.optString("storyJobId"');
    expect(router).toContain('payload.optString("storyClientRequestId"');
    expect(router).toContain('"succeeded".equals(status)');
    expect(router).toContain('"failed".equals(status)');
    expect(router).toContain('"cancelled".equals(status)');
    expect(router).toContain('SullyStoryCloudMonitorService.finish(');
    expectOrdered(router, ['jobId,', 'clientRequestId,', 'title,', 'status,']);
  });

  it('delivers ACTION_FINISH by same-app broadcast instead of background startService', () => {
    const monitor = source('native/android/SullyStoryCloudMonitorService.java');
    expect(monitor).toContain('new Intent(ACTION_FINISH)');
    expect(monitor).toContain('.setPackage(context.getPackageName())');
    expect(monitor).toContain('context.sendBroadcast(intent);');
    expect(monitor).toContain('ContextCompat.registerReceiver(');
    expect(monitor).toContain('ContextCompat.RECEIVER_NOT_EXPORTED');
    expect(monitor).not.toContain('context.startService(intent);');
  });

  it('rejects stale terminal states before reusing the existing finishTerminal path', () => {
    const monitor = source('native/android/SullyStoryCloudMonitorService.java');
    expect(monitor).toContain('matchesCurrentTask(targetJobId, targetClientRequestId)');
    expect(monitor).toContain('!targetJobId.equals(jobId)');
    expect(monitor).toContain('!targetClientRequestId.equals(clientRequestId)');
    expectOrdered(monitor, [
      'if (!isTerminalStatus(status)) return;',
      'if (!matchesCurrentTask(targetJobId, targetClientRequestId))',
      'finishTerminal(status, nextTitle, error);',
    ]);
    expect(monitor).toContain('clearPersistedMonitor();');
    expect(monitor).toContain('stopForeground(STOP_FOREGROUND_DETACH);');
    expect(monitor).toContain('stopSelf();');
  });

  it('installs the router into the regenerated Capacitor Android project', () => {
    const installer = source('scripts/install-android-story-background.mjs');
    const pkg = JSON.parse(source('package.json'));
    expect(installer).toContain("'SullyStoryStatusPush.java'");
    expect(pkg.scripts['capacitor:sync:after']).toContain('install-android-unified-push.mjs');
    expect(pkg.scripts['capacitor:sync:after']).toContain('install-android-amsg-poll.mjs');
    expect(pkg.scripts['capacitor:sync:after']).toContain('install-android-story-background.mjs');
  });
});
