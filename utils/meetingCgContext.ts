import type { Message } from '../types';

export interface MeetingCgContextOptions {
    userName: string;
    characterName: string;
    maxMessages?: number;
    maxCharsPerMessage?: number;
    maxTotalChars?: number;
}

function compact(value: string): string {
    return value
        .replace(/\s+/g, ' ')
        .trim();
}

function looksLikeImageResource(value: string): boolean {
    const normalized = value.trim();
    return (
        /^blobref:/i.test(normalized)
        || /^data:image\//i.test(normalized)
        || /^https?:\/\/\S+\.(?:png|jpe?g|gif|webp|avif)(?:[?#].*)?$/i
            .test(normalized)
    );
}

function transcriptFromMetadata(metadata: any): string {
    const values = [
        metadata?.transcript,
        metadata?.transcription,
        metadata?.voiceText,
        metadata?.voiceTranscript,
    ];
    const found = values.find(value =>
        typeof value === 'string'
        && value.trim(),
    );
    return found ? compact(found) : '';
}

export function meetingCgMessageText(
    message: Message | any,
): string {
    if (!message || !['user', 'assistant'].includes(message.role)) {
        return '';
    }

    const transcript = transcriptFromMetadata(message.metadata);
    if (transcript) return transcript;

    if (
        message.type === 'image'
        || message.metadata?.image === true
        || message.metadata?.visionImageDataUrl
    ) {
        return '[图片]';
    }

    const content = message.content;
    if (typeof content === 'string') {
        if (looksLikeImageResource(content)) return '[图片]';
        // 不把异常长的 data/blob 资源塞进提示词。
        if (/^(?:data:|blob:|content:|file:)/i.test(content.trim())) {
            return '[资源]';
        }
        return compact(content);
    }

    if (Array.isArray(content)) {
        return compact(content.map((part: any) => {
            if (part?.type === 'text') return part.text || '';
            if (part?.type === 'image_url' || part?.type === 'image') {
                return '[图片]';
            }
            return '';
        }).filter(Boolean).join(' '));
    }

    return '';
}

export function buildMeetingCgRecentContext(
    messages: Message[],
    options: MeetingCgContextOptions,
): string[] {
    const maxMessages = options.maxMessages ?? 3;
    const maxEach = options.maxCharsPerMessage ?? 300;
    const maxTotal = options.maxTotalChars ?? 1000;
    const result: string[] = [];
    let total = 0;

    for (let index = messages.length - 1; index >= 0; index--) {
        if (result.length >= maxMessages || total >= maxTotal) break;
        const message = messages[index];
        const text = meetingCgMessageText(message);
        if (!text) continue;

        const speaker = message.role === 'user'
            ? (options.userName || '用户')
            : (options.characterName || '角色');
        const remaining = maxTotal - total;
        const body = text.slice(0, Math.min(maxEach, remaining));
        if (!body) continue;
        const line = `${speaker}: ${body}`;
        result.push(line);
        total += body.length;
    }

    return result.reverse();
}
