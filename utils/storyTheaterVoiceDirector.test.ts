import { describe, expect, it } from 'vitest';
import { mergeStoryVoiceDirectorResponse } from './storyTheaterVoiceDirector';

describe('story voice acting director', () => {
  it('fills only missing emotion and keeps dialogue wording unchanged', () => {
    const dialogues = ['「我没事。只是有点累。」', '「走吧。」'];
    const result = mergeStoryVoiceDirectorResponse(
      JSON.stringify({
        items: [
          { index: 0, emotion: 'sad', speech: '「我没事。<#0.6#>(sighs)只是有点累。」' },
          { index: 1, emotion: 'angry', speech: '「给我滚。」' },
        ],
      }),
      dialogues,
      ['user', 'char'],
      [null, { speech: '「走吧。」', emotion: 'calm' }],
    );

    expect(result[0]).toEqual({
      speech: '「我没事。<#0.6#>(sighs)只是有点累。」',
      emotion: 'sad',
    });
    expect(result[1]).toEqual({ speech: '「走吧。」', emotion: 'calm' });
  });

  it('falls back to original words if the director tries to rewrite dialogue', () => {
    const result = mergeStoryVoiceDirectorResponse(
      '{"items":[{"index":0,"emotion":"fearful","speech":"「完全改写了。」"}]}',
      ['「等等。」'],
      ['user'],
      [null],
    );
    expect(result[0]).toEqual({ speech: '「等等。」', emotion: 'fearful' });
  });
});
