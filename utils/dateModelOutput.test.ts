import { describe, expect, it } from 'vitest';
import {
    isDateHistoryEnvelopeOnly,
    sanitizeDateModelReply,
    stripDateHistoryEnvelope,
} from './dateModelOutput';

describe('date model output history-envelope guard', () => {
    it('drops the leaked first-line timestamp/source envelope seen in meeting UI', () => {
        const raw = '[2026-10-10 12:30] [约会]\n[normal] 他抬眼看过来。';
        expect(sanitizeDateModelReply(raw)).toBe('[normal] 他抬眼看过来。');
    });

    it('strips an envelope when the actual VN beat is on the same line', () => {
        expect(stripDateHistoryEnvelope('[2026-10-10 12:30] [约会] [happy] "来了。" [speaker:char]'))
            .toBe('[happy] "来了。" [speaker:char]');
    });

    it('recognizes every cross-mode source label but leaves normal VN tags alone', () => {
        expect(isDateHistoryEnvelopeOnly('[2026-10-10 12:30] [聊天]')).toBe(true);
        expect(isDateHistoryEnvelopeOnly('[通话]')).toBe(true);
        expect(isDateHistoryEnvelopeOnly('[家园]')).toBe(true);
        expect(isDateHistoryEnvelopeOnly('[剧情：共同经历]')).toBe(true);
        expect(isDateHistoryEnvelopeOnly('[normal]')).toBe(false);
        expect(stripDateHistoryEnvelope('[shy] "……嗯。" [speaker:user]')).toBe('[shy] "……嗯。" [speaker:user]');
    });
});
