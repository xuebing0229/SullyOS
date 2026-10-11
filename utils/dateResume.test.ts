import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import type { DateState, Message } from '../types';
import { recoverDateStateFromHistory, resolveResumeEncounterId } from './dateResume';

const snapshot: DateState = {
    dialogueQueue: [],
    dialogueBatch: [],
    currentText: '还在咖啡馆',
    isNovelMode: false,
    timestamp: 100,
    peekStatus: '见面开场',
};
const message = (id: number, encounterId: string, timestamp: number): Message => ({
    id, charId: 'c1', role: 'assistant', type: 'text', content: '还有话要说',
    timestamp, metadata: { source: 'date', dateEncounterId: encounterId },
});

describe('见面恢复目标', () => {
    it('有存档场次时优先用存档，而不是错误接到另一场的最新消息', () => {
        expect(resolveResumeEncounterId({ ...snapshot, encounterId: 'old' }, [
            message(1, 'old', 100), message(2, 'new', 200),
        ])).toBe('old');
    });

    it('旧存档没有场次编号时从见面数据库定位最新场次', () => {
        expect(resolveResumeEncounterId(snapshot, [
            message(2, 'later', 200), message(1, 'earlier', 100),
        ])).toBe('later');
    });

    it('最新一场是无场次 ID 的旧记录时，不误连到更早的有标记场次', () => {
        const legacy = { ...message(3, 'ignored', 300), metadata: { source: 'date' } } as Message;
        expect(resolveResumeEncounterId(snapshot, [message(2, 'old', 200), legacy])).toBe('');
    });

    it('快照曾被旧版误清空，仍能从历史文字重建可继续的阅读会话', () => {
        const recovered = recoverDateStateFromHistory([
            message(20, 'second', 200), message(10, 'first', 100),
        ]);
        expect(recovered).toMatchObject({
            encounterId: 'second', isNovelMode: true, timestamp: 200,
            dialogueQueue: [], dialogueBatch: [],
        });
        expect(recovered?.currentText).toBe('');
        expect(recoverDateStateFromHistory([])).toBeNull();
    });

    it('没有场次 ID 的旧记录仍可进入历史阅读，不会清空正文', () => {
        const old = { ...message(1, 'unused', 100), metadata: { source: 'date' } } as Message;
        expect(recoverDateStateFromHistory([old])).toMatchObject({ isNovelMode: true });
        expect(resolveResumeEncounterId(snapshot, [old])).toBe('');
    });
});

describe('见面恢复 UI 合约', () => {
    const app = readFileSync('apps/DateApp.tsx', 'utf8');
    const session = readFileSync('components/date/DateSession.tsx', 'utf8');
    it('仅点击角色卡片不擦除存档；继续/新见面按钮分支互相独立', () => {
        const click = app.slice(app.indexOf('const handleCharClick ='), app.indexOf('const handleResumeMeeting ='));
        expect(click).toContain('setPendingResume(');
        expect(click).not.toContain('savedDateState: undefined');
        expect(app).toContain('继续上次见面？');
        expect(app).toContain('handleStartNewMeeting');
        expect(app).toContain('handleResumeMeeting');
        expect(app).toContain("setMode('entry')");
    });
    it('恢复时给 Session 传快照与场次 ID；新开场保留原三个选项', () => {
        expect(app).toContain('initialState={resumeState || undefined}');
        expect(app).toContain('encounterIdRef.current = restoredEncounterId');
        expect(session).toContain('encounterId: encounterId || undefined');
        expect(app).toContain('靠近他');
        expect(app).toContain('让他靠近');
        expect(app).toContain('直接见面');
        expect(app).toContain('armDateResumeAttempt');
    });
});
