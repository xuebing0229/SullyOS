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

const STORY_VOICE_PAIR_PATTERN = /\[\[STV:(char|user)\]\]([\s\S]*?)\[\[\/STV\]\]/gi;
const STORY_VOICE_MARKER_PATTERN = /\[\[STV:[^\]\r\n]{1,32}\]\]|\[\[\/STV\]\]/gi;
const STORY_TEXT_PATTERN = /<story_text\b[^>]*>([\s\S]*?)(?:<\/story_text\s*>|$)/i;
const STORY_DIALOGUE_PATTERN = /(「[^」\n]*」|『[^』\n]*』|“[^”\n]*”|‘[^’\n]*’|"[^"\n]*")/g;

/**
 * StoryTheaterSession strips the hidden STV tags inside its async completion helper,
 * then saves the parsed speaker ordinals in the caller's next microtask. Keep that
 * tiny handoff available across the async boundary without leaking tags into the
 * visible story text. Re-publishing in a microtask keeps concurrent completions from
 * stealing each other's speaker list before their own await continuation resumes.
 */
declare global {
    var storyVoiceSpeakers: StoryVoiceDialogueSpeaker[];
}

if (!Array.isArray(globalThis.storyVoiceSpeakers)) {
    globalThis.storyVoiceSpeakers = [];
}

const handoffStoryVoiceSpeakers = (speakers: StoryVoiceDialogueSpeaker[]) => {
    const snapshot = [...speakers];
    const publish = () => {
        globalThis.storyVoiceSpeakers = snapshot;
    };

    publish();
    if (typeof queueMicrotask === 'function') {
        queueMicrotask(publish);
    } else {
        void Promise.resolve().then(publish);
    }
};

/**
 * Speaker metadata is transport-only. It must never be rendered, copied, exported,
 * archived, sent to image planning, or forwarded into later story prompts.
 */
export const stripStoryVoiceMarkup = (value: string): string => (
    String(value || '').replace(STORY_VOICE_MARKER_PATTERN, '')
);

/**
 * Remove hidden STV speaker tags while retaining their positions in the clean text.
 * This deliberately does not decide whether a span is dialogue: the existing story
 * tone parser remains the single source of truth for narration/dialogue/psychology.
 */
export const parseStoryVoiceMarkup = (value: string): ParsedStoryVoiceMarkup => {
    const source = String(value || '');
    const spans: StoryVoiceSpan[] = [];
    let cleanText = '';
    let cursor = 0;

    STORY_VOICE_PAIR_PATTERN.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = STORY_VOICE_PAIR_PATTERN.exec(source))) {
        cleanText += stripStoryVoiceMarkup(source.slice(cursor, match.index));

        const speaker = match[1].toLowerCase() as StoryVoiceSpeaker;
        const text = stripStoryVoiceMarkup(match[2]);
        const start = cleanText.length;
        cleanText += text;
        const end = cleanText.length;

        if (text) spans.push({ speaker, start, end, text });
        cursor = match.index + match[0].length;
    }

    cleanText += stripStoryVoiceMarkup(source.slice(cursor));
    return { cleanText, spans };
};

/**
 * Convert hidden speaker spans into the ordinal sequence used by the existing story
 * tone parser. Every quoted dialogue consumes one slot; NPC/untagged dialogue keeps
 * a null slot, so repeated identical text never causes char/user voices to cross.
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
        const owner = parsedStory.spans.find(span => start >= span.start && end <= span.end);
        dialogueSpeakers.push(owner?.speaker ?? null);
    }

    handoffStoryVoiceSpeakers(dialogueSpeakers);

    return {
        cleanText: parsedMessage.cleanText,
        dialogueSpeakers,
    };
};

export const buildStoryVoiceSpeakerFormatReminder = (
    enabled: boolean,
    characterName = '当前主角色',
    userName = '用户',
): string => {
    if (!enabled) return '';
    return [
        '### 文游对白说话人隐藏标记（仅作用于 <story_text> 主正文）',
        '- 保持原有正文与三色格式完全不变；这些标记只用于内部识别对白说话人。',
        `- ${characterName} 明确说出口的对白：在整段对白外包一层 [[STV:char]]...[[/STV]]。`,
        `- ${userName} 明确说出口的对白：在整段对白外包一层 [[STV:user]]...[[/STV]]。`,
        '- NPC、路人、其他角色的对白不要添加任何 STV 标记。',
        '- 旁白、动作、环境描写、心理活动绝对不要添加 STV 标记。',
        '- 不要根据轮次猜 speaker；只有能明确判断是当前主角色或用户本人说出口时才标记。',
        '- STV 标记必须成对出现，不要解释标记，不要把标记放到 <story_text> 之外。',
        '- 示例：[[STV:char]]“我知道。”[[/STV]] / [[STV:user]]“那就走吧。”[[/STV]]',
    ].join('\n');
};
