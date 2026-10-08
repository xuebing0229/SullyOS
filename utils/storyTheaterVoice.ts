// Story keeps one structural STV protocol, but the acting syntax follows the selected TTS provider.
import { VOICE_ACTING_GUIDE, VALID_EMOTIONS, cleanVoiceMarkupForDisplay, parseVoiceOutput } from './minimaxTts';
import { stripElevenLabsMarkupForDisplay } from './elevenLabsTts';
import { STORY_ELEVENLABS_V4_ACTING_GUIDE, normalizeStoryElevenLabsAudioTags } from './storyElevenLabsActing';

export type StoryVoiceSpeaker = 'char' | 'user';
export type StoryVoiceTaggedSpeaker = StoryVoiceSpeaker | 'npc';
export type StoryVoiceDialogueSpeaker = StoryVoiceSpeaker | null;
export type StoryVoiceSegmentKind = 'dialogue' | 'psychology';

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
    segmentKinds: StoryVoiceSegmentKind[];
}

const STORY_VOICE_PAIR_PATTERN = /(?:\[\[STV:(char|user|npc)\]\]|\[STV:(char|user|npc)\])([\s\S]*?)(?:\[\[\/STV\]\]|\[\/STV\])/gi;
const STORY_VOICE_MARKER_PATTERN = /(?:\[\[STV:[^\]\r\n]{1,32}\]\]|\[STV:[^\]\r\n]{1,32}\]|\[\[\/STV\]\]|\[\/STV\])/gi;
const STORY_TEXT_PATTERN = /<story_text\b[^>]*>([\s\S]*?)(?:<\/story_text\s*>|$)/i;
// 文游格式协议：只有「……」是人物说出口的对白。普通中文双引号、书名号式引号、英文引号等都只是正文标点。
// 播放阶段的坏音频缓存自愈由 Story 会话层处理；这里仅负责对白索引与说话人协议。
const STORY_VOICE_SEGMENT_PATTERN = /(\*(?!\*)[^*\n]+?\*|「[^」\n]*」)/g;

/**
 * Recover clearly spoken lines when a model drifts into ordinary quotation marks.
 * A quote alone is NOT sufficient: titles, citations and quoted thoughts must
 * remain prose. Keep this a synchronous, length-preserving display repair so
 * STV speaker positions and the saved TTS dialogue indexes stay aligned.
 */
const UNTAGGED_QUOTED_SPEECH_PATTERN = /(["“])([^"“”\r\n]{1,280})(["”])/g;

const normalizeUntaggedDialogueLine = (line: string): string => (
    line.replace(UNTAGGED_QUOTED_SPEECH_PATTERN, (raw, _opening: string, words: string, _closing: string, offset: number) => {
        const before = line.slice(0, offset).trimEnd();
        const after = line.slice(offset + raw.length).trimStart();
        const spokenEnding = /(?:[。！？!?…]|\.\.{2,})$/.test(words.trim());
        const speakingCue = /(?:说|问|答|喊|道|解释|提醒|嘟囔|开口|应声|回道|笑道|追问|低语|补充)(?:了|着|道)?[：:,，\s]*$/.test(before.slice(-18));
        const dialogueBoundary = !before || /[，,：:；;。！？!?]\s*$/.test(before);
        // These make a quote an object being discussed, not someone speaking.
        const quotedReference =
            /^(?:这[句段种篇]|那[句段种篇]|这些|那些|一句|一段|几个字|二字|的(?:说法|意思|词|字|标题)|是|被|这个词|那个词|一词|意味着|指的|代表)/.test(after)
            || /(?:题为|名为|叫做|所谓|标题|原文|引文|引用|摘录|写着|写下|记载|标注|拼写|字样|关键词|读到|看到|那句|这句)\s*[：:]?$/.test(before.slice(-14));
        if (quotedReference || (!spokenEnding && !speakingCue) || (!dialogueBoundary && !speakingCue)) {
            return raw;
        }
        return '「' + words + '」';
    })
);

const normalizeUntaggedStoryDialogue = (content: string): string => {
    const normalizeBody = (body: string): string => body.split('\n').map(normalizeUntaggedDialogueLine).join('\n');
    // Structured backstage, prompts and other metadata must never become dialogue.
    if (!/<story_text\b/i.test(content)) return normalizeBody(content);
    return content.replace(
        /(<story_text\b[^>]*>)([\s\S]*?)(<\/story_text\s*>|$)/i,
        (_whole, opening: string, body: string, closing: string) => opening + normalizeBody(body) + closing,
    );
};


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
    // Tagged direct thoughts stay *psychological*, never turn into spoken quotes.
    if (core.startsWith('*') && core.endsWith('*') && core.length > 2) return text;

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
    provider: 'minimax' | 'elevenlabs',
): { text: string; acting: StoryVoiceActing | null } => {
    const parsedVoice = parseVoiceOutput(value);
    const canSpeak = speaker === 'char' || speaker === 'user';
    // MiniMax needs its square-cue compatibility normalization; ElevenLabs v4 must
    // keep raw Audio Tags such as [pause] / [whispers] for the provider adapter.
    const speech = parsedVoice.hasVoiceTag
        ? (provider === 'elevenlabs'
            ? normalizeStoryElevenLabsAudioTags(parsedVoice.rawSpeech)
            : String(parsedVoice.speech || '')).trim()
        : '';
    const spoken = speech.replace(/^\s*\*([\s\S]*?)\*\s*$/, '$1').trim();
    const acting = canSpeak && spoken
        ? {
            speech: spoken,
            ...(parsedVoice.emotion ? { emotion: parsedVoice.emotion } : {}),
        }
        : null;

    const visibleSource = parsedVoice.hasVoiceTag && speech
        ? speech
        : String(value || '').replace(STANDARD_VOICE_WRAPPER_PATTERN, '');
    const visibleText = provider === 'elevenlabs'
        ? stripElevenLabsMarkupForDisplay(visibleSource)
        : cleanVoiceMarkupForDisplay(visibleSource);
    return {
        text: normalizeTaggedDialogueText(visibleText),
        acting,
    };
};

/** Remove hidden speaker tags while retaining their positions in the clean text. */
export const parseStoryVoiceMarkup = (
    value: string,
    provider: 'minimax' | 'elevenlabs' = 'minimax',
): ParsedStoryVoiceMarkup => {
    const source = String(value || '');
    const spans: StoryVoiceSpan[] = [];
    let cleanText = '';
    let cursor = 0;

    STORY_VOICE_PAIR_PATTERN.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = STORY_VOICE_PAIR_PATTERN.exec(source))) {
        cleanText += stripStoryVoiceMarkup(source.slice(cursor, match.index));

        const speaker = String(match[1] || match[2]).toLowerCase() as StoryVoiceTaggedSpeaker;
        const payload = parseTaggedDialoguePayload(match[3], speaker, provider);
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
 * Spoken 「……」 dialogue and *……* direct thoughts share one voice slot order.
 * Quotes in "…" or “…” only count when the recovery rules confirm speech.
 */
export const parseStoryVoiceMessage = (
    value: string,
    provider: 'minimax' | 'elevenlabs' = 'minimax',
): ParsedStoryVoiceMessage => {
    const source = String(value || '');
    const parsedMessage = parseStoryVoiceMarkup(source, provider);
    const cleanText = normalizeUntaggedStoryDialogue(parsedMessage.cleanText);
    const storySource = STORY_TEXT_PATTERN.exec(source)?.[1] ?? source;
    const parsedStory = parseStoryVoiceMarkup(storySource, provider);
    const normalizedStory = normalizeUntaggedStoryDialogue(parsedStory.cleanText);
    const dialogueSpeakers: StoryVoiceDialogueSpeaker[] = [];
    const dialogueActing: Array<StoryVoiceActing | null> = [];
    const segmentKinds: StoryVoiceSegmentKind[] = [];

    STORY_VOICE_SEGMENT_PATTERN.lastIndex = 0;
    let dialogue: RegExpExecArray | null;
    while ((dialogue = STORY_VOICE_SEGMENT_PATTERN.exec(normalizedStory))) {
        const start = dialogue.index;
        const end = start + dialogue[0].length;
        const span = resolveDialogueSpan(start, end, parsedStory.spans);
        const speaker = span?.speaker === 'char' || span?.speaker === 'user' ? span.speaker : null;
        dialogueSpeakers.push(speaker);
        dialogueActing.push(speaker ? (span?.acting || null) : null);
        segmentKinds.push(dialogue[0].startsWith('*') ? 'psychology' : 'dialogue');
    }

    return {
        cleanText,
        dialogueSpeakers,
        dialogueActing,
        segmentKinds,
    };
};

export const extractStoryVoiceDialogues = (value: string): string[] => {
    const source = String(value || '');
    const storySource = STORY_TEXT_PATTERN.exec(source)?.[1] ?? source;
    const parsedStory = parseStoryVoiceMarkup(storySource);
    const normalizedStory = normalizeUntaggedStoryDialogue(parsedStory.cleanText);
    const dialogues: string[] = [];

    STORY_VOICE_SEGMENT_PATTERN.lastIndex = 0;
    let dialogue: RegExpExecArray | null;
    while ((dialogue = STORY_VOICE_SEGMENT_PATTERN.exec(normalizedStory))) {
        dialogues.push(dialogue[0]);
    }
    return dialogues;
};

export const buildStoryVoiceSpeakerFormatReminder = (
    enabled: boolean,
    characterName = '当前主角色',
    userName = '用户',
    provider: 'minimax' | 'elevenlabs' = 'minimax',
    _elevenLabsModel?: string | null,
): string => {
    if (!enabled) return '';
    const emotions = Array.from(VALID_EMOTIONS).join(' / ');
    const isElevenLabs = provider === 'elevenlabs';
    const actingRule = isElevenLabs
        ? '- <语音> 内的字是准确的可发声文字；演绎使用 ElevenLabs v4 英文 Audio Tags，例如 [soft intimate whisper] [voice trembling] [quiet laugh] [short pause]。不要使用 <#秒数#>，不要用模糊的 [breathless rasp] 或带逗号、中文解释的长标签。'
        : '- <语音> 内的字就是实际要念的对白；允许按下方共享演绎规范加入 <#秒数#> 和合法 sound tag，但不要为了“演”而改变事件事实、人物意图或对白语义。';
    const hiddenRule = isElevenLabs
        ? '- <语音>、emotion 与 Audio Tags 都是隐藏的 TTS 演绎数据，正文显示时系统会自动去掉；不要在正文里解释这些标记。'
        : '- <语音>、emotion、<#秒数#>、sound tag 都是隐藏的 TTS 演绎数据，正文显示时系统会自动去掉；不要在正文里解释这些标记。';
    const example = isElevenLabs
        ? '- 示例：[[STV:char]]<语音 emotion="sad">「[voice trembling]我知道。只是……有点难受。」</语音>[[/STV]] / [[STV:user]]<语音 emotion="calm">「那就先走吧。」</语音>[[/STV]] / [[STV:char]]<语音 emotion="sad">*[soft intimate whisper]为什么会这样？*</语音>[[/STV]] / [[STV:npc]]「请出示证件。」[[/STV]]。'
        : '- 示例：[[STV:char]]<语音 emotion="sad">「我知道。<#0.5#>(sighs)只是……有点难受。」</语音>[[/STV]] / [[STV:user]]<语音 emotion="calm">「那就先走吧。」</语音>[[/STV]] / [[STV:char]]<语音 emotion="sad">*为什么会这样？*</语音>[[/STV]] / [[STV:npc]]「请出示证件。」[[/STV]]。';
    // Story keeps a separate, drama-CD-oriented guide so chat/phone voices do not change.
    const providerGuide = isElevenLabs ? STORY_ELEVENLABS_V4_ACTING_GUIDE : VOICE_ACTING_GUIDE;
    return [
        '### 文游对白与语音隐藏标记（仅作用于 <story_text> 主正文）',
        '- 真实说出口的对白必须用「……」，直接内心心理独白必须用 *……*；两种都支持配音，但内心活动不是说出口的对白。',
        '- “……”、『……』、‘……’、英文引号等都是普通正文标点，可用于专名、标题、引用、强调等；它们不是对白，不参与对白着色或语音。',
        '- 每一句真实对白和每段直接心理都必须各有且只有一组 STV；心理的归属是正在思考的人，而非旁白。不要因为 ElevenLabs Audio Tags 就把对白换成双引号。',
        `- ${characterName} 说出口的对白必须写成：[[STV:char]]<语音 emotion="calm">「……」</语音>[[/STV]]。`,
        `- ${userName} 说出口的对白必须写成：[[STV:user]]<语音 emotion="calm">「……」</语音>[[/STV]]。`,
        `- ${characterName} 的直接心理必须写成：[[STV:char]]<语音 emotion="calm">*……*</语音>[[/STV]]；${userName} 的直接心理用 [[STV:user]]<语音 emotion="calm">*……*</语音>[[/STV]]；星号不送 TTS 朗读。`,
        `- emotion 必须根据当前情境、动作、心理状态、前后文和关系氛围逐句判断，只能从这些标准值中选择：${emotions}。不要因为同一说话人就固定一种 emotion。`,
        actingRule,
        hiddenRule,
        '- NPC、路人和其他人物说出口的对白：[[STV:npc]]「……」[[/STV]]；他们正常显示为对白，但目前不配音，不要给 NPC 添加 <语音>。',
        '- 旁白、动作、环境描写，以及“他心里五味杂陈”等描述性心理旁白不要添加 STV 或 <语音>；只有 *……* 直接心理独白要加。普通引用与专名也不得添加 STV。',
        '- STV 必须成对出现，不要把标记放到 <story_text> 之外。',
        example,
        '',
        providerGuide,
    ].join('\n');
};
