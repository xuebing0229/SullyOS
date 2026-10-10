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

    it('never seeks a shared MP3 with HTMLAudio timers when PCM decoding fails', () => {
        expect(session).toContain('PCM 切片不可用时返回 false');
        expect(session).not.toContain("audio.addEventListener('seeked'");
        expect(session).not.toContain('const durationMs = Math.max(40, (segment.endTime - segment.startTime) * 1000)');
        expect(session).toContain('const isCurrent = () =>');
        expect(session).toContain('if (!isCurrent()) return false;');
    });
});
