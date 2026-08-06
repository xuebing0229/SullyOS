export type MeetingCgEngine = 'gpt' | 'novelai';

/**
 * Independent Date/Meeting CG asset. New assets never use imageMessageId;
 * the optional legacy field only keeps old saved snapshots readable.
 */
export interface MeetingCgBackground {
    id: string;
    imageUrl: string;
    imageMessageId?: number;
    galleryImageId?: string;
    engine: MeetingCgEngine;
    source?: 'date-cg-planner' | 'legacy-meeting-cg';
    promptSummary?: string;
    createdAt: number;
}

export function getMeetingCgButtonLabel(
    hasMeetingCgBackground: boolean,
    isGenerating: boolean,
): string {
    if (isGenerating) return '生成中…';
    return hasMeetingCgBackground ? '重绘 CG' : '生成 CG';
}

export function makeMeetingCgBackground(input: {
    id?: string;
    imageUrl: string;
    engine: MeetingCgEngine;
    imageMessageId?: number;
    galleryImageId?: string;
    promptSummary?: string;
    source?: 'date-cg-planner' | 'legacy-meeting-cg';
    createdAt?: number;
}): MeetingCgBackground {
    const createdAt = input.createdAt ?? Date.now();
    return {
        id: input.id || `meeting_cg_${createdAt.toString(36)}`,
        imageUrl: input.imageUrl,
        imageMessageId: input.imageMessageId,
        galleryImageId: input.galleryImageId,
        engine: input.engine,
        source: input.source || (input.imageMessageId ? 'legacy-meeting-cg' : 'date-cg-planner'),
        promptSummary: input.promptSummary,
        createdAt,
    };
}
