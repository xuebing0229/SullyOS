import { describe, expect, it } from 'vitest';
import type { LocalBackgroundImageJob } from './backgroundImageJobs';
import {
    IMAGE_JOB_CARD_AUTO_HIDE_MS,
    imageJobPromptPreview,
    isImageJobCardSelectable,
    toImageJobCard,
    visibleImageJobCards,
} from './imageJobCards';

const makeJob = (
    patch: Partial<LocalBackgroundImageJob> = {},
): LocalBackgroundImageJob => ({
    id: 'local-1',
    clientRequestId: 'client-1',
    remoteJobId: 'remote-1',
    engineId: 'gpt-image',
    serverId: 'builtin_image_gpt-image',
    serverName: 'GPT 生图',
    controlBaseUrl: 'https://example.test/gpt-image',
    token: 'secret',
    charId: 'char-1',
    toolName: 'generate_image',
    toolArgs: { prompt: '一只站在月光下的白色小猫，电影感，超长提示词用于测试截断' },
    afterGenerateAction: 'none',
    status: 'queued',
    createdAt: 100,
    updatedAt: 100,
    submitAttempts: 1,
    ...patch,
});

describe('imageJobCards', () => {
    it('maps queued -> running -> saving -> completed and auto hides', () => {
        expect(toImageJobCard(makeJob()).status).toBe('queued');
        expect(toImageJobCard(makeJob({ status: 'running' })).status).toBe('running');
        expect(toImageJobCard(makeJob({ status: 'succeeded' })).status).toBe('saving');

        const completedAt = 1_000;
        const completed = makeJob({
            status: 'succeeded',
            resultAppliedAt: completedAt,
            updatedAt: completedAt,
        });
        expect(toImageJobCard(completed).status).toBe('completed');
        expect(visibleImageJobCards([completed], 'char-1', completedAt + 100)).toHaveLength(1);
        expect(visibleImageJobCards(
            [completed],
            'char-1',
            completedAt + IMAGE_JOB_CARD_AUTO_HIDE_MS,
        )).toHaveLength(0);
    });

    it('maps failed/cancelled to a sanitized UI failure state', () => {
        const failed = toImageJobCard(makeJob({
            status: 'failed',
            lastError: '上游生成失败',
        }));
        expect(failed.status).toBe('failed');
        expect(failed.error).toBe('上游生成失败');
        expect(toImageJobCard(makeJob({ status: 'cancelled' })).status).toBe('failed');
    });

    it('only exposes cards for the current character, independently of messages', () => {
        const cards = visibleImageJobCards([
            makeJob({ id: 'a', charId: 'char-1' }),
            makeJob({ id: 'b', charId: 'char-2' }),
        ], 'char-1', 100);
        expect(cards.map(card => card.id)).toEqual(['a']);
        expect(cards[0]).not.toHaveProperty('role');
        expect(cards[0]).not.toHaveProperty('content');
    });

    it('builds a short preview without negative prompt or full JSON', () => {
        const preview = imageJobPromptPreview({
            prompt: 'portrait '.repeat(20),
            undesired_content: 'long negative prompt',
        }, 30);
        expect(preview.length).toBeLessThanOrEqual(31);
        expect(preview).not.toContain('negative');
        expect(imageJobPromptPreview({})).toBe('生成图片');
    });

    it('only allows failed and cancelled source jobs to enter selection', () => {
        expect(isImageJobCardSelectable(toImageJobCard(makeJob({ status: 'failed' })))).toBe(true);
        expect(isImageJobCardSelectable(toImageJobCard(makeJob({ status: 'cancelled' })))).toBe(true);
        expect(isImageJobCardSelectable(toImageJobCard(makeJob({ status: 'queued' })))).toBe(false);
        expect(isImageJobCardSelectable(toImageJobCard(makeJob({ status: 'running' })))).toBe(false);
        expect(isImageJobCardSelectable(toImageJobCard(makeJob({ status: 'succeeded' })))).toBe(false);
        expect(isImageJobCardSelectable(toImageJobCard(makeJob({ status: 'succeeded', resultAppliedAt: 10 })))).toBe(false);
    });

});