import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./activeMsgClient', () => ({
  ActiveMsgClient: {
    getGlobalConfig: vi.fn(async () => ({
      workerUrl: 'https://worker.example',
      userId: '11111111-1111-4111-8111-111111111111',
      serverToken: 'test-token',
    })),
  },
}));

vi.mock('./nativeStoryBackground', () => ({
  finishNativeCloudStoryMonitor: vi.fn(async () => undefined),
  isNativeStoryBackgroundRuntime: vi.fn(() => false),
  startNativeCloudStoryMonitor: vi.fn(async () => undefined),
}));

vi.mock('./storyImageReferenceUploads', () => ({
  prepareStoryReferenceUploads: vi.fn(async (value: unknown) => value),
}));

vi.mock('./apiCallLog', () => ({
  cloudApiCallLogId: vi.fn((id: string) => `cloud:${id}`),
  recordCloudApiCall: vi.fn(),
  settleCloudApiCall: vi.fn(),
}));

import type { APIConfig, ApiPreset } from '../types';
import {
  API_FAILOVER_STORAGE_KEY,
  createDefaultApiFailoverGroup,
  loadApiFailoverGroups,
  resolveApiExecutionPlan,
  saveApiFailoverGroups,
} from './apiFailover';
import { executeStoryCompletionInCloudBackground } from './backgroundStoryJobs';

const API_PRESETS_STORAGE_KEY = 'os_api_presets';

const makeApi = (baseUrl: string, model: string): APIConfig => ({
  baseUrl,
  apiKey: `key:${baseUrl}`,
  model,
  stream: true,
  temperature: 0.8,
});

const presets: ApiPreset[] = [
  {
    id: 'preset-a',
    name: 'A',
    config: makeApi('https://a.example/v1', 'model-a'),
    models: [{ model: 'model-a' }],
  },
  {
    id: 'preset-b',
    name: 'B',
    config: makeApi('https://b.example/v1', 'model-b'),
    models: [{ model: 'model-b' }],
  },
];

const installLocalStorage = () => {
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, String(value)); },
    removeItem: (key: string) => { store.delete(key); },
    clear: () => { store.clear(); },
  });
  return store;
};

beforeEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  installLocalStorage();
  localStorage.setItem(API_PRESETS_STORAGE_KEY, JSON.stringify(presets));
});

describe('story route A -> B handoff', () => {
  it('persists B, resolves B, and submits B in the new cloud Story job spec', async () => {
    const storyA = {
      ...createDefaultApiFailoverGroup('story'),
      enabled: false,
      members: [{ presetId: 'preset-a', model: 'model-a', enabled: true }],
      updatedAt: 1,
    };
    saveApiFailoverGroups([storyA]);

    // Mirrors ApiFailoverSettings.replaceRoute(): the user explicitly selects preset B + model B,
    // then persist() writes the updated group through saveApiFailoverGroups().
    const switchedGroups = loadApiFailoverGroups().map(group =>
      group.scope === 'story'
        ? {
            ...group,
            members: group.members.map((member, index) =>
              index === 0
                ? {
                    ...member,
                    presetId: 'preset-b',
                    model: 'model-b',
                    enabled: true,
                  }
                : member,
            ),
            updatedAt: 2,
          }
        : group,
    );
    saveApiFailoverGroups(switchedGroups);

    const rawGroups = JSON.parse(localStorage.getItem(API_FAILOVER_STORAGE_KEY) || '[]');
    const storedStory = rawGroups.find((group: any) => group.scope === 'story');
    expect(storedStory.members[0]).toMatchObject({
      presetId: 'preset-b',
      model: 'model-b',
      enabled: true,
    });

    const fallbackA = makeApi('https://a.example/v1', 'model-a');
    const plan = resolveApiExecutionPlan('story', fallbackA, true);
    expect(plan.routes[0]).toMatchObject({
      presetId: 'preset-b',
      presetName: 'B',
      api: {
        baseUrl: 'https://b.example/v1',
        model: 'model-b',
      },
    });

    let submittedSpec: any = null;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === 'https://worker.example/story-jobs' && init?.method === 'POST') {
        submittedSpec = JSON.parse(String(init.body || '{}'));
        const job = {
          jobId: submittedSpec.jobId,
          clientRequestId: submittedSpec.clientRequestId,
          ownerKey: submittedSpec.ownerKey,
          title: submittedSpec.title,
          status: 'succeeded',
          attempts: [{ routeIndex: 0, ok: true }],
          response: {
            choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          },
          createdAt: Date.now(),
          updatedAt: Date.now(),
          completedAt: Date.now(),
        };
        return new Response(JSON.stringify({ job }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }));

    await executeStoryCompletionInCloudBackground({
      ownerKey: 'story-turn:test-entry:test-message',
      title: 'route handoff regression',
      plan,
      body: {
        model: 'model-a',
        messages: [{ role: 'user', content: 'continue' }],
        max_tokens: 32000,
        stream: true,
      },
    });

    expect(submittedSpec).not.toBeNull();
    expect(submittedSpec.routes).toHaveLength(1);
    expect(submittedSpec.routes[0]).toMatchObject({
      presetId: 'preset-b',
      presetName: 'B',
      baseUrl: 'https://b.example/v1',
      model: 'model-b',
    });
    expect(submittedSpec.routes[0].presetId).not.toBe('preset-a');
  });
});
