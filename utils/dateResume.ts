import type { DateState, Message } from '../types';

/** 最新一场见面的定位信息以快照为准；旧快照没有记录场次时从消息库补回。 */
export const resolveResumeEncounterId = (
    state: DateState,
    messages: Message[],
): string => {
    if (typeof state.encounterId === 'string' && state.encounterId.trim()) {
        return state.encounterId;
    }
    const latest = [...messages]
        .filter(message => message.metadata?.source === 'date')
        .sort((a, b) => b.timestamp - a.timestamp || b.id - a.id)
        .find(message => typeof message.metadata?.dateEncounterId === 'string' && message.metadata.dateEncounterId);
    return typeof latest?.metadata?.dateEncounterId === 'string' ? latest.metadata.dateEncounterId : '';
};

/**
 * 旧版误清除 savedDateState 后，正文仍在独立的 date 消息记录里。
 * 只恢复到历史阅读模式，不伪造原本的 CG、播放进度或气泡位置。
 */
export const recoverDateStateFromHistory = (messages: Message[]): DateState | null => {
    const sorted = [...messages]
        .filter(message => message.metadata?.source === 'date')
        .sort((a, b) => a.timestamp - b.timestamp || a.id - b.id);
    const last = sorted[sorted.length - 1];
    if (!last) return null;
    const encounterId = typeof last.metadata?.dateEncounterId === 'string'
        ? last.metadata.dateEncounterId : '';
    return {
        dialogueQueue: [],
        dialogueBatch: [],
        currentText: '',
        isNovelMode: true,
        timestamp: last.timestamp,
        peekStatus: '',
        ...(encounterId ? { encounterId } : {}),
    };
};
