export type StoryVoiceSpeaker = 'char' | 'user';
export type StoryVoiceDialogueSpeaker = StoryVoiceSpeaker | null;

export interface StoryVoiceSpan {
    speaker: StoryVoiceSpeaker;
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

const STORY_VOICE_PAIR_PATTERN = /(?:\[\[STV:(char|user)\]\]|\[STV:(char|user)\])([\s\S]*?)(?:\[\[\/STV\]\]|\[\/STV\])/gi;
const STORY_VOICE_MARKER_PATTERN = /(?:\[\[STV:[^\]\r\n]{1,32}\]\]|\[STV:[^\]\r\n]{1,32}\]|\[\[\/STV\]\]|\[\/STV\])/gi;
const STORY_TEXT_PATTERN = /<story_text\b[^>]*>([\s\S]*?)(?:<\/story_text\s*>|$)/i;
// 文游格式协议：只有「……」是人物说出口的对白。普通中文双引号、书名号式引号、英文引号等都只是正文标点。
const STORY_DIALOGUE_PATTERN = /(「[^」\n]*」)/g;

/**
 * Speaker metadata is transport-only. It must never be rendered, copied, exported,
 * archived, sent to image planning, or forwarded into later story prompts.
 */
export const stripStoryVoiceMarkup = (value: string): string => (
    String(value || '').replace(STORY_VOICE_MARKER_PATTERN, '')
);

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

        const speaker = String(match[1] || match[2]).toLowerCase() as StoryVoiceSpeaker;
        const text = stripStoryVoiceMarkup(match[3]);
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
    let best: { speaker: StoryVoiceSpeaker; overlap: number } | undefined;
    for (const span of spans) {
        const overlap = Math.min(end, span.end) - Math.max(start, span.start);
        if (overlap <= 0) continue;
        if (!best || overlap > best.overlap) best = { speaker: span.speaker, overlap };
    }
    return best?.speaker ?? null;
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
        `- ${characterName} 说出口的对白：[[STV:char]]「……」[[/STV]]。`,
        `- ${userName} 说出口的对白：[[STV:user]]「……」[[/STV]]。`,
        '- NPC、路人和其他人物说出口的对白也使用「……」，但不要添加 STV；目前不为他们配音。',
        '- 不要求正文出现“说、问、开口、低声道”等发言动词；「……」本身已经表示这是说出口的对白，STV 只负责标记 char / user 归属。',
        '- 旁白、动作、环境描写、心理活动不要添加 STV。',
        '- STV 必须成对出现，不要解释标记，不要把标记放到 <story_text> 之外。',
        '- 示例：[[STV:char]]「我知道。」[[/STV]] / [[STV:user]]「那就走吧。」[[/STV]]；“金环”作为专名保持普通正文。',
    ].join('\n');
};
