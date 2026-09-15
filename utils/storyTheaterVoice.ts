export type StoryVoiceSpeaker = 'char' | 'user';

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

const STORY_VOICE_PAIR_PATTERN = /\[\[STV:(char|user)\]\]([\s\S]*?)\[\[\/STV\]\]/gi;
const STORY_VOICE_MARKER_PATTERN = /\[\[STV:[^\]\r\n]{1,32}\]\]|\[\[\/STV\]\]/gi;

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
