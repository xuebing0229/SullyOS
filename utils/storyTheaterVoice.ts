// Story intentionally reuses the shared acting guide so char/user TTS stay behaviorally aligned.
import { VOICE_ACTING_GUIDE, VALID_EMOTIONS, cleanVoiceMarkupForDisplay, parseVoiceOutput } from './minimaxTts';

export type StoryVoiceSpeaker = 'char' | 'user';
export type StoryVoiceTaggedSpeaker = StoryVoiceSpeaker | 'npc';
export type StoryVoiceDialogueSpeaker = StoryVoiceSpeaker | null;

export interface StoryVoiceActing {
    speech: string;
    emotion?: string;
}

export interface StoryVoiceSpan {
    speaker: StoryVoiceTaggedSpeaker;
    start: number;
    end: number;
    text: string;
    acting: StoryVoiceActing | null;
}

export interface ParsedStoryVoiceMarkup {
    cleanText: string;
    spans: StoryVoiceSpan[];
}

export interface ParsedStoryVoiceMessage {
    cleanText: string;
    dialogueSpeakers: StoryVoiceDialogueSpeaker[];
    dialogueActing: Array<StoryVoiceActing | null>;
}

const STORY_VOICE_PAIR_PATTERN = /(?:\[\[STV:(char|user|npc)\]\]|\[STV:(char|user|npc)\])([\s\S]*?)(?:\[\[\/STV\]\]|\[\/STV\])/gi;
const STORY_VOICE_MARKER_PATTERN = /(?:\[\[STV:[^\]\r\n]{1,32}\]\]|\[STV:[^\]\r\n]{1,32}\]|\[\[\/STV\]\]|\[\/STV\])/gi;
const STORY_TEXT_PATTERN = /<story_text\b[^>]*>([\s\S]*?)(?:<\/story_text\s*>|$)/i;
// 文游格式协议：只有「……」是人物说出口的对白。普通中文双引号、书名号式引号、英文引号等都只是正文标点。
// 播放阶段的坏音频缓存自愈由 Story 会话层处理；这里仅负责对白索引与说话人协议。
const STORY_DIALOGUE_PATTERN = /(「[^」\n]*」)/g;

/**
 * Speaker metadata is transport-only. It must never be rendered, copied, exported,
 * archived, sent to image planning, or forwarded into later story prompts.
 */
export const stripStoryVoiceMarkup = (value: string): string => (
    String(value || '').replace(STORY_VOICE_MARKER_PATTERN, '')
);

/**
 * STV is the structural source of truth for spoken dialogue. Models occasionally
 * drift back to Chinese/English double quotes because older story history contains
 * them, so normalize ONLY tagged speech to the Story dialogue punctuation. Untagged
 * “quoted prose” is deliberately left untouched and remains ordinary narration.
 */
const normalizeTaggedDialogueText = (value: string): string => {
    const text = stripStoryVoiceMarkup(value);
    const leading = text.match(/^\s*/)?.[0] || '';
    const trailing = text.match(/\s*$/)?.[0] || '';
    let core = text.slice(leading.length, text.length - trailing.length);
    if (!core) return text;

    const quotePairs: Array<[string, string]> = [
        ['「', '」'],
        ['“', '”'],
        ['『', '』'],
        ['‘', '’'],
        ['"', '"'],
        ["'", "'"],
    ];
    for (const [open, close] of quotePairs) {
        if (core.startsWith(open) && core.endsWith(close) && core.length >= open.length + close.length) {
            core = core.slice(open.length, core.length - close.length);
            break;
        }
    }
    return `${leading}「${core}」${trailing}`;
};

const STANDARD_VOICE_WRAPPER_PATTERN = /<\/?[语語]音\b[^>]*>/gi;

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

/** Remove hidden speaker tags while retaining their positions in the clean text. */
export const parseStoryVoiceMarkup = (value: string): ParsedStoryVoiceMarkup => {
    const source = String(value || '');
    const spans: StoryVoiceSpan[] = [];
    let cleanText = '';
    let cursor = 0;

    STORY_VOICE_PAIR_PATTERN.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = STORY_VOICE_PAIR_PATTERN.exec(source))) {
        cleanText += stripStoryVoiceMarkup(source.slice(cursor, match.index));

        const speaker = String(match[1] || match[2]).toLowerCase() as StoryVoiceTaggedSpeaker;
        const payload = parseTaggedDialoguePayload(match[3], speaker);
        const text = payload.text;
        const start = cleanText.length;
        cleanText += text;
        const end = cleanText.length;

        if (text) spans.push({ speaker, start, end, text, acting: payload.acting });
        cursor = match.index + match[0].length;
    }

    cleanText += stripStoryVoiceMarkup(source.slice(cursor));
    return { cleanText, spans };
};

const resolveDialogueSpan = (
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
};

/**
 * Only 「……」 consumes a dialogue slot. Other quotation marks remain ordinary prose,
 * so quoted names/references can never shift TTS dialogue indexes.
 */
export const parseStoryVoiceMessage = (value: string): ParsedStoryVoiceMessage => {
    const source = String(value || '');
    const parsedMessage = parseStoryVoiceMarkup(source);
    const storySource = STORY_TEXT_PATTERN.exec(source)?.[1] ?? source;
    const parsedStory = parseStoryVoiceMarkup(storySource);
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
    };
};

export const extractStoryVoiceDialogues = (value: string): string[] => {
    const source = String(value || '');
    const storySource = STORY_TEXT_PATTERN.exec(source)?.[1] ?? source;
    const parsedStory = parseStoryVoiceMarkup(storySource);
    const dialogues: string[] = [];

    STORY_DIALOGUE_PATTERN.lastIndex = 0;
    let dialogue: RegExpExecArray | null;
    while ((dialogue = STORY_DIALOGUE_PATTERN.exec(parsedStory.cleanText))) {
        dialogues.push(dialogue[0]);
    }
    return dialogues;
};

export const buildStoryVoiceSpeakerFormatReminder = (
    enabled: boolean,
    characterName = '当前主角色',
    userName = '用户',
): string => {
    if (!enabled) return '';
    const emotions = Array.from(VALID_EMOTIONS).join(' / ');
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
    ].join('\n');
};