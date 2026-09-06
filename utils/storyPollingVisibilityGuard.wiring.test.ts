import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const guardSource = readFileSync(
  new URL('./storyPollingVisibilityGuard.ts', import.meta.url),
  'utf8',
);
const entrySource = readFileSync(new URL('../index.tsx', import.meta.url), 'utf8');

describe('Android story polling lifecycle guard wiring', () => {
  it('is installed before the React app mounts', () => {
    expect(entrySource).toContain("import { installStoryPollingVisibilityGuard } from './utils/storyPollingVisibilityGuard';");
    const installAt = entrySource.indexOf('installStoryPollingVisibilityGuard();');
    const renderAt = entrySource.indexOf('root.render(');
    expect(installAt).toBeGreaterThan(-1);
    expect(renderAt).toBeGreaterThan(installAt);
  });

  it('only intercepts native Android story status GET requests', () => {
    expect(guardSource).toContain("Capacitor.getPlatform() === 'android'");
    expect(guardSource).toContain("requestMethod(input, init) !== 'GET'");
    expect(guardSource).toContain('story-jobs\\/(?:by-client\\/)?');
    expect(guardSource).toContain('return originalFetch(input, init);');
  });

  it('aborts an in-flight status GET when the app becomes hidden', () => {
    expect(guardSource).toContain("document.addEventListener('visibilitychange', refreshVisibilityState)");
    expect(guardSource).toContain("App.addListener('appStateChange'");
    expect(guardSource).toContain('attempt.suspended = true;');
    expect(guardSource).toContain('attempt.controller.abort();');
  });

  it('waits for foreground and immediately retries lifecycle-aborted GETs', () => {
    expect(guardSource).toContain('await waitUntilStoryPollingVisible();');
    expect(guardSource).toContain('for (;;)');
    expect(guardSource).toContain('if (!attempt.suspended) throw error;');
    expect(guardSource).toContain('if (!attempt.suspended && isStoryPollingVisible()) return response;');
  });
});
