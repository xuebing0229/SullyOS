import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { createStoryTimingTrace, loadLastStoryTimingReport } from './storyTimingTrace';

beforeEach(() => localStorage.clear());
afterEach(() => { vi.restoreAllMocks(); localStorage.clear(); });

describe('story timing report', () => {
    it('records successive client stages, parallel spans and successful Worker telemetry without content', async () => {
        let tick = 0;
        vi.spyOn(performance, 'now').mockImplementation(() => tick);
        const reports: unknown[] = [];
        const trace = createStoryTimingTrace(report => reports.push(report));
        tick = 40;
        trace.mark('准备任务');
        tick = 55;
        await trace.measure('测试检索', async () => { tick = 110; return 'sensitive output'; });
        tick = 180;
        trace.mark('收到首字');
        trace.worker({ queueMs: 25, headerMs: 18, firstTextMs: 64, apiKey: 'secret', prompt: 'secret' });
        trace.finish('已完成');
        const saved = loadLastStoryTimingReport()!;
        expect(saved.stages).toEqual([
            { label: '准备任务', ms: 40 },
            { label: '收到首字', ms: 140 },
        ]);
        expect(saved.details).toEqual([{ label: '测试检索', ms: 55 }]);
        expect(saved.worker).toEqual({ queueMs: 25, headerMs: 18, firstTextMs: 64 });
        expect(saved.status).toBe('已完成');
        expect(saved.totalMs).toBe(180);
        expect(reports.length).toBeGreaterThan(3);
        const persisted = localStorage.getItem('sully_story_timing_last_v1')!;
        expect(persisted).not.toContain('secret');
        expect(persisted).not.toContain('sensitive output');
    });

    it('refuses negative, invalid and unsupported server fields', () => {
        const trace = createStoryTimingTrace();
        trace.detail('valid', 2.5);
        trace.detail('invalid', Number.NaN);
        trace.worker({ queueMs: -1, firstByteMs: 5, modelId: 'secret', fetchDuration: 11 });
        const saved = loadLastStoryTimingReport()!;
        expect(saved.details).toEqual([{ label: 'valid', ms: 3 }]);
        expect(saved.worker).toEqual({ firstByteMs: 5 });
    });
});
