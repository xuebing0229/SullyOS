import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

describe('worker-owned Story Theater image submission', () => {
  it('never restores a timed client fallback for cloud story handoffs', () => {
    const source = readFileSync(
      fileURLToPath(new URL('./backgroundImageJobs.ts', import.meta.url)),
      'utf8',
    );

    expect(source).toContain('workerOwnsSubmission');
    expect(source).toContain('手机永远只查账');
    expect(source).toContain("storyHandoff?.state === 'failed'");
    expect(source).not.toContain('CLOUD_STORY_INITIAL_SUBMIT_GRACE_MS');
    expect(source).not.toContain('submitNotBefore');
  });
});
