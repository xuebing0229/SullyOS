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

  it('reuses shared API normalizers for invisible edges in encrypted handoff credentials', () => {
    const dirty = plannerSpec();
    dirty.tools[0] = {
      ...dirty.tools[0],
      controlBaseUrl: '\u200B https://image.example.test/ \uFEFF',
      token: '\uFEFF secret-image-token \u200B',
      preset: {
        remoteConfig: { model: 'nai-model' },
        apiKey: '\u200B nai-api-key \uFEFF',
      },
    };
    dirty.planner = {
      ...dirty.planner!,
      baseUrl: '\uFEFF https://planner.example.test/v1/ \u200B',
      apiKey: '\u200B planner-secret \uFEFF',
      model: '\uFEFF gemini-compatible-planner \u200B',
    };

    const normalized = normalizeStoryImageHandoffSpec(dirty);
    expect(normalized?.tools[0].controlBaseUrl).toBe('https://image.example.test');
    expect(normalized?.tools[0].token).toBe('secret-image-token');
    expect(normalized?.tools[0].preset?.apiKey).toBe('nai-api-key');
    expect(normalized?.planner?.baseUrl).toBe('https://planner.example.test/v1');
    expect(normalized?.planner?.apiKey).toBe('planner-secret');
    expect(normalized?.planner?.model).toBe('gemini-compatible-planner');
  });

  it('does not truncate the full Story Theater preset carried in planner context', () => {
    const longPreset = 'preset-body-'.repeat(8_000);
    const value = plannerSpec();
    value.planner = {
      ...value.planner!,
      systemPrompt: `planner-instruction\n【当前文游正文完整预设】\n${longPreset}`,
    };

    const normalized = normalizeStoryImageHandoffSpec(value);
    expect(normalized?.planner?.systemPrompt).toContain(longPreset);
    expect(normalized?.planner?.systemPrompt.length).toBe(value.planner.systemPrompt.length);
  });

  it('normalizes planner authorization again at request time for older encrypted jobs', async () => {
    const dirty = plannerSpec();
    dirty.planner = {
      ...dirty.planner!,
      apiKey: '\uFEFF planner-secret \u200B',
    };
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{ message: { content: 'image_novelai({"prompt":"clean auth"})' } }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        job: { id: 'remote_clean_auth', status: 'running' },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

    const result = await runStoryImageHandoff(dirty, 'storyreq_clean_auth', '最新正文。');

    expect(result).toMatchObject({ state: 'submitted', remoteJobId: 'remote_clean_auth' });
    const plannerHeaders = new Headers((fetchMock.mock.calls[0][1] as RequestInit).headers);
    expect(plannerHeaders.get('Authorization')).toBe('Bearer planner-secret');
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

  it('hard-merges fixed Story Theater prompt layers only for visible subjects', () => {
    const layered = spec({
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string' },
          negative_prompt: { type: 'string' },
        },
      },
    });
    layered.promptLayers = {
      character: 'black hair, green eyes only',
      user: 'silver hair, heterochromia',
      style: 'cinematic anime',
      negative: 'bad anatomy',
    };

    const result = prepareStoryImageHandoff(
      layered,
      'storyreq_layers',
      planText('image_novelai', {
        prompt: 'narrow prison cell, medium shot, tense confrontation',
        negative_prompt: 'text',
        story_include_character: true,
        story_include_user: false,
        story_character_dynamic_prompt: 'standing by the door, looking back',
        story_user_dynamic_prompt: '',
      }),
    );

    expect(result).toMatchObject({
      state: 'submitted',
      arguments: {
        prompt: 'narrow prison cell, medium shot, tense confrontation, black hair, green eyes only, standing by the door, looking back, cinematic anime',
        negative_prompt: 'text, bad anatomy',
      },
    });
    expect(result.arguments?.prompt).not.toContain('silver hair, heterochromia');
    expect(result.arguments).not.toHaveProperty('story_include_character');
  });

  it('keeps role and user in native NovelAI character prompts when both are visible', () => {
    const layered = spec({
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string' },
          character_prompts: { type: 'array', items: { type: 'string' } },
        },
      },
    });
    layered.promptLayers = {
      character: 'black hair, green eyes only',
      user: 'silver hair, heterochromia',
      style: 'cinematic anime',
    };

    const result = prepareStoryImageHandoff(
      layered,
      'storyreq_two_people',
      planText('image_novelai', {
        prompt: 'narrow cell, two people facing each other, medium shot',
        story_include_character: true,
        story_include_user: true,
        story_character_dynamic_prompt: 'left side, gripping the door',
        story_user_dynamic_prompt: 'right side, leaning closer',
        character_prompts: ['planner supplied wrong identity'],
        use_character_reference: true,
        use_user_reference: true,
        use_vibe_reference: false,
      }),
    );

    expect(result.state).toBe('submitted');
    expect(result.arguments?.prompt).toBe(
      'narrow cell, two people facing each other, medium shot, cinematic anime, '
      + 'exactly two people, two distinct people, single scene',
    );
    expect(result.arguments?.character_prompts).toEqual([
      'black hair, green eyes only, left side, gripping the door',
      'silver hair, heterochromia, right side, leaning closer',
    ]);
    expect(result.arguments?.prompt).not.toContain(' | ');
    // Native multi-character prompts intentionally disable generation-wide Precise Reference.
    expect(result.arguments).not.toHaveProperty('reference_id');
    expect(result.arguments).not.toHaveProperty('user_reference_id');
  });

  it('uses a non-pipe compatibility prompt when the deployed NovelAI MCP schema is still old', () => {
    const layered = spec({
      parameters: {
        type: 'object',
        properties: { prompt: { type: 'string' } },
      },
    });
    layered.promptLayers = {
      character: 'black hair, green eyes only',
      user: 'silver hair, heterochromia',
      style: 'cinematic anime',
    };

    const result = prepareStoryImageHandoff(
      layered,
      'storyreq_old_mcp',
      planText('image_novelai', {
        prompt: 'narrow cell, medium shot',
        story_include_character: true,
        story_include_user: true,
        story_character_dynamic_prompt: 'left side',
        story_user_dynamic_prompt: 'right side',
        use_character_reference: true,
        use_user_reference: true,
        use_vibe_reference: false,
      }),
    );

    expect(result.state).toBe('submitted');
    expect(result.arguments).not.toHaveProperty('character_prompts');
    expect(result.arguments?.prompt).toContain('first person: black hair, green eyes only, left side');
    expect(result.arguments?.prompt).toContain('second person: silver hair, heterochromia, right side');
    expect(result.arguments?.prompt).not.toContain(' | ');
    expect(result.arguments).not.toHaveProperty('reference_id');
    expect(result.arguments).not.toHaveProperty('user_reference_id');
  });

  it('fails before image submission when a new planner result lost the scene prompt', () => {
    const layered = spec({
      parameters: {
        type: 'object',
        properties: { prompt: { type: 'string' } },
      },
    });
    layered.promptLayers = { character: 'black hair, green eyes only' };

    const result = prepareStoryImageHandoff(
      layered,
      'storyreq_missing_scene',
      planText('image_novelai', {
        prompt: '',
        story_include_character: true,
        story_include_user: false,
        story_character_dynamic_prompt: 'looking back',
        story_user_dynamic_prompt: '',
      }),
    );

    expect(result.state).toBe('failed');
    expect(result.error).toContain('没有返回场景/动作 prompt');
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

  it('switches the second attempt to text compatibility when a successful native response omits a call', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{ message: { content: '我来画这一幕。' } }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{ message: { content: 'image_novelai({"prompt":"text repair"})' } }],
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
      arguments: { prompt: 'text repair' },
    });
    const retryBody = JSON.parse(String((fetchMock.mock.calls[1][1] as RequestInit).body));
    expect(retryBody.tools).toBeUndefined();
    expect(retryBody.tool_choice).toBeUndefined();
    expect(JSON.stringify(retryBody.messages)).toContain('tool_name({JSON})');
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

  it('strips duplicated legacy history and fixed negative prompt before cloud planning', async () => {
    const legacy = plannerSpec();
    legacy.planner = {
      ...legacy.planner!,
      systemPrompt: [
        '你负责剧情配图规划。',
        '',
        '最近剧情：',
        '旧历史一：这里不该再次送进云端规划器。',
        '',
        '画面要求：只画最新一轮。',
        '固定画风（客户端自动合并，禁止复述进 prompt）：cinematic anime',
        '固定负面词（客户端自动合并，禁止复述进 prompt）：bad anatomy, text',
      ].join('\n'),
    };

    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{ message: { content: 'image_novelai({"prompt":"fresh scene"})' } }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        job: { id: 'remote_sanitized_context', status: 'running' },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

    const result = await runStoryImageHandoff(
      legacy,
      'storyreq_sanitized_context',
      '最新正文唯一依据。',
    );

    expect(result.state).toBe('submitted');
    const plannerBody = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body));
    const serializedMessages = JSON.stringify(plannerBody.messages);
    expect(serializedMessages).toContain('最新正文唯一依据');
    expect(serializedMessages).toContain('cinematic anime');
    expect(serializedMessages).not.toContain('旧历史一：这里不该再次送进云端规划器');
    expect(serializedMessages).not.toContain('bad anatomy, text');
  });

  it('does not retry text compatibility after a planner input safety rejection', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify({
      error: { code: 1026, message: 'input new_sensitive (1026)' },
    }), { status: 400, headers: { 'Content-Type': 'application/json' } }));

    const result = await runStoryImageHandoff(
      plannerSpec(),
      'storyreq_sensitive',
      '最新正文。',
    );

    expect(result.state).toBe('failed');
    expect(result.error).toContain('配图规划器输入被上游内容审核拦截');
    expect(result.error).toContain('input new_sensitive (1026)');
    expect(fetchMock).toHaveBeenCalledTimes(1);
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
