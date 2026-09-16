from pathlib import Path

ROOT = Path(".")
session_path = ROOT / "components/date/story/StoryTheaterSession.tsx"
voice_path = ROOT / "utils/storyTheaterVoice.ts"
test_path = ROOT / "utils/storyTheaterVoice.test.ts"

def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{label}: expected exactly one match, found {count}")
    return text.replace(old, new, 1)

# ---- Shared Story voice parser/prompt: reuse the project's existing acting guide. ----
voice = voice_path.read_text(encoding="utf-8")
if "VOICE_ACTING_GUIDE" not in voice:
    voice = "import { VOICE_ACTING_GUIDE, VALID_EMOTIONS, cleanVoiceMarkupForDisplay, parseVoiceOutput } from './minimaxTts';\n\n" + voice

voice = replace_once(
    voice,
    """export type StoryVoiceDialogueSpeaker = StoryVoiceSpeaker | null;

export interface StoryVoiceSpan {""",
    """export type StoryVoiceDialogueSpeaker = StoryVoiceSpeaker | null;

export interface StoryVoiceActing {
    speech: string;
    emotion?: string;
}

export interface StoryVoiceSpan {""",
    "add StoryVoiceActing type",
)
voice = replace_once(
    voice,
    """    end: number;
    text: string;
}

export interface ParsedStoryVoiceMarkup {""",
    """    end: number;
    text: string;
    acting: StoryVoiceActing | null;
}

export interface ParsedStoryVoiceMarkup {""",
    "add acting to StoryVoiceSpan",
)
voice = replace_once(
    voice,
    """export interface ParsedStoryVoiceMessage {
    cleanText: string;
    dialogueSpeakers: StoryVoiceDialogueSpeaker[];
}""",
    """export interface ParsedStoryVoiceMessage {
    cleanText: string;
    dialogueSpeakers: StoryVoiceDialogueSpeaker[];
    dialogueActing: Array<StoryVoiceActing | null>;
}""",
    "add dialogueActing result",
)

needle = """    return `${leading}「${core}」${trailing}`;
};

/** Remove hidden speaker tags while retaining their positions in the clean text. */"""
replacement = """    return `${leading}「${core}」${trailing}`;
};

const STANDARD_VOICE_WRAPPER_PATTERN = /<\\/?[语語]音\\b[^>]*>/gi;

/**
 * Story uses the same standard <语音 emotion="..."> payload and acting grammar as
 * the mature chat/phone voice path.  The visible story keeps only the spoken words;
 * pause/sound markers stay hidden and are saved separately for TTS playback.
 */
const parseTaggedDialoguePayload = (
    value: string,
    speaker: StoryVoiceTaggedSpeaker,
): { text: string; acting: StoryVoiceActing | null } => {
    const parsedVoice = parseVoiceOutput(value);
    const canSpeak = speaker === 'char' || speaker === 'user';
    const speech = parsedVoice.hasVoiceTag ? String(parsedVoice.speech || '').trim() : '';
    const acting = canSpeak && speech
        ? {
            speech,
            ...(parsedVoice.emotion ? { emotion: parsedVoice.emotion } : {}),
        }
        : null;

    // Malformed/interrupted <语音> wrappers are transport syntax too: never leak
    // them into Story text. cleanVoiceMarkupForDisplay also removes <#x#> and
    // whitelisted sound tags while preserving the actual words.
    const visibleSource = parsedVoice.hasVoiceTag && speech
        ? speech
        : String(value || '').replace(STANDARD_VOICE_WRAPPER_PATTERN, '');
    const visibleText = cleanVoiceMarkupForDisplay(visibleSource);
    return {
        text: normalizeTaggedDialogueText(visibleText),
        acting,
    };
};

/** Remove hidden speaker tags while retaining their positions in the clean text. */"""
voice = replace_once(voice, needle, replacement, "insert standard acting parser")

voice = replace_once(
    voice,
    """        const speaker = String(match[1] || match[2]).toLowerCase() as StoryVoiceTaggedSpeaker;
        const text = normalizeTaggedDialogueText(match[3]);
        const start = cleanText.length;
        cleanText += text;
        const end = cleanText.length;

        if (text) spans.push({ speaker, start, end, text });""",
    """        const speaker = String(match[1] || match[2]).toLowerCase() as StoryVoiceTaggedSpeaker;
        const payload = parseTaggedDialoguePayload(match[3], speaker);
        const text = payload.text;
        const start = cleanText.length;
        cleanText += text;
        const end = cleanText.length;

        if (text) spans.push({ speaker, start, end, text, acting: payload.acting });""",
    "parse acting inside STV span",
)

voice = replace_once(
    voice,
    """const resolveDialogueSpeaker = (
    start: number,
    end: number,
    spans: StoryVoiceSpan[],
): StoryVoiceDialogueSpeaker => {
    let best: { speaker: StoryVoiceTaggedSpeaker; overlap: number } | undefined;
    for (const span of spans) {
        const overlap = Math.min(end, span.end) - Math.max(start, span.start);
        if (overlap <= 0) continue;
        if (!best || overlap > best.overlap) best = { speaker: span.speaker, overlap };
    }
    return best?.speaker === 'char' || best?.speaker === 'user' ? best.speaker : null;
};""",
    """const resolveDialogueSpan = (
    start: number,
    end: number,
    spans: StoryVoiceSpan[],
): StoryVoiceSpan | undefined => {
    let best: { span: StoryVoiceSpan; overlap: number } | undefined;
    for (const span of spans) {
        const overlap = Math.min(end, span.end) - Math.max(start, span.start);
        if (overlap <= 0) continue;
        if (!best || overlap > best.overlap) best = { span, overlap };
    }
    return best?.span;
};""",
    "resolve dialogue span",
)

voice = replace_once(
    voice,
    """    const parsedStory = parseStoryVoiceMarkup(storySource);
    const dialogueSpeakers: StoryVoiceDialogueSpeaker[] = [];

    STORY_DIALOGUE_PATTERN.lastIndex = 0;
    let dialogue: RegExpExecArray | null;
    while ((dialogue = STORY_DIALOGUE_PATTERN.exec(parsedStory.cleanText))) {
        const start = dialogue.index;
        const end = start + dialogue[0].length;
        dialogueSpeakers.push(resolveDialogueSpeaker(start, end, parsedStory.spans));
    }

    return {
        cleanText: parsedMessage.cleanText,
        dialogueSpeakers,
    };""",
    """    const parsedStory = parseStoryVoiceMarkup(storySource);
    const dialogueSpeakers: StoryVoiceDialogueSpeaker[] = [];
    const dialogueActing: Array<StoryVoiceActing | null> = [];

    STORY_DIALOGUE_PATTERN.lastIndex = 0;
    let dialogue: RegExpExecArray | null;
    while ((dialogue = STORY_DIALOGUE_PATTERN.exec(parsedStory.cleanText))) {
        const start = dialogue.index;
        const end = start + dialogue[0].length;
        const span = resolveDialogueSpan(start, end, parsedStory.spans);
        const speaker = span?.speaker === 'char' || span?.speaker === 'user' ? span.speaker : null;
        dialogueSpeakers.push(speaker);
        dialogueActing.push(speaker ? (span?.acting || null) : null);
    }

    return {
        cleanText: parsedMessage.cleanText,
        dialogueSpeakers,
        dialogueActing,
    };""",
    "return aligned acting metadata",
)

old_prompt = """    return [
        '### 文游对白与语音隐藏标记（仅作用于 <story_text> 主正文）',
        '- 人物真实说出口的对白一律使用「……」。只有「……」会被视为对白。',
        '- “……”、『……』、‘……’、英文引号等都是普通正文标点，可用于专名、标题、引用、强调等；它们不是对白，不参与对白着色或语音。',
        '- 每一句真实说出口的对白都必须有且只有一组 STV，说话人归属由 STV 决定，不依赖“说、问、开口”等发言动词。',
        `- ${characterName} 说出口的对白：[[STV:char]]「……」[[/STV]]。`,
        `- ${userName} 说出口的对白：[[STV:user]]「……」[[/STV]]。`,
        '- NPC、路人和其他人物说出口的对白：[[STV:npc]]「……」[[/STV]]；他们正常显示为对白，但目前不配音。',
        '- 旁白、动作、环境描写、心理活动不要添加 STV；普通引用与专名也绝不能添加 STV。',
        '- STV 必须成对出现，不要解释标记，不要把标记放到 <story_text> 之外。',
        '- 示例：[[STV:char]]「我知道。」[[/STV]] / [[STV:user]]「那就走吧。」[[/STV]] / [[STV:npc]]「请出示证件。」[[/STV]]；“金环”作为专名保持普通正文。',
    ].join('\\n');"""
new_prompt = """    const emotions = Array.from(VALID_EMOTIONS).join(' / ');
    return [
        '### 文游对白与语音隐藏标记（仅作用于 <story_text> 主正文）',
        '- 人物真实说出口的对白一律使用「……」。只有「……」会被视为对白。',
        '- “……”、『……』、‘……’、英文引号等都是普通正文标点，可用于专名、标题、引用、强调等；它们不是对白，不参与对白着色或语音。',
        '- 每一句真实说出口的对白都必须有且只有一组 STV，说话人归属由 STV 决定，不依赖“说、问、开口”等发言动词。',
        `- ${characterName} 说出口的对白必须写成：[[STV:char]]<语音 emotion="calm">「……」</语音>[[/STV]]。`,
        `- ${userName} 说出口的对白必须写成：[[STV:user]]<语音 emotion="calm">「……」</语音>[[/STV]]。`,
        `- emotion 必须根据当前情境、动作、心理状态、前后文和关系氛围逐句判断，只能从这些标准值中选择：${emotions}。不要因为同一说话人就固定一种 emotion。`,
        '- <语音> 内的字就是实际要念的对白；允许按下方共享演绎规范加入 <#秒数#> 和合法 sound tag，但不要为了“演”而改变事件事实、人物意图或对白语义。',
        '- <语音>、emotion、<#秒数#>、sound tag 都是隐藏的 TTS 演绎数据，正文显示时系统会自动去掉；不要在正文里解释这些标记。',
        '- NPC、路人和其他人物说出口的对白：[[STV:npc]]「……」[[/STV]]；他们正常显示为对白，但目前不配音，不要给 NPC 添加 <语音>。',
        '- 旁白、动作、环境描写、心理活动不要添加 STV 或 <语音>；普通引用与专名也绝不能添加 STV。',
        '- STV 必须成对出现，不要把标记放到 <story_text> 之外。',
        '- 示例：[[STV:char]]<语音 emotion="sad">「我知道。<#0.5#>(sighs)只是……有点难受。」</语音>[[/STV]] / [[STV:user]]<语音 emotion="calm">「那就先走吧。」</语音>[[/STV]] / [[STV:npc]]「请出示证件。」[[/STV]]。',
        '',
        VOICE_ACTING_GUIDE,
    ].join('\\n');"""
voice = replace_once(voice, old_prompt, new_prompt, "reuse shared acting guide in Story prompt")
voice_path.write_text(voice, encoding="utf-8")

# ---- Story session: persist/play the hidden acting payload, no main-chat changes. ----
session = session_path.read_text(encoding="utf-8")
session = replace_once(
    session,
    """import {
    buildStoryVoiceSpeakerFormatReminder,
    parseStoryVoiceMessage,
    type StoryVoiceSpeaker,
} from '../../../utils/storyTheaterVoice';""",
    """import {
    buildStoryVoiceSpeakerFormatReminder,
    parseStoryVoiceMessage,
    type StoryVoiceActing,
    type StoryVoiceSpeaker,
} from '../../../utils/storyTheaterVoice';""",
    "import StoryVoiceActing",
)

session = replace_once(
    session,
    """const voiceSpeakersFromMessage = (message: Message | undefined): Array<StoryVoiceSpeaker | null> => {
    const values = message?.metadata?.theaterVoiceSpeakers;
    if (!Array.isArray(values)) return [];
    return values.map(value => value === 'char' || value === 'user' ? value : null);
};

interface AffinityDraft""",
    """const voiceSpeakersFromMessage = (message: Message | undefined): Array<StoryVoiceSpeaker | null> => {
    const values = message?.metadata?.theaterVoiceSpeakers;
    if (!Array.isArray(values)) return [];
    return values.map(value => value === 'char' || value === 'user' ? value : null);
};

const voiceActingFromMessage = (message: Message | undefined): Array<StoryVoiceActing | null> => {
    const values = message?.metadata?.theaterVoiceActing;
    if (!Array.isArray(values)) return [];
    return values.map(value => {
        if (!value || typeof value !== 'object') return null;
        const speech = String((value as any).speech || '').trim();
        if (!speech) return null;
        const emotion = String((value as any).emotion || '').trim().toLowerCase();
        return { speech, ...(emotion ? { emotion } : {}) };
    });
};

interface AffinityDraft""",
    "read persisted acting metadata",
)

session = replace_once(
    session,
    """    const storyVoiceTargetKeyRef = useRef<string | null>(null);
    const storyVoiceSpeakersRef = useRef<Array<StoryVoiceSpeaker | null>>([]);
    // Match main chat's proven playback lifecycle:""",
    """    const storyVoiceTargetKeyRef = useRef<string | null>(null);
    const storyVoiceSpeakersRef = useRef<Array<StoryVoiceSpeaker | null>>([]);
    const storyVoiceActingRef = useRef<Array<StoryVoiceActing | null>>([]);
    // Match main chat's proven playback lifecycle:""",
    "add acting ref",
)

session = replace_once(
    session,
    """    ) => {
        if (entry.storyTtsEnabled !== true) return;

        let resolvedSpeaker = speaker;
        if (!resolvedSpeaker) {
            const message = messages.find(item => item.id === messageId);
            if (!message) return;""",
    """    ) => {
        if (entry.storyTtsEnabled !== true) return;

        const targetMessage = messages.find(item => item.id === messageId);
        let resolvedSpeaker = speaker;
        if (!resolvedSpeaker) {
            const message = targetMessage;
            if (!message) return;""",
    "reuse message for speaker and acting lookup",
)

session = replace_once(
    session,
    """        const actor = resolvedSpeaker === 'char' ? actors[0] : resolvedSpeaker === 'user' ? createUserVoiceTarget(userProfile) : undefined;
        if (!actor) return;

        const key = storyVoiceAssetKey(entry.id, messageId, dialogueIndex);""",
    """        const actor = resolvedSpeaker === 'char' ? actors[0] : resolvedSpeaker === 'user' ? createUserVoiceTarget(userProfile) : undefined;
        if (!actor) return;

        const acting = voiceActingFromMessage(targetMessage)[dialogueIndex] ?? null;
        const synthesisText = String(acting?.speech || text).trim() || text;
        const key = storyVoiceAssetKey(entry.id, messageId, dialogueIndex);""",
    "resolve per-dialogue acting payload",
)

session = replace_once(
    session,
    """        const cached = !force ? storyVoiceCacheRef.current.get(key) : undefined;
        if (cached?.originalText === text) {""",
    """        const cached = !force ? storyVoiceCacheRef.current.get(key) : undefined;
        if (cached?.originalText === synthesisText) {""",
    "cache key respects acting text",
)

session = replace_once(
    session,
    """            const playable = await ensureVoiceAsset({
                key,
                text,
                char: actor,
                apiConfig: storyTtsApiConfig,
                languageBoost: actor.chatVoiceLang || undefined,
                groupId: apiConfig.minimaxGroupId || undefined,
                force,
            });""",
    """            const playable = await ensureVoiceAsset({
                key,
                text: synthesisText,
                spokenText: text,
                char: actor,
                apiConfig: storyTtsApiConfig,
                languageBoost: actor.chatVoiceLang || undefined,
                groupId: apiConfig.minimaxGroupId || undefined,
                emotion: acting?.emotion,
                force,
            });""",
    "pass acting payload to shared TTS asset path",
)

session = replace_once(
    session,
    """            storyVoiceCacheRef.current.set(key, { url: playable.url, originalText: text });""",
    """            storyVoiceCacheRef.current.set(key, { url: playable.url, originalText: synthesisText });""",
    "cache synthesis text",
)

session = replace_once(
    session,
    """            const { cleanText: content, dialogueSpeakers: parsedVoiceSpeakers } = parseStoryVoiceMessage(rawAssistantContent);
            storyVoiceSpeakersRef.current = [...parsedVoiceSpeakers];""",
    """            const {
                cleanText: content,
                dialogueSpeakers: parsedVoiceSpeakers,
                dialogueActing: parsedVoiceActing,
            } = parseStoryVoiceMessage(rawAssistantContent);
            storyVoiceSpeakersRef.current = [...parsedVoiceSpeakers];
            storyVoiceActingRef.current = [...parsedVoiceActing];""",
    "capture acting metadata from generated response",
)

session = replace_once(
    session,
    """            usedNativeBackground = isNativeStoryBackgroundRuntime();
            storyVoiceSpeakersRef.current = [];
            const generated = await callCompletion(""",
    """            usedNativeBackground = isNativeStoryBackgroundRuntime();
            storyVoiceSpeakersRef.current = [];
            storyVoiceActingRef.current = [];
            const generated = await callCompletion(""",
    "reset acting metadata per generation",
)

session = replace_once(
    session,
    """            let storyVoiceSpeakers = [...storyVoiceSpeakersRef.current];
            if (entry.storyTtsEnabled === true) {
                const dialogueCount = parseStoryVoiceMessage(rawContent).dialogueSpeakers.length;
                if (dialogueCount > 0) {
                    storyVoiceSpeakers = Array.from({ length: dialogueCount }, (_, index) => storyVoiceSpeakers[index] ?? null);""",
    """            let storyVoiceSpeakers = [...storyVoiceSpeakersRef.current];
            let storyVoiceActing = [...storyVoiceActingRef.current];
            if (entry.storyTtsEnabled === true) {
                const dialogueCount = parseStoryVoiceMessage(rawContent).dialogueSpeakers.length;
                if (dialogueCount > 0) {
                    storyVoiceSpeakers = Array.from({ length: dialogueCount }, (_, index) => storyVoiceSpeakers[index] ?? null);
                    storyVoiceActing = Array.from({ length: dialogueCount }, (_, index) => storyVoiceActing[index] ?? null);""",
    "align acting metadata with dialogue ordinals",
)

session = replace_once(
    session,
    """                ...(affinityInputs.length > 0 ? { theaterAffinityInputs: affinityInputs } : {}),
                ...(storyVoiceSpeakers.length > 0 ? { theaterVoiceSpeakers: storyVoiceSpeakers } : {}),
            };""",
    """                ...(affinityInputs.length > 0 ? { theaterAffinityInputs: affinityInputs } : {}),
                ...(storyVoiceSpeakers.length > 0 ? { theaterVoiceSpeakers: storyVoiceSpeakers } : {}),
                ...(storyVoiceActing.some(Boolean) ? { theaterVoiceActing: storyVoiceActing } : {}),
            };""",
    "persist acting metadata",
)

# Interrupted generations can contain transport markup. Strip it before persistence and
# preserve any complete acting slots that were already returned.
session = replace_once(
    session,
    """            const committedPartial = (partialStreamText || streamingTextRef.current || returnedPartial).trim();
            if (committedPartial) {""",
    """            const committedPartialRaw = (partialStreamText || streamingTextRef.current || returnedPartial).trim();
            const parsedPartialVoice = parseStoryVoiceMessage(committedPartialRaw);
            const committedPartial = parsedPartialVoice.cleanText.trim();
            if (committedPartial) {""",
    "clean partial Story voice transport markup",
)
session = replace_once(
    session,
    """                            ...(activeRequestKey ? { theaterRequestKey: activeRequestKey } : {}),
                            ...(partialAffinityInputs.length > 0 ? { theaterAffinityInputs: partialAffinityInputs } : {}),""",
    """                            ...(activeRequestKey ? { theaterRequestKey: activeRequestKey } : {}),
                            ...(partialAffinityInputs.length > 0 ? { theaterAffinityInputs: partialAffinityInputs } : {}),
                            ...(parsedPartialVoice.dialogueSpeakers.length > 0 ? { theaterVoiceSpeakers: parsedPartialVoice.dialogueSpeakers } : {}),
                            ...(parsedPartialVoice.dialogueActing.some(Boolean) ? { theaterVoiceActing: parsedPartialVoice.dialogueActing } : {}),""",
    "persist partial acting metadata",
)

session_path.write_text(session, encoding="utf-8")

# ---- Focused tests updated to current 「dialogue」 protocol + standard acting payload. ----
test_path.write_text(r"""import { describe, expect, it } from 'vitest';
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
""", encoding="utf-8")

print("Applied Story shared acting-guide integration")
