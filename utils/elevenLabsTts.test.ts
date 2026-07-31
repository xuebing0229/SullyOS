import { describe, expect, it } from 'vitest';
import { prepareElevenText } from './elevenLabsTts';

describe('prepareElevenText', () => {
  it('removes MiniMax break markers', () => {
    expect(prepareElevenText('你好 <#0.5#> 世界', 'eleven_v3')).toBe('你好 世界');
  });

  it('keeps v3 audio tags and does not duplicate emotion tags', () => {
    expect(prepareElevenText('[sighs] 好吧', 'eleven_v3', 'sad')).toBe('[sighs] 好吧');
    expect(prepareElevenText('好吧', 'eleven_v3', 'sad')).toBe('[sad] 好吧');
  });

  it('removes audio tags for v2 and Flash', () => {
    expect(prepareElevenText('[sighs] 好吧', 'eleven_multilingual_v2')).toBe('好吧');
    expect(prepareElevenText('[happily] hello', 'eleven_flash_v2_5')).toBe('hello');
  });

  it('removes unsafe tags', () => {
    expect(prepareElevenText('[https://evil.test] hello', 'eleven_v3')).toBe('hello');
  });
});