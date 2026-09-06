import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  normalizeStoryImageHandoffSpec,
  prepareStoryImageHandoff,
  runStoryImageHandoff,
  type StoryCloudImageHandoffSpec,
} from './storyImageHandoff';

const planText = (args: Record<string, unknown>) =>
  `正文。\n<story_image_plan>\n${JSON.stringify({ tool: 'image_novelai', arguments: args })}\n</story_image_plan>`;

const spec = (
  policy: StoryCloudImageHandoffSpec['tools'][number]['referencePolicy'],
): StoryCloudImageHandoffSpec => ({
  version: 1,
  tools: [{
    exposedName: 'image_novelai',
    toolName: 'novelai_generate_image',
    engineId: 'novelai',
    controlBaseUrl: 'https://image.example.test',
    token: 'secret',
    referencePolicy: policy,
    references: {
      actors: {
        actor_a: {
          reference_id: 'managed_actor',
          reference_strength: 0.7,
          prompt: 'must-not-override-prompt',
        },
      },
      user: { user_reference_id: 'managed_user' },
      vibe: {
        vibe_reference_id: 'managed_vibe',
        vibe_reference_strength: 0.6,
      },
    },
  }],
});

afterEach(() => vi.restoreAllMocks());

describe('story image selected reference policy', () => {
  it('normalization drops precise fragments when the selected preset forbids Precise Reference', () => {
    const normalized = normalizeStoryImageHandoffSpec(spec({
      allowCharacterReference: false,
      allowUserReference: false,
      allowVibeReference: true,
    }));

    expect(normalized?.tools[0].referencePolicy).toEqual({
      allowCharacterReference: false,
      allowUserReference: false,
      allowVibeReference: true,
    });
    expect(normalized?.tools[0].references?.actors).toBeUndefined();
    expect(normalized?.tools[0].references?.user).toBeUndefined();
    expect(normalized?.tools[0].references?.vibe).toEqual({
      vibe_reference_id: 'managed_vibe',
      vibe_reference_strength: 0.6,
    });
  });

  it('planner-managed Precise fields cannot bypass the selected preset ban', () => {
    const result = prepareStoryImageHandoff(
      spec({
        allowCharacterReference: false,
        allowUserReference: false,
        allowVibeReference: true,
      }),
      'storyreq_policy',
      planText({
        prompt: 'keep this prompt',
        width: 1216,
        story_reference_actor_id: 'actor_a',
        use_character_reference: true,
        use_user_reference: true,
        use_vibe_reference: false,
        reference_id: 'planner_actor',
        reference_strength: 1,
        user_reference_id: 'planner_user',
      }),
    );

    expect(result.arguments).toEqual({
      prompt: 'keep this prompt',
      width: 1216,
    });
  });

  it('the real /jobs.arguments obey selected policy while preserving legal image parameters', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'not_found' }), { status: 404 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        job: { id: 'remote_policy', status: 'queued' },
      }), { status: 202, headers: { 'Content-Type': 'application/json' } }));

    const result = await runStoryImageHandoff(
      spec({
        allowCharacterReference: false,
        allowUserReference: false,
        allowVibeReference: false,
      }),
      'storyreq_posted_policy',
      planText({
        prompt: 'city rain',
        width: 1216,
        height: 832,
        steps: 28,
        story_reference_actor_id: 'actor_a',
        use_character_reference: true,
        use_user_reference: true,
        use_vibe_reference: true,
        reference_id: 'planner_actor',
        user_reference_id: 'planner_user',
        vibe_reference_id: 'planner_vibe',
      }),
    );

    expect(result).toMatchObject({
      state: 'submitted',
      remoteJobId: 'remote_policy',
      arguments: {
        prompt: 'city rain',
        width: 1216,
        height: 832,
        steps: 28,
      },
    });
    const submitInit = fetchMock.mock.calls[1][1] as RequestInit;
    const posted = JSON.parse(String(submitInit.body));
    expect(posted.arguments).toEqual({
      prompt: 'city rain',
      width: 1216,
      height: 832,
      steps: 28,
    });
  });

  it('Vibe still wins over Precise only when the selected policy allows Vibe', () => {
    const allowed = prepareStoryImageHandoff(
      spec({
        allowCharacterReference: true,
        allowUserReference: true,
        allowVibeReference: true,
      }),
      'storyreq_vibe_allowed',
      planText({
        prompt: 'night street',
        story_reference_actor_id: 'actor_a',
        use_character_reference: true,
        use_user_reference: true,
        use_vibe_reference: true,
      }),
    );
    expect(allowed.arguments).toEqual({
      prompt: 'night street',
      vibe_reference_id: 'managed_vibe',
      vibe_reference_strength: 0.6,
    });

    const denied = prepareStoryImageHandoff(
      spec({
        allowCharacterReference: true,
        allowUserReference: true,
        allowVibeReference: false,
      }),
      'storyreq_vibe_denied',
      planText({
        prompt: 'night street',
        story_reference_actor_id: 'actor_a',
        use_character_reference: true,
        use_user_reference: true,
        use_vibe_reference: true,
        vibe_reference_id: 'planner_vibe',
      }),
    );
    expect(denied.arguments).toEqual({
      prompt: 'night street',
      reference_id: 'managed_actor',
      reference_strength: 0.7,
      user_reference_id: 'managed_user',
    });
    expect(denied.arguments).not.toHaveProperty('vibe_reference_id');
    expect(denied.arguments).not.toHaveProperty('prompt', 'must-not-override-prompt');
  });
});
