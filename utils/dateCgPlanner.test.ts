import { describe, expect, it } from 'vitest';
import { buildMeetingSceneSummary } from './dateCgPlanner';

describe('date CG planner scene context', () => {
    it('prioritizes current meeting observation and keeps regenerate in the same scene', () => {
        const summary = buildMeetingSceneSummary({
            observation: {
                place: '咖啡馆靠窗座位',
                time: '傍晚',
                state: '亲近、放松',
                detail: '角色微微前倾，正看向用户',
            } as any,
            peekStatus: '不应覆盖观测',
            currentText: '不应覆盖观测',
            regenerate: true,
        });

        expect(summary).toContain('咖啡馆靠窗座位');
        expect(summary).toContain('角色微微前倾');
        expect(summary).toContain('保持同一场景');
        expect(summary).not.toContain('不应覆盖观测');
    });

    it('falls back to current meeting dialogue instead of unrelated chat history', () => {
        const summary = buildMeetingSceneSummary({
            currentText: '她把热饮推到用户面前',
            regenerate: false,
        });
        expect(summary).toContain('她把热饮推到用户面前');
    });
});
