import type { APIConfig, ApiPreset, StoryTheaterEntry } from '../types';
import { executeOpenAiChatPlan, resolveApiExecutionPlan } from './apiFailover';
import {
    VALID_EMOTIONS,
    VALID_INTERJECTION_TAGS,
    VOICE_ACTING_GUIDE,
    cleanVoiceMarkupForDisplay,
} from './minimaxTts';
import { extractContent } from './safeApi';
import {
    extractStoryVoiceDialogues,
    type StoryVoiceActing,
    type StoryVoiceDialogueSpeaker,
} from './storyTheaterVoice';

export const resolveStoryVoiceDirectorApiConfig = (
    entry: StoryTheaterEntry,
    fallbackApi: APIConfig,
    presets: ApiPreset[],
): APIConfig | undefined => {
    const presetId = String(entry.storyVoiceDirectorApiPresetId || '').trim();
    if (!presetId) return undefined;
    const preset = presets.find(item => item.id === presetId);
    if (!preset) return undefined;
    const model = String(entry.storyVoiceDirectorModel || '').trim() || preset.config.model;
    return {
        ...fallbackApi,
        ...preset.config,
        model,
        stream: false,
    };
};

const stripOuterDialogueQuotes = (value: string): string => {
    const text = String(value || '').trim();
    return text.startsWith('「') && text.endsWith('」') ? text.slice(1, -1) : text;
};

const sameVisibleWords = (candidate: string, source: string): boolean => {
    const left = stripOuterDialogueQuotes(cleanVoiceMarkupForDisplay(candidate)).replace(/\s+/g, '');
    const right = stripOuterDialogueQuotes(cleanVoiceMarkupForDisplay(source)).replace(/\s+/g, '');
    return Boolean(left) && left === right;
};

const parseJsonObject = (value: string): any => {
    const source = String(value || '').trim().replace(/^\`\`\`(?:json)?\s*/i, '').replace(/\s*\`\`\`$/i, '');
    const first = source.indexOf('{');
    const last = source.lastIndexOf('}');
    if (first < 0 || last <= first) throw new Error('情绪导演没有返回 JSON');
    return JSON.parse(source.slice(first, last + 1));
};

export const mergeStoryVoiceDirectorResponse = (
    rawResponse: string,
    dialogues: string[],
    speakers: StoryVoiceDialogueSpeaker[],
    currentActing: Array<StoryVoiceActing | null>,
): Array<StoryVoiceActing | null> => {
    const next = Array.from({ length: dialogues.length }, (_, index) => currentActing[index] ?? null);
    const data = parseJsonObject(rawResponse);
    const items = Array.isArray(data?.items) ? data.items : [];
    for (const raw of items) {
        const index = Number(raw?.index);
        if (!Number.isInteger(index) || index < 0 || index >= dialogues.length) continue;
        const speaker = speakers[index];
        if (speaker !== 'char' && speaker !== 'user') continue;
        if (next[index]?.emotion) continue;

        const emotion = String(raw?.emotion || '').trim().toLowerCase();
        if (!VALID_EMOTIONS.has(emotion)) continue;
        const candidate = String(raw?.speech || '').trim();
        const speech = candidate && sameVisibleWords(candidate, dialogues[index])
            ? candidate
            : (next[index]?.speech || dialogues[index]);
        next[index] = { speech, emotion };
    }
    return next;
};

interface DirectMissingStoryVoiceActingInput {
    apiConfig: APIConfig;
    content: string;
    previousContext?: string;
    characterName: string;
    userName: string;
    speakers: StoryVoiceDialogueSpeaker[];
    currentActing: Array<StoryVoiceActing | null>;
}

export const directMissingStoryVoiceActing = async (
    input: DirectMissingStoryVoiceActingInput,
): Promise<Array<StoryVoiceActing | null>> => {
    const dialogues = extractStoryVoiceDialogues(input.content);
    if (!dialogues.length) return input.currentActing;

    const missing = dialogues.flatMap((dialogue, index) => {
        const speaker = input.speakers[index];
        const acting = input.currentActing[index];
        if ((speaker !== 'char' && speaker !== 'user') || acting?.emotion) return [];
        return [{
            index,
            speaker,
            speakerName: speaker === 'char' ? input.characterName : input.userName,
            dialogue,
            existingSpeech: acting?.speech || '',
        }];
    });
    if (!missing.length) return input.currentActing;

    const emotionValues = Array.from(VALID_EMOTIONS).join(', ');
    const interjectionValues = Array.from(VALID_INTERJECTION_TAGS).join(', ');
    const prompt = [
        '你是文游 TTS 的“情绪导演”。只处理下面列出的缺失演绎对白，不续写剧情。',
        '任务：结合当前正文和上一小段上下文，为每句对白选择一个标准 emotion，并在需要时给 speech 加少量停顿 <#秒数#> / 合法 sound tag。',
        '硬规则：绝对不能增删、替换或改写任何实际要说的文字；只能插入演绎标记。不要改变人物意图。',
        `emotion 只能是：${emotionValues}`,
        `sound tag 只能从这些值里选：${interjectionValues}`,
        '输出必须是严格 JSON，不要 Markdown、不要解释：{"items":[{"index":0,"emotion":"sad","speech":"原对白，只插演绎标记"}]}',
        '每个输入 index 都必须返回一次；emotion 必填。speech 可以沿用 existingSpeech，也可以在原对白上插入演绎标记。',
        '',
        VOICE_ACTING_GUIDE,
        '',
        '【上一小段上下文】',
        String(input.previousContext || '').slice(-6000) || '（无）',
        '',
        '【当前正文】',
        String(input.content || '').slice(-12000),
        '',
        '【需要补判的对白】',
        JSON.stringify(missing),
    ].join('\n');

    const plan = resolveApiExecutionPlan('story', input.apiConfig, false);
    const result = await executeOpenAiChatPlan({
        plan,
        body: {
            model: input.apiConfig.model,
            stream: false,
            temperature: 0.2,
            messages: [{ role: 'user', content: prompt }],
        },
        directMaxRetries: 1,
        directTimeoutMs: 45_000,
    });
    const raw = extractContent(result.value).trim();
    if (!raw) throw new Error('情绪导演返回为空');
    return mergeStoryVoiceDirectorResponse(raw, dialogues, input.speakers, input.currentActing);
};
