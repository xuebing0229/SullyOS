export type MeetingCgEngine = 'gpt' | 'novelai';
export interface MeetingCgBackground {
    imageUrl: string;
    imageMessageId?: number;
    galleryImageId?: string;
    engine: MeetingCgEngine;
    promptSummary?: string;
    createdAt: number;
}

export interface CharacterLite {
    id: string;
    name: string;
    appearance?: string;
    systemPrompt?: string;
    description?: string;
}

export interface MeetingContextLite {
    scene?: string;
    mood?: string;
    location?: string;
    timeLabel?: string;
    weather?: string;
    lastMessages?: string[];
}

export interface BuiltinImageAvailability {
    gptEnabled: boolean;
    novelaiEnabled: boolean;
    preferred?: MeetingCgEngine | null;
}

export interface ResolvedMeetingCgEngine {
    engine: MeetingCgEngine;
    reason: 'explicit' | 'preferred' | 'fallback';
}

export interface BuiltMeetingCgPrompt {
    prompt: string;
    summary: string;
}
export async function prepareMeetingCgArguments<T extends Record<string, any>>(
    engine: MeetingCgEngine,
    rawArgs: T,
    prepareNovelAi: (args: T) => Promise<T>,
): Promise<T> {
    return engine === 'novelai' ? prepareNovelAi(rawArgs) : rawArgs;
}

export function resolveMeetingCgEngine(
    availability: BuiltinImageAvailability,
    requested?: MeetingCgEngine | null,
): ResolvedMeetingCgEngine {
    const gpt = Boolean(availability.gptEnabled);
    const novelai = Boolean(availability.novelaiEnabled);

    if (!gpt && !novelai) {
        throw new Error('未启用可用的生图引擎，请先在设置中开启 GPT 或 NovelAI。');
    }

    if (requested) {
        if (requested === 'gpt' && !gpt) throw new Error('GPT 生图当前未启用。');
        if (requested === 'novelai' && !novelai) throw new Error('NovelAI 生图当前未启用。');
        return { engine: requested, reason: 'explicit' };
    }

    const preferred = availability.preferred || null;
    if (preferred === 'gpt' && gpt) return { engine: 'gpt', reason: 'preferred' };
    if (preferred === 'novelai' && novelai) return { engine: 'novelai', reason: 'preferred' };

    if (gpt) return { engine: 'gpt', reason: 'fallback' };
    return { engine: 'novelai', reason: 'fallback' };
}

function cleanOneLine(value?: string): string {
    return (value || '').replace(/\s+/g, ' ').trim();
}

function summarizeMessages(messages?: string[]): string {
    const normalized = (messages || [])
        .map(text => cleanOneLine(text))
        .filter(Boolean)
        .slice(-3);
    return normalized.join(' | ');
}

export function buildMeetingCgPrompt(
    engine: MeetingCgEngine,
    character: CharacterLite | null | undefined,
    context: MeetingContextLite,
    regenerate = false,
): BuiltMeetingCgPrompt {
    if (!character?.id || !cleanOneLine(character.name)) {
        throw new Error('当前见面没有关联角色，无法生成见面 CG。');
    }

    const appearance = cleanOneLine(character.appearance || character.description || '');
    const scene = cleanOneLine(context.scene || context.location || 'a private meeting scene');
    const mood = cleanOneLine(context.mood || 'gentle and intimate');
    const timeLabel = cleanOneLine(context.timeLabel || '');
    const weather = cleanOneLine(context.weather || '');
    const recent = summarizeMessages(context.lastMessages);

    const summaryParts = [
        character.name,
        cleanOneLine(scene),
        cleanOneLine(mood),
        timeLabel && `时间:${timeLabel}`,
        weather && `天气:${weather}`,
    ].filter(Boolean) as string[];

    const commonLines = [
        'Create a vertical CG illustration for an in-app "meeting mode" background.',
        `Main character: ${character.name}.`,
        appearance ? `Appearance cues: ${appearance}.` : '',
        `Scene: ${scene}.`,
        `Mood: ${mood}.`,
        timeLabel ? `Time: ${timeLabel}.` : '',
        weather ? `Weather: ${weather}.` : '',
        recent ? `Recent chat context: ${recent}.` : '',
        regenerate ? 'Create a fresh new variation instead of repeating the last image.' : '',
        'Requirements:',
        '- portrait / vertical composition',
        '- suitable as a meeting-mode background for a mobile app',
        '- clear main subject and readable composition',
        '- cinematic CG feeling',
        '- leave some cleaner negative space for UI overlays',
        '- no text, no speech bubbles, no watermark, no UI elements',
    ].filter(Boolean) as string[];

    if (engine === 'novelai') {
        return {
            summary: summaryParts.join(' · '),
            prompt: [
                `${character.name}, ${appearance || 'solo'}, ${scene}, ${mood}, visual novel CG, high detail, beautiful lighting`,
                commonLines.join('\n'),
            ].join('\n\n'),
        };
    }

    return {
        summary: summaryParts.join(' · '),
        prompt: commonLines.join('\n'),
    };
}

export function getMeetingCgButtonLabel(
    hasMeetingCgBackground: boolean,
    isGenerating: boolean,
): string {
    if (isGenerating) return '生成中…';
    return hasMeetingCgBackground ? '重刷' : '生成CG';
}

export function makeMeetingCgBackground(input: {
    imageUrl: string;
    engine: MeetingCgEngine;
    imageMessageId?: number;
    galleryImageId?: string;
    promptSummary?: string;
    createdAt?: number;
}): MeetingCgBackground {
    return {
        imageUrl: input.imageUrl,
        imageMessageId: input.imageMessageId,
        galleryImageId: input.galleryImageId,
        engine: input.engine,
        promptSummary: input.promptSummary,
        createdAt: input.createdAt ?? Date.now(),
    };
}

export interface NormalizedMcpImageResult {
    imageUrl: string;
    promptSummary?: string;
}

/**
 * 兼容常见 MCP 返回：
 * - structuredContent.imageUrl
 * - structuredContent.url
 * - data[0].url
 * - textual JSON string
 */
export function normalizeMcpImageResult(result: any): NormalizedMcpImageResult {
    const direct = result?.structuredContent?.imageUrl
        || result?.structuredContent?.url
        || result?.imageUrl
        || result?.url
        || result?.data?.[0]?.url;

    if (typeof direct === 'string' && direct.trim()) {
        return {
            imageUrl: direct.trim(),
            promptSummary: result?.structuredContent?.promptSummary || undefined,
        };
    }

    const text = result?.content?.find?.((item: any) => item?.type === 'text')?.text
        || result?.content?.[0]?.text;

    if (typeof text === 'string' && text.trim()) {
        try {
            const parsed = JSON.parse(text);
            const parsedUrl = parsed?.imageUrl || parsed?.url || parsed?.data?.[0]?.url;
            if (typeof parsedUrl === 'string' && parsedUrl.trim()) {
                return {
                    imageUrl: parsedUrl.trim(),
                    promptSummary: parsed?.promptSummary || undefined,
                };
            }
        } catch {
            // ignore
        }
    }

    throw new Error('生图已返回，但未解析到图片结果。');
}
