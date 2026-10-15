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
        expect(session).toContain('只有整轮合成本身失败时，调用方才允许进入逐句合成链路');
        expect(session).toContain('const isCurrent = () =>');
        expect(session).toContain('if (!isCurrent()) return false;');
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
