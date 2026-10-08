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

    it('preserves ElevenLabs v4 Audio Tags in hidden acting data while keeping them out of visible story text', () => {
        const raw = '<story_text>'
            + '[[STV:char]]<语音 emotion="sad">「我知道。[pause][sighs]只是……有点难受。」</语音>[[/STV]]'
            + '</story_text>';
        const parsed = parseStoryVoiceMessage(raw, 'elevenlabs');

        expect(parsed.cleanText).toBe('<story_text>「我知道。只是……有点难受。」</story_text>');
        expect(parsed.dialogueSpeakers).toEqual(['char']);
        expect(parsed.dialogueActing).toEqual([{
            speech: '「我知道。[pause][sighs]只是……有点难受。」',
            emotion: 'sad',
        }]);
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

    it('recovers untagged quoted dialogue in a realistic breakfast scene for either TTS provider', () => {
        const raw = '<story_text>祁连云端着两碗粥走到餐桌边，把其中一碗放在温鸣竹面前。\n'
            + '"趁热喝。"他在温鸣竹对面坐下，拿起筷子夹了一块虾仁放进自己嘴里，"我待会儿九点要去学生会那边。你今天有什么安排?"\n'
            + '"没安排。"温鸣竹低头喝了一口粥，"我就打算在宿舍躺一天。"\n'
            + '"那你记得中午吃饭。"祁连云夹起一筷子榨菜丝，"冰箱里还有昨天剩的红烧肉，你热一下就能吃。"</story_text>';
        const expected = [
            '「趁热喝。」', '「我待会儿九点要去学生会那边。你今天有什么安排?」',
            '「没安排。」', '「我就打算在宿舍躺一天。」',
            '「那你记得中午吃饭。」', '「冰箱里还有昨天剩的红烧肉，你热一下就能吃。」',
        ];
        for (const provider of ['minimax', 'elevenlabs'] as const) {
            const parsed = parseStoryVoiceMessage(raw, provider);
            expect(extractStoryVoiceDialogues(parsed.cleanText)).toEqual(expected);
            expect(parsed.dialogueSpeakers).toEqual(Array(6).fill(null));
            expect(parsed.dialogueActing).toEqual(Array(6).fill(null));
            expect(parsed.cleanText).toContain('「趁热喝。」他在温鸣竹对面坐下');
        }
    });

    it('preserves quoted titles, citations and backstage text without inventing spoken dialogue', () => {
        const raw = '<story_text>标题叫“再见！”这句话出现在文章里。\n'
            + '他把“回来！”这几个字写在纸上。\n'
            + '“生命的意义？”这句话是文章的标题。\n'
            + '所谓“再走一步。”的说法常见。\n'
            + '他说：“确实如此。”</story_text><backstage>“这里不是对白！”</backstage>';
        const parsed = parseStoryVoiceMessage(raw, 'elevenlabs');
        expect(parsed.cleanText).toContain('标题叫“再见！”这句话出现在文章里。');
        expect(parsed.cleanText).toContain('“生命的意义？”这句话是文章的标题。');
        expect(parsed.cleanText).toContain('<backstage>“这里不是对白！”</backstage>');
        expect(extractStoryVoiceDialogues(parsed.cleanText)).toEqual(['「确实如此。」']);
        expect(parsed.dialogueSpeakers).toEqual([null]);
    });

    it('keeps marked ElevenLabs acting and recovered speech aligned by ordinal', () => {
        const raw = '<story_text>[[STV:char]]<语音 emotion="sad">「等等。[pause]」</语音>[[/STV]]\n'
            + '“好。”他低头点了点头。</story_text>';
        const parsed = parseStoryVoiceMessage(raw, 'elevenlabs');
        expect(parsed.cleanText).toBe('<story_text>「等等。」\n「好。」他低头点了点头。</story_text>');
        expect(parsed.dialogueSpeakers).toEqual(['char', null]);
        expect(parsed.dialogueActing).toEqual([
            { speech: '「等等。[pause]」', emotion: 'sad' },
            null,
        ]);
    });

    it('indexes spoken dialogue and direct thoughts in reading order with their own actors', () => {
        const source = '<story_text>他想：[[STV:char]]<语音 emotion="sad">*我做错了吗？*</语音>[[/STV]]\n'
            + '他抬头。[[STV:user]]<语音 emotion="calm">「你没事吧？」</语音>[[/STV]]\n'
            + '[[STV:char]]<语音 emotion="happy">*终于有人问了。*</语音>[[/STV]]</story_text>';
        for (const provider of ['minimax', 'elevenlabs'] as const) {
            const parsed = parseStoryVoiceMessage(source, provider);
            expect(parsed.cleanText).toContain('*我做错了吗？*');
            expect(parsed.segmentKinds).toEqual(['psychology', 'dialogue', 'psychology']);
            expect(parsed.dialogueSpeakers).toEqual(['char', 'user', 'char']);
            expect(parsed.dialogueActing.map(a => a?.speech)).toEqual(['我做错了吗？', '「你没事吧？」', '终于有人问了。']);
            expect(extractStoryVoiceDialogues(parsed.cleanText)).toEqual(['*我做错了吗？*', '「你没事吧？」', '*终于有人问了。*']);
        }
    });

    it('keeps v4 audio tags hidden while removing thought delimiters from speech', () => {
        const raw = '<story_text>[[STV:char]]<语音 emotion="sad">*[whispers]为什么会这样？*</语音>[[/STV]]</story_text>';
        const parsed = parseStoryVoiceMessage(raw, 'elevenlabs');
        expect(parsed.cleanText).toBe('<story_text>*为什么会这样？*</story_text>');
        expect(parsed.dialogueActing).toEqual([{ speech: '[whispers]为什么会这样？', emotion: 'sad' }]);
        expect(parsed.segmentKinds).toEqual(['psychology']);
    });

    it('does not read narration, quoted titles or backstage as an inner voice', () => {
        const raw = '<story_text>他心里想着明天的安排。\n'
            + '他看着“希望！”这两个字。\n'
            + '*等会儿再说。*他依旧沉默。</story_text><backstage>*这里不是剧情正文*</backstage>';
        const parsed = parseStoryVoiceMessage(raw, 'minimax');
        expect(parsed.segmentKinds).toEqual(['psychology']);
        expect(parsed.dialogueSpeakers).toEqual([null]);
        expect(extractStoryVoiceDialogues(parsed.cleanText)).toEqual(['*等会儿再说。*']);
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

    it('uses the dedicated ElevenLabs drama direction while leaving MiniMax untouched', () => {
        const eleven = buildStoryVoiceSpeakerFormatReminder(true, '温鸣竹', '祁连云', 'elevenlabs', 'eleven_v4');
        expect(eleven).toContain('女性向情境音声');
        expect(eleven).toContain('L1 日常');
        expect(eleven).toContain('L2 动情');
        expect(eleven).toContain('L3 激烈');
        expect(eleven).toContain('[breathless raspy voice]');
        expect(eleven).toContain('[wet squelch]');
        expect(eleven).toContain('不新增情节');
        expect(eleven).toContain('*……*');
        expect(eleven).toContain('[[STV:char]]');
        expect(eleven).not.toContain('只输出严格 JSON');
        const mini = buildStoryVoiceSpeakerFormatReminder(true, '温鸣竹', '祁连云', 'minimax');
        expect(mini).not.toContain('女性向情境音声');
        expect(mini).toContain('让它听起来像活人在说话');
    });

    it('normalizes ambiguous ElevenLabs tags without changing visible story', () => {
        const raw = '<story_text>[[STV:char]]<语音 emotion="sad">「[breathless rasp]你听我说……[spank — 用尽全力,很响]别走。」</语音>[[/STV]]</story_text>';
        const parsed = parseStoryVoiceMessage(raw, 'elevenlabs');
        expect(parsed.cleanText).toContain('「你听我说……别走。」');
        expect(parsed.dialogueActing[0]?.speech).toBe('「[breathless raspy voice]你听我说……[spank]别走。」');
        expect(parsed.dialogueSpeakers).toEqual(['char']);
    });

    it('switches Story acting instructions to ElevenLabs v4 Audio Tags', () => {
        const reminder = buildStoryVoiceSpeakerFormatReminder(true, '云', '我', 'elevenlabs', 'eleven_v4');
        expect(reminder).toContain('ElevenLabs v4');
        expect(reminder).toContain('[soft sigh]');
        expect(reminder).toContain('[short pause]');
        expect(reminder).toContain('不要使用 <#秒数#>');
        expect(reminder).not.toContain('让它听起来像活人在说话');
    });
});
