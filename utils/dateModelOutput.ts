/**
 * 见面模型输出的轻量防泄漏清洗。
 *
 * ChatPrompts 的历史为了跨模式连贯，会给每条记录加
 * [YYYY-MM-DD HH:mm] [聊天/约会/通话/家园/剧情：...] 包络。
 * 少数模型会在 VN 正文第一行照抄这个包络；它不是剧情内容，
 * 不能进入气泡，也不能再次写回历史形成自我模仿。
 */

const HISTORY_TIME_PREFIX = String.raw`\[\d{4}-\d{1,2}-\d{1,2}(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?\]`;
const HISTORY_SOURCE_PREFIX = String.raw`\[(?:聊天|约会|通话|家园|剧情(?:：|:)[^\]]+)\]`;
const HISTORY_ENVELOPE_RE = new RegExp(
    String.raw`^\s*(?:${HISTORY_TIME_PREFIX}\s*)?(?:${HISTORY_SOURCE_PREFIX})\s*`,
    'i',
);
const BARE_TIME_RE = new RegExp(String.raw`^\s*${HISTORY_TIME_PREFIX}\s*$`, 'i');

export const stripDateHistoryEnvelope = (line: string): string => {
    let output = String(line || '');
    // 有些中转/模型会重复两次来源包络，循环剥掉开头的历史元信息。
    for (let i = 0; i < 3; i++) {
        const next = output.replace(HISTORY_ENVELOPE_RE, '');
        if (next === output) break;
        output = next;
    }
    return output.trim();
};

export const isDateHistoryEnvelopeOnly = (line: string): boolean => {
    const raw = String(line || '').trim();
    if (!raw) return false;
    if (BARE_TIME_RE.test(raw)) return true;
    return stripDateHistoryEnvelope(raw) === '';
};

export const sanitizeDateModelReply = (text: string): string => {
    if (!text) return '';
    const lines = String(text).split(/\r?\n/);
    const cleaned: string[] = [];

    for (const rawLine of lines) {
        if (isDateHistoryEnvelopeOnly(rawLine)) continue;
        const stripped = stripDateHistoryEnvelope(rawLine);
        cleaned.push(stripped || rawLine.trim());
    }

    return cleaned.join('\n')
        .replace(/^\s+|\s+$/g, '')
        .replace(/\n{3,}/g, '\n\n');
};
