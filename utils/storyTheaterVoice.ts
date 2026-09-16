export type StoryVoiceSpeaker = 'char' | 'user';
export type StoryDialogueRole = StoryVoiceSpeaker | 'npc' | 'quote';
export type StoryVoiceDialogueSpeaker = StoryDialogueRole | null;

type StorySpokenRole = Exclude<StoryDialogueRole, 'quote'>;

export interface StoryVoiceSpan {
    speaker: StorySpokenRole;
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
const STORY_DIALOGUE_PATTERN = /(「[^」\n]*」|『[^』\n]*』|“[^”\n]*”|‘[^’\n]*’|"[^"\n]*")/g;

/**
 * Speaker metadata is transport-only. It must never be rendered, copied, exported,
 * archived, sent to image planning, or forwarded into later story prompts.
 */
export const stripStoryVoiceMarkup = (value: string): string => (
    String(value || '').replace(STORY_VOICE_MARKER_PATTERN, '')
);

/** Remove hidden STV tags while retaining their positions in the clean text. */
export const parseStoryVoiceMarkup = (value: string): ParsedStoryVoiceMarkup => {
    const source = String(value || '');
    const spans: StoryVoiceSpan[] = [];
    let cleanText = '';
    let cursor = 0;

    STORY_VOICE_PAIR_PATTERN.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = STORY_VOICE_PAIR_PATTERN.exec(source))) {
        cleanText += stripStoryVoiceMarkup(source.slice(cursor, match.index));

        const speaker = String(match[1] || match[2]).toLowerCase() as StorySpokenRole;
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
    let best: { speaker: StorySpokenRole; overlap: number } | undefined;
    for (const span of spans) {
        // Preferred form is [[STV:user]]“...”[[/STV]], but some models put the
        // hidden marker just inside the quotation marks. Positive overlap is enough.
        const overlap = Math.min(end, span.end) - Math.max(start, span.start);
        if (overlap <= 0) continue;
        if (!best || overlap > best.overlap) best = { speaker: span.speaker, overlap };
    }
    return best?.speaker ?? null;
};

/**
 * Every quote-like span consumes one stable ordinal slot. STV marks actual spoken
 * lines as char/user/npc. Untagged spans stay null until the semantic classifier
 * decides whether they are spoken dialogue or merely quoted text/reference.
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
        '### 文游对白语义隐藏标记（仅作用于 <story_text> 主正文）',
        '- 保持原有正文与三色格式完全不变；这些标记只用于内部判断“是否真的说出口”以及说话人。',
        `- ${characterName} 真实说出口的对白：在整段对白外包 [[STV:char]]...[[/STV]]。`,
        `- ${userName} 真实说出口的对白：在整段对白外包 [[STV:user]]...[[/STV]]。`,
        '- NPC、路人、其他人物真实说出口的对白：在整段对白外包 [[STV:npc]]...[[/STV]]。NPC 只用于对白样式，不会配音。',
        '- 引号里的专有名词、术语、标题、代号、引用原文、转述片段等，只是“被引用的文字”而不是现场说出口的对白时，绝对不要加 STV。',
        '- 不要求正文必须出现“说、问、开口、低声道”等发言动词。根据上下文、动作承接、对话轮次、回应关系判断是否真实发言；发言动词只是证据之一，不是必要条件。',
        '- STV 标记必须放在整句引号外侧，例如 [[STV:user]]“那就走吧。”[[/STV]]；不要写成 “[[STV:user]]那就走吧。[[/STV]]”。',
        '- 旁白、动作、环境描写、心理活动绝对不要添加 STV 标记。',
        '- 不要仅凭“有引号”就判断为对白，也不要仅凭轮次猜 speaker。',
        '- STV 标记必须成对出现，不要解释标记，不要把标记放到 <story_text> 之外。',
        '- 示例：[[STV:char]]“我知道。”[[/STV]] / [[STV:user]]“那就走吧。”[[/STV]] / [[STV:npc]]“请出示凭证。”[[/STV]]；“金环”作为专名则不加 STV。',
    ].join('\n');
};
