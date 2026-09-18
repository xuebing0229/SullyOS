import { describe, expect, it } from 'vitest';
import { createStoryTheaterDraft, normalizeStoryTheater } from './storyTheater';

describe('story theater voice settings', () => {
  it('creates new stories with voice opt-in disabled and MiniMax selected', () => {
    const draft = createStoryTheaterDraft(123);
    expect(draft.storyTtsEnabled).toBe(false);
    expect(draft.storyTtsProvider).toBe('minimax');
  });

  it('keeps legacy stories voice-off and preserves explicit opt-in', () => {
    const base = createStoryTheaterDraft(123);
    const legacy = { ...base } as any;
    delete legacy.storyTtsEnabled;
    delete legacy.storyTtsProvider;
    expect(normalizeStoryTheater(legacy).storyTtsEnabled).toBe(false);
    expect(normalizeStoryTheater(legacy).storyTtsProvider).toBe('minimax');
    const enabled = normalizeStoryTheater({
      ...base,
      storyTtsEnabled: true,
      storyTtsProvider: 'minimax',
      storyVoiceDirectorApiPresetId: 'cheap-fast',
      storyVoiceDirectorModel: 'flash-mini',
    });
    expect(enabled.storyTtsEnabled).toBe(true);
    expect(enabled.storyTtsProvider).toBe('minimax');
    expect(enabled.storyVoiceDirectorApiPresetId).toBe('cheap-fast');
    expect(enabled.storyVoiceDirectorModel).toBe('flash-mini');
  });
});
