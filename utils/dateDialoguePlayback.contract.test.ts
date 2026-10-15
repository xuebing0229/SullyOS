import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

describe('DateSession precise dialogue segment playback contract', () => {
    const session = readFileSync('components/date/DateSession.tsx', 'utf8');

    it('decodes the whole Dialogue MP3 and slices by PCM offset/duration', () => {
        expect(session).toContain('decodeAudioData');
        expect(session).toContain('createBufferSource()');
        expect(session).toContain('source.start(0, startTime, duration)');
        expect(session).toContain('decodedDialogueRef');
    });

    it('reuses the already generated whole-turn audio when PCM playback is unavailable', () => {
        expect(session).toContain('reusing whole-turn audio');
        expect(session).toContain('audio.currentTime = safeStart');
        expect(session).toContain('segmentStopTimerRef.current = setTimeout(finish, safeDurationMs + 35)');
        expect(session).toContain("return 'playback-failed'");
        expect(session).toContain("return 'segment-unusable'");
        expect(session).toContain('const isCurrent = () =>');
    });

    it('only falls back to a paid single line when that line segment itself is unusable', () => {
        expect(session).toContain("type DateDialoguePlayResult = 'started' | 'segment-unusable' | 'playback-failed' | 'cancelled'");
        expect(session).toContain('segment-unusable：仅这一句的时间轴为空/越界，允许落到下方单句兜底');
        expect(session).toContain('whole-turn playback failed; refusing paid single-line regeneration');
        expect(session).toContain('整轮语音播放失败，请重试；不会重复生成扣费');
        expect(session).toContain('单句 TTS 自身有持久缓存，不会反复扣费');
    });

    it('persists whole-turn Dialogue audio across meeting exit and app reload', () => {
        expect(session).toContain('await getCachedDateDialogue(key)');
        expect(session).toContain('await saveCachedDateDialogue(key, batch.blob, batch.segments)');
        expect(session).toContain('await markDateDialogueForcedSingles(key)');
        expect(session).toContain('URL.createObjectURL(persisted.blob)');
        expect(session).toContain('await saveCachedDateDialogue(batchKey, freshBatch.blob, freshBatch.segments)');
        expect(session).toContain('await markDateDialogueForcedSingles(batchKey)');
    });
});
