import { describe, expect, it } from 'vitest';
import { STORY_ELEVENLABS_V4_ACTING_GUIDE, normalizeStoryElevenLabsAudioTags } from './storyElevenLabsActing';

describe('story ElevenLabs V4 performance prompt', () => {
    it('keeps the STV story framing, all intensity levels and the non-rewrite rules', () => {
        expect(STORY_ELEVENLABS_V4_ACTING_GUIDE).toContain('STV');
        expect(STORY_ELEVENLABS_V4_ACTING_GUIDE).toContain('L1 日常');
        expect(STORY_ELEVENLABS_V4_ACTING_GUIDE).toContain('L2 动情');
        expect(STORY_ELEVENLABS_V4_ACTING_GUIDE).toContain('L3 激烈');
        expect(STORY_ELEVENLABS_V4_ACTING_GUIDE).toContain('不得为了演绎');
        expect(STORY_ELEVENLABS_V4_ACTING_GUIDE).toContain('[breathless raspy voice]');
        expect(STORY_ELEVENLABS_V4_ACTING_GUIDE).toContain('角色直接想到的话');
    });

    it('corrects ambiguous and punctuated tags while preserving every spoken character', () => {
        expect(normalizeStoryElevenLabsAudioTags('「[breathless rasp]你好吗？」'))
            .toBe('「[breathless raspy voice]你好吗？」');
        expect(normalizeStoryElevenLabsAudioTags('「[breathless, raspy voice]你好吗？」'))
            .toBe('「[breathless raspy voice]你好吗？」');
        expect(normalizeStoryElevenLabsAudioTags('「[spank — 用尽全力,声音响亮]等等……」'))
            .toBe('「[spank]等等……」');
        expect(normalizeStoryElevenLabsAudioTags('「[wet kiss, pulling apart]……好。」'))
            .toBe('「[wet kiss pulling apart]……好。」');
        expect(normalizeStoryElevenLabsAudioTags('「[急促喘息]什么？」'))
            .toBe('「什么？」');
    });

    it('never changes non-tag text or strips pauses and normal audio cues', () => {
        const original = '「萝卜……你——别走！[short pause][voice trembling]可以吗？」';
        expect(normalizeStoryElevenLabsAudioTags(original)).toBe(original);
    });
});
