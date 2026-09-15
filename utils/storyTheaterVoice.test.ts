import { describe, expect, it } from 'vitest';
import {
    buildStoryVoiceSpeakerFormatReminder,
    parseStoryVoiceMarkup,
    parseStoryVoiceMessage,
    stripStoryVoiceMarkup,
} from './storyTheaterVoice';

describe('story theater speaker markup', () => {
    it('strips transport tags and keeps char/user ranges in clean text', () => {
        const raw = '他抬眼。[[STV:char]]“别动。”[[/STV]]\n[[STV:user]]“为什么？”[[/STV]]风从窗边吹过。';
        const parsed = parseStoryVoiceMarkup(raw);

        expect(parsed.cleanText).toBe('他抬眼。“别动。”\n“为什么？”风从窗边吹过。');
        expect(parsed.spans).toEqual([
            {
                speaker: 'char',
                start: '他抬眼。'.length,
                end: '他抬眼。“别动。”'.length,
                text: '“别动。”',
            },
            {
                speaker: 'user',
                start: '他抬眼。“别动。”\n'.length,
                end: '他抬眼。“别动。”\n“为什么？”'.length,
                text: '“为什么？”',
            },
        ]);
    });

    it('keeps identical dialogue occurrences separate by position', () => {
        const raw = '[[STV:char]]“好。”[[/STV]]\n[[STV:user]]“好。”[[/STV]]';
        const parsed = parseStoryVoiceMarkup(raw);

        expect(parsed.cleanText).toBe('“好。”\n“好。”');
        expect(parsed.spans).toHaveLength(2);
        expect(parsed.spans[0].speaker).toBe('char');
        expect(parsed.spans[1].speaker).toBe('user');
        expect(parsed.spans[0].start).not.toBe(parsed.spans[1].start);
    });

    it('maps NPC, char and user dialogue by ordinal even when text is identical', () => {
        const raw = '<story_text>NPC说“好。”\n[[STV:char]]“好。”[[/STV]]\n[[STV:user]]“好。”[[/STV]]</story_text><backstage>“这里不算正文对白”</backstage>';
        const parsed = parseStoryVoiceMessage(raw);

        expect(parsed.cleanText).toBe('<story_text>NPC说“好。”\n“好。”\n“好。”</story_text><backstage>“这里不算正文对白”</backstage>');
        expect(parsed.dialogueSpeakers).toEqual([null, 'char', 'user']);
    });

    it('removes unsupported or malformed STV markers without making them voiceable', () => {
        const raw = '[[STV:npc]]“欢迎。”[[/STV]] [[STV:char]]残缺标签';
        const parsed = parseStoryVoiceMarkup(raw);

        expect(parsed.cleanText).toBe('“欢迎。” 残缺标签');
        expect(parsed.spans).toEqual([]);
        expect(stripStoryVoiceMarkup(raw)).not.toContain('STV');
    });

    it('only emits the speaker protocol reminder when enabled', () => {
        expect(buildStoryVoiceSpeakerFormatReminder(false)).toBe('');
        const reminder = buildStoryVoiceSpeakerFormatReminder(true, '云', '我');
        expect(reminder).toContain('[[STV:char]]');
        expect(reminder).toContain('[[STV:user]]');
        expect(reminder).toContain('NPC');
        expect(reminder).toContain('云');
        expect(reminder).toContain('我');
    });
});
