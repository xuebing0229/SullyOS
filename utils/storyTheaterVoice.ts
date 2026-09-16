export type StoryVoiceSpeaker = 'char' | 'user';
export type StoryVoiceTaggedSpeaker = StoryVoiceSpeaker | 'npc';
export type StoryVoiceDialogueSpeaker = StoryVoiceSpeaker | null;

export interface StoryVoiceSpan {
    speaker: StoryVoiceTaggedSpeaker;
    start: number;
    end: number;
    text: string;
}

export interface ParsedStoryVoiceMarkup {
    cleanText: string;
    spans: StoryVoiceSpan[];
}

export interface ParsedStoryVoiceMessage {
    cleanText: string;
    dialogueSpeakers: StoryVoiceDialogueSpeaker[];
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
        const text = normalizeTaggedDialogueText(match[3]);
        const start = cleanText.length;
        cleanText += text;
        const end = cleanText.length;

        if (text) spans.push({ speaker, start, end, text });
        cursor = match.index + match[0].length;
    }

    cleanText += stripStoryVoiceMarkup(source.slice(cursor));
    return { cleanText, spans };
};

const resolveDialogueSpeaker = (
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
    return [
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
    ].join('\n');
};