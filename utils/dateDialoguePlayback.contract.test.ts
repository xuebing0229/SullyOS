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

    it('only falls back to a paid single line when Forced Alignment omitted that line', () => {
        expect(session).toContain("type DateDialoguePlayResult = 'started' | 'playback-failed' | 'cancelled'");
        expect(session).toContain('batch 存在但 segment 为 null = 这句在 Forced Alignment 阶段单独失败');
        expect(session).toContain('whole-turn playback failed; refusing paid single-line regeneration');
        expect(session).toContain('整轮语音播放失败，请重试；不会重复生成扣费');
        expect(session).toContain('batch 有、segment 无：只补这一句；单句 TTS 自身有持久缓存');
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
