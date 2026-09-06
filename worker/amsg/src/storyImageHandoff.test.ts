import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  normalizeStoryImageHandoffSpec,
  prepareStoryImageHandoff,
  runStoryImageHandoff,
  type StoryCloudImageHandoffSpec,
} from './storyImageHandoff';

const planText = (tool: string, args: Record<string, unknown>) =>
  `正文。\n<story_image_plan>\n${JSON.stringify({ tool, arguments: args })}\n</story_image_plan>`;

const spec = (overrides: Partial<StoryCloudImageHandoffSpec['tools'][number]> = {}): StoryCloudImageHandoffSpec => ({
  version: 1,
  tools: [{
    exposedName: 'image_novelai',
    toolName: 'novelai_generate_image',
    engineId: 'novelai',
    controlBaseUrl: 'https://image.example.test',
    token: 'secret-image-token',
    ...overrides,
  }],
});

const plannerSpec = (): StoryCloudImageHandoffSpec => ({
  ...spec(),
  planner: {
    baseUrl: 'https://planner.example.test/v1',
    apiKey: 'planner-secret',
    model: 'gemini-compatible-planner',
    systemPrompt: '你负责剧情配图规划。',
    tools: [{
      type: 'function',
      function: {
        name: 'image_novelai',
        description: '剧情插图',
        parameters: {
          type: 'object',
          properties: { prompt: { type: 'string' } },
          required: ['prompt'],
        },
      },
    }],
  },
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('story cloud image handoff', () => {
  it('normalizes descriptors without dropping credentials needed for the encrypted job', () => {
    const normalized = normalizeStoryImageHandoffSpec(spec());
    expect(normalized?.tools[0].token).toBe('secret-image-token');
    expect(normalized?.tools[0].controlBaseUrl).toBe('https://image.example.test');
  });

  it('prepares a stable handoff without touching the image network', () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    const result = prepareStoryImageHandoff(
      spec(),
      'storyreq_fast',
      planText('image_novelai', { prompt: 'already finished text' }),
    );

    expect(result).toMatchObject({
      state: 'submitted',
      uncertain: true,
      exposedTool: 'image_novelai',
      toolName: 'novelai_generate_image',
      clientRequestId: 'storyimg_storyreq_fast',
      arguments: { prompt: 'already finished text' },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('skips automatic image handoff when the story completion omitted its inline plan', () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    const result = prepareStoryImageHandoff(
      spec(),
      'storyreq_no_plan',
      '只有正文，没有隐藏的配图控制块。',
    );

    expect(result).toEqual({ state: 'skipped' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reuses an existing remote image job and does not POST again', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify({
      job: { id: 'remote_existing', status: 'running' },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

    const result = await runStoryImageHandoff(
      spec(),
      'storyreq_abc',
      planText('image_novelai', { prompt: 'rainy station' }),
    );

    expect(result.state).toBe('submitted');
    expect(result.remoteJobId).toBe('remote_existing');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toContain('/jobs/by-client/storyimg_storyreq_abc');
  });

  it('maps NovelAI actor precise reference and strips client-only selectors before submit', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'job_not_found' }), { status: 404 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        job: { id: 'remote_new', status: 'queued' },
      }), { status: 202, headers: { 'Content-Type': 'application/json' } }));

    const result = await runStoryImageHandoff(
      spec({
        references: {
          actors: {
            actor_a: {
              reference_id: 'slot_actor_a',
              reference_strength: 0.7,
              reference_fidelity: 0.8,
            },
          },
          user: { user_reference_id: 'slot_user' },
        },
      }),
      'storyreq_ref',
      planText('image_novelai', {
        prompt: 'two people',
        story_reference_actor_id: 'actor_a',
        use_character_reference: true,
        use_user_reference: false,
        use_vibe_reference: false,
      }),
    );

    expect(result.state).toBe('submitted');
    expect(result.arguments).toMatchObject({
      prompt: 'two people',
      reference_id: 'slot_actor_a',
      reference_strength: 0.7,
      reference_fidelity: 0.8,
    });
    expect(result.arguments).not.toHaveProperty('story_reference_actor_id');
    expect(result.arguments).not.toHaveProperty('use_character_reference');
    const submitInit = fetchMock.mock.calls[1][1] as RequestInit;
    const posted = JSON.parse(String(submitInit.body));
    expect(posted.clientRequestId).toBe('storyimg_storyreq_ref');
    expect(posted.arguments.reference_id).toBe('slot_actor_a');
  });

  it('strips image client actions from /jobs arguments while preserving legal image parameters', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'job_not_found' }), { status: 404 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        job: { id: 'remote_action', status: 'queued' },
      }), { status: 202, headers: { 'Content-Type': 'application/json' } }));

    const result = await runStoryImageHandoff(
      spec(),
      'storyreq_action',
      planText('image_novelai', {
        prompt: 'city rain',
        width: 1216,
        height: 832,
        steps: 28,
        after_generate_action: 'inspect',
        afterGenerateAction: 'none',
      }),
    );

    expect(result).toMatchObject({
      state: 'submitted',
      remoteJobId: 'remote_action',
      afterGenerateAction: 'inspect',
      arguments: {
        prompt: 'city rain',
        width: 1216,
        height: 832,
        steps: 28,
      },
    });
    expect(result.arguments).not.toHaveProperty('after_generate_action');
    expect(result.arguments).not.toHaveProperty('afterGenerateAction');

    const submitInit = fetchMock.mock.calls[1][1] as RequestInit;
    const posted = JSON.parse(String(submitInit.body));
    expect(posted.arguments).toEqual({
      prompt: 'city rain',
      width: 1216,
      height: 832,
      steps: 28,
    });
    expect(posted.arguments).not.toHaveProperty('after_generate_action');
    expect(posted.arguments).not.toHaveProperty('afterGenerateAction');
  });

  it('lets an active Vibe fragment win over precise references', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'job_not_found' }), { status: 404 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ job: { id: 'remote_vibe', status: 'queued' } }), { status: 202 }));

    const result = await runStoryImageHandoff(
      spec({
        references: {
          actors: { actor_a: { reference_id: 'precise' } },
          vibe: {
            vibe_reference_id: 'vibe_slot',
            vibe_reference_strength: 0.6,
            vibe_reference_information_extracted: 0.9,
          },
        },
      }),
      'storyreq_vibe',
      planText('image_novelai', {
        prompt: 'night street',
        story_reference_actor_id: 'actor_a',
        use_character_reference: true,
        use_vibe_reference: true,
      }),
    );

    expect(result.arguments).toMatchObject({ vibe_reference_id: 'vibe_slot' });
    expect(result.arguments).not.toHaveProperty('reference_id');
  });

  it('treats a lost POST response as submitted-uncertain so the phone can recover by the same id', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'job_not_found' }), { status: 404 }))
      .mockRejectedValueOnce(new TypeError('network lost'));

    const result = await runStoryImageHandoff(
      spec(),
      'storyreq_uncertain',
      planText('image_novelai', { prompt: 'portrait' }),
    );

    expect(result).toMatchObject({
      state: 'submitted',
      uncertain: true,
      clientRequestId: 'storyimg_storyreq_uncertain',
    });
  });

  it('does not leak service token or preset api key into the public handoff result', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'job_not_found' }), { status: 404 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ config: { revision: 4 } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ job: { id: 'remote_safe', status: 'queued' } }), { status: 202 }));

    const result = await runStoryImageHandoff(
      spec({ preset: { remoteConfig: { model: 'nai-model' }, apiKey: 'super-secret-api-key' } }),
      'storyreq_safe',
      planText('image_novelai', { prompt: 'safe' }),
    );

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('secret-image-token');
    expect(serialized).not.toContain('super-secret-api-key');
  });

  it('reuses the shared text-faked tool parser for worker planner responses', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{ message: { content: 'image_novelai({"prompt":"rainy platform"})' } }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        job: { id: 'remote_text_plan', status: 'running' },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

    const result = await runStoryImageHandoff(
      plannerSpec(),
      'storyreq_text_plan',
      '雨夜站台上，两个人隔着人群对望。',
    );

    expect(result).toMatchObject({
      state: 'submitted',
      remoteJobId: 'remote_text_plan',
      exposedTool: 'image_novelai',
      arguments: { prompt: 'rainy platform' },
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('keeps native tools on the second attempt when the first native planner response omits a call', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{ message: { content: '我来画这一幕。' } }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{ message: {
          tool_calls: [{
            id: '',
            type: 'function',
            function: { name: 'image_novelai', arguments: '{"prompt":"native repair"}' },
          }],
        } }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        job: { id: 'remote_native_repair', status: 'running' },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

    const result = await runStoryImageHandoff(
      plannerSpec(),
      'storyreq_native_repair',
      '最新正文。',
    );

    expect(result).toMatchObject({
      state: 'submitted',
      remoteJobId: 'remote_native_repair',
      arguments: { prompt: 'native repair' },
    });
    const retryBody = JSON.parse(String((fetchMock.mock.calls[1][1] as RequestInit).body));
    expect(retryBody.tools).toHaveLength(1);
    expect(retryBody.tool_choice).toEqual({ type: 'function', function: { name: 'image_novelai' } });
  });

  it('falls back to the shared text-call format only when the upstream rejects native tools', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: { message: 'tools is not supported' },
      }), { status: 400, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{ message: { content: 'novelai_generate_image({"prompt":"text fallback"})' } }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        job: { id: 'remote_text_fallback', status: 'running' },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

    const result = await runStoryImageHandoff(
      plannerSpec(),
      'storyreq_text_fallback',
      '最新正文。',
    );

    expect(result).toMatchObject({
      state: 'submitted',
      remoteJobId: 'remote_text_fallback',
      exposedTool: 'image_novelai',
      arguments: { prompt: 'text fallback' },
    });
    const fallbackBody = JSON.parse(String((fetchMock.mock.calls[1][1] as RequestInit).body));
    expect(fallbackBody.tools).toBeUndefined();
  });

  it('does not hide auth failures behind a second planner attempt', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify({
      error: { message: 'Invalid token' },
    }), { status: 401, headers: { 'Content-Type': 'application/json' } }));

    const result = await runStoryImageHandoff(
      plannerSpec(),
      'storyreq_auth_fail',
      '最新正文。',
    );

    expect(result.state).toBe('failed');
    expect(result.error).toContain('配图规划器请求失败：Invalid token');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});