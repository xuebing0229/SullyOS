import type { LocalBackgroundImageJob } from './backgroundImageJobs';

export type ImageJobCardStatus =
    | 'queued'
    | 'running'
    | 'saving'
    | 'completed'
    | 'failed';

export interface LocalImageJobCard {
    id: string;
    jobId?: string;
    clientRequestId: string;
    charId: string;
    toolName: string;
    engineLabel: 'GPT 生图' | 'NovelAI 生图';
    promptPreview: string;
    status: ImageJobCardStatus;
    sourceStatus: LocalBackgroundImageJob['status'];
    error?: string;
    createdAt: number;
    updatedAt: number;
    completedAt?: number;
    autoHideAfterMs?: number;
}

export const IMAGE_JOB_CARD_AUTO_HIDE_MS = 2_000;

const compact = (value: unknown): string =>
    String(value || '').replace(/\s+/g, ' ').trim();

export const imageJobPromptPreview = (
    args: Record<string, any>,
    maxLength = 48,
): string => {
    const source = compact(
        args.userRequest
        || args.requestSummary
        || args.prompt
        || args.description
        || args.tags,
    );
    if (!source) return '生成图片';
    return source.length > maxLength
        ? `${source.slice(0, maxLength).trimEnd()}…`
        : source;
};

export const imageJobCardStatus = (
    job: LocalBackgroundImageJob,
): ImageJobCardStatus => {
    if (job.status === 'failed' || job.status === 'cancelled') {
        return 'failed';
    }
    if (job.resultAppliedAt) return 'completed';
    if (job.status === 'succeeded') return 'saving';
    if (job.status === 'running') return 'running';
    return 'queued';
};

export const toImageJobCard = (
    job: LocalBackgroundImageJob,
): LocalImageJobCard => {
    const status = imageJobCardStatus(job);
    return {
        id: job.id,
        jobId: job.remoteJobId,
        clientRequestId: job.clientRequestId,
        charId: job.charId,
        toolName: job.toolName,
        engineLabel: job.engineId === 'novelai'
            ? 'NovelAI 生图'
            : 'GPT 生图',
        promptPreview: imageJobPromptPreview(job.toolArgs),
        status,
        sourceStatus: job.status,
        error: status === 'failed' ? job.lastError : undefined,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
        completedAt: job.resultAppliedAt,
        autoHideAfterMs: status === 'completed'
            ? IMAGE_JOB_CARD_AUTO_HIDE_MS
            : undefined,
    };
};

export const shouldHideImageJobCard = (
    card: LocalImageJobCard,
    at = Date.now(),
): boolean => card.status === 'completed'
    && Boolean(card.completedAt)
    && at >= (card.completedAt || 0)
        + (card.autoHideAfterMs || IMAGE_JOB_CARD_AUTO_HIDE_MS);

export const visibleImageJobCards = (
    jobs: LocalBackgroundImageJob[],
    charId: string,
    at = Date.now(),
): LocalImageJobCard[] => jobs
    .filter(job => job.charId === charId)
    .map(toImageJobCard)
    .filter(card => !shouldHideImageJobCard(card, at))
    .sort((a, b) => a.createdAt - b.createdAt);

export const isImageJobCardSelectable = (card: LocalImageJobCard): boolean =>
    card.sourceStatus === 'failed' || card.sourceStatus === 'cancelled';
