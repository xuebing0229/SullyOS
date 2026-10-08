/** Private timing-only diagnostics for a story turn (no prompts, URLs or credentials). */
export interface StoryTimingReport {
    startedAt: number;
    totalMs: number;
    status: string;
    stages: Array<{ label: string; ms: number }>;
    details: Array<{ label: string; ms: number }>;
    worker?: Record<string, number>;
}

const STORAGE_KEY = 'sully_story_timing_last_v1';
const finiteMs = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.round(value) : null;

export function loadLastStoryTimingReport(): StoryTimingReport | null {
    try {
        const value = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
        return value && Array.isArray(value.stages) && Array.isArray(value.details) ? value as StoryTimingReport : null;
    } catch { return null; }
}

export const createStoryTimingTrace = (onUpdate?: (report: StoryTimingReport) => void) => {
    const startedAt = Date.now();
    const origin = performance.now();
    let last = origin;
    const report: StoryTimingReport = {
        startedAt, totalMs: 0, status: '生成中',
        stages: [], details: [],
    };
    const save = () => {
        report.totalMs = Math.round(performance.now() - origin);
        const snapshot: StoryTimingReport = {
            ...report,
            stages: [...report.stages],
            details: [...report.details],
            ...(report.worker ? { worker: { ...report.worker } } : {}),
        };
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot)); } catch { /* best effort */ }
        onUpdate?.(snapshot);
    };
    save();
    const mark = (label: string) => {
        const current = performance.now();
        report.stages.push({ label, ms: Math.max(0, Math.round(current - last)) });
        last = current;
        save();
    };
    const detail = (label: string, ms: number) => {
        const value = finiteMs(ms);
        if (value === null) return;
        report.details.push({ label, ms: value });
        save();
    };
    const measure = async <T>(label: string, work: () => Promise<T>): Promise<T> => {
        const t0 = performance.now();
        try { return await work(); }
        finally { detail(label, performance.now() - t0); }
    };
    const worker = (value: unknown) => {
        if (!value || typeof value !== 'object') return;
        const timings: Record<string, number> = {};
        for (const [key, duration] of Object.entries(value)) {
            const ms = finiteMs(duration);
            if (ms !== null && /^[a-zA-Z]+Ms$/.test(key)) timings[key] = ms;
        }
        report.worker = timings;
        save();
    };
    const finish = (status: string) => {
        report.status = status;
        report.totalMs = Math.round(performance.now() - origin);
        save();
        // App 日志可以搜 StoryTiming；仅输出时间数字，不输出任何正文/密钥。
        console.info('[StoryTiming] ' + JSON.stringify(report));
    };
    return { mark, detail, measure, worker, finish };
};
