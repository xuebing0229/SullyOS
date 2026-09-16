import { describe, expect, it } from 'vitest';
import {
    buildStoryVoiceSpeakerFormatReminder,
    extractStoryVoiceDialogues,
    parseStoryVoiceMarkup,
    parseStoryVoiceMessage,
    stripStoryVoiceMarkup,
} from './storyTheaterVoice';

describe('story theater speaker + acting markup', () => {
    it('strips transport tags and keeps char/user ranges in clean text', () => {
        const raw = '他抬眼。[[STV:char]]「别动。」[[/STV]]\n[[STV:user]]「为什么？」[[/STV]]风从窗边吹过。';
        const parsed = parseStoryVoiceMarkup(raw);

        expect(parsed.cleanText).toBe('他抬眼。「别动。」\n「为什么？」风从窗边吹过。');
        expect(parsed.spans).toEqual([
            {
                speaker: 'char',
                start: '他抬眼。'.length,
                end: '他抬眼。「别动。」'.length,
                text: '「别动。」',
                acting: null,
            },
            {
                speaker: 'user',
                start: '他抬眼。「别动。」\n'.length,
                end: '他抬眼。「别动。」\n「为什么？」'.length,
                text: '「为什么？」',
                acting: null,
            },
        ]);
    });

    it('keeps identical dialogue occurrences separate by position', () => {
        const raw = '[[STV:char]]「好。」[[/STV]]\n[[STV:user]]「好。」[[/STV]]';
        const parsed = parseStoryVoiceMarkup(raw);

        expect(parsed.cleanText).toBe('「好。」\n「好。」');
        expect(parsed.spans).toHaveLength(2);
        expect(parsed.spans[0].speaker).toBe('char');
        expect(parsed.spans[1].speaker).toBe('user');
        expect(parsed.spans[0].start).not.toBe(parsed.spans[1].start);
    });

    it('maps NPC, char and user dialogue by ordinal even when text is identical', () => {
        const raw = '<story_text>[[STV:npc]]「好。」[[/STV]]\n[[STV:char]]「好。」[[/STV]]\n[[STV:user]]「好。」[[/STV]]</story_text><backstage>「这里不算正文对白」</backstage>';
        const parsed = parseStoryVoiceMessage(raw);

        expect(parsed.cleanText).toBe('<story_text>「好。」\n「好。」\n「好。」</story_text><backstage>「这里不算正文对白」</backstage>');
        expect(parsed.dialogueSpeakers).toEqual([null, 'char', 'user']);
        expect(parsed.dialogueActing).toEqual([null, null, null]);
    });

    it('reuses the standard voice payload for hidden per-dialogue acting', () => {
        const raw = '<story_text>'
            + '[[STV:char]]<语音 emotion="sad">「我知道。<#0.5#>(sighs)只是……有点难受。」</语音>[[/STV]]\n'
            + '[[STV:user]]<语音 emotion="calm">「那就先走吧。」</语音>[[/STV]]'
            + '</story_text>';
        const parsed = parseStoryVoiceMessage(raw);

        expect(parsed.cleanText).toBe('<story_text>「我知道。只是……有点难受。」\n「那就先走吧。」</story_text>');
        expect(parsed.dialogueSpeakers).toEqual(['char', 'user']);
        expect(parsed.dialogueActing).toEqual([
            {
                speech: '「我知道。<#0.5#>(sighs)只是……有点难受。」',
                emotion: 'sad',
            },
            {
                speech: '「那就先走吧。」',
                emotion: 'calm',
            },
        ]);
    });

    it('removes unsupported or malformed STV markers without making them voiceable', () => {
        const raw = '[[STV:npc]]「欢迎。」[[/STV]] [[STV:char]]残缺标签';
        const parsed = parseStoryVoiceMarkup(raw);

        expect(parsed.cleanText).toBe('「欢迎。」 残缺标签');
        expect(parsed.spans).toEqual([
            {
                speaker: 'npc',
                start: 0,
                end: '「欢迎。」'.length,
                text: '「欢迎。」',
                acting: null,
            },
        ]);
        expect(stripStoryVoiceMarkup(raw)).not.toContain('STV');
    });

    it('accepts single-bracket compatibility markers without leaking them to visible text', () => {
        const raw = '<story_text>[STV:char]「先走。」[/STV]\n[STV:user]「等等我。」[/STV]</story_text>';
        const parsed = parseStoryVoiceMessage(raw);

        expect(parsed.cleanText).toBe('<story_text>「先走。」\n「等等我。」</story_text>');
        expect(parsed.dialogueSpeakers).toEqual(['char', 'user']);
        expect(extractStoryVoiceDialogues(parsed.cleanText)).toEqual(['「先走。」', '「等等我。」']);
    });

    it('injects the existing shared acting guide only when Story TTS is enabled', () => {
        expect(buildStoryVoiceSpeakerFormatReminder(false)).toBe('');
        const reminder = buildStoryVoiceSpeakerFormatReminder(true, '云', '我');
        expect(reminder).toContain('[[STV:char]]');
        expect(reminder).toContain('[[STV:user]]');
        expect(reminder).toContain('<语音 emotion="calm">');
        expect(reminder).toContain('让它听起来像活人在说话');
        expect(reminder).toContain('NPC');
        expect(reminder).toContain('云');
        expect(reminder).toContain('我');
    });
});
