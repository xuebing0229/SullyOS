import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  callMcpToolWithBackgroundImage,
  clearBackgroundImageJobs,
  exportBackgroundImageJobsForBackup,
  getBackgroundImageJobs,
  importBackgroundImageJobsFromBackup,
} from './backgroundImageJobs';
import type { McpServerConfig } from './mcpClient';

const server: McpServerConfig = {
  id: 'builtin_image_gpt-image',
  name: 'GPT 生图',
  url: 'https://example.test/gpt-image/mcp',
  controlBaseUrl: 'https://example.test/gpt-image',
  token: 'frozen-token',
  enabled: true,
  builtin: true,
  updatedAt: 1,
};

const queuedResponse = () => new Response(JSON.stringify({
  created: true,
  job: {
    id: 'remote-job-1',
    clientRequestId: 'ignored-by-client',
    toolName: 'generate_image',
    status: 'queued',
    createdAt: 1,
    updatedAt: 1,
  },
}), { status: 202, headers: { 'content-type': 'application/json' } });

describe('background image job backup', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('round-trips resumable jobs including frozen endpoint, token and client request id', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(queuedResponse());
    await callMcpToolWithBackgroundImage(
      server,
      'generate_image',
      { prompt: 'resume this image', after_generate_action: 'inspect' },
      { charId: 'char-1' },
    );

    const before = getBackgroundImageJobs()[0];
    const backup = exportBackgroundImageJobsForBackup();
    expect(backup.jobs).toHaveLength(1);
    expect(backup.jobs[0]).toMatchObject({
      clientRequestId: before.clientRequestId,
      remoteJobId: 'remote-job-1',
      token: 'frozen-token',
      controlBaseUrl: 'https://example.test/gpt-image',
      charId: 'char-1',
      toolArgs: { prompt: 'resume this image' },
      inspectStatus: 'pending',
    });

    clearBackgroundImageJobs();
    expect(importBackgroundImageJobsFromBackup(backup)).toBe(1);
    expect(getBackgroundImageJobs()[0]).toEqual(backup.jobs[0]);
  });

  it('only exports unfinished jobs and an empty backup clears stale jobs', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(queuedResponse());
    await callMcpToolWithBackgroundImage(server, 'generate_image', { prompt: 'stale' }, { charId: 'char-2' });
    const raw = JSON.parse(localStorage.getItem('aetheros.imageGeneration.backgroundJobs.v1') || '{}');
    raw.jobs.push({ ...raw.jobs[0], id: 'failed-local', clientRequestId: 'failed-client', status: 'failed' });
    localStorage.setItem('aetheros.imageGeneration.backgroundJobs.v1', JSON.stringify(raw));

    expect(exportBackgroundImageJobsForBackup().jobs).toHaveLength(1);
    expect(importBackgroundImageJobsFromBackup({ version: 1, exportedAt: Date.now(), jobs: [] })).toBe(0);
    expect(getBackgroundImageJobs()).toHaveLength(0);
  });
});
