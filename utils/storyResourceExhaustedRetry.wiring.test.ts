import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const storyJobsSource = readFileSync(
  fileURLToPath(new URL('../worker/amsg/src/storyJobs.ts', import.meta.url)),
  'utf8',
);

describe('story cloud resource-exhaustion compatibility retry', () => {
  it('retries only rejected oversized story requests on the same route with an 8k output budget', () => {
    expect(storyJobsSource).toContain('const RESOURCE_EXHAUSTED_MAX_TOKENS_RETRY = 8_000;');
    expect(storyJobsSource).toContain('if (response.status === 429)');
    expect(storyJobsSource).toContain("lower.includes('resource has been exhausted')");
    expect(storyJobsSource).toContain("lower.includes('resource_exhausted')");
    expect(storyJobsSource).toContain('originalMaxTokens > RESOURCE_EXHAUSTED_MAX_TOKENS_RETRY');
    expect(storyJobsSource).toContain('resourceRetryFromMaxTokens = originalMaxTokens;');
    expect(storyJobsSource).toContain('routeRequest.stopCancelWatch();\n          resourceRetryFromMaxTokens = originalMaxTokens;');
    expect(storyJobsSource).toContain('routeRequest = await requestRoute(\n            includeUsage,\n            RESOURCE_EXHAUSTED_MAX_TOKENS_RETRY,');
    expect(storyJobsSource).toContain('let includeUsage = true;');
  });
});
