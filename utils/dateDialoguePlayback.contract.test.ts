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

    it('keeps HTMLAudio only as fallback and does not intentionally bleed 60ms into the next line', () => {
        expect(session).toContain('precise segment playback failed, falling back to HTMLAudio');
        expect(session).toContain("audio.addEventListener('seeked'");
        expect(session).not.toContain('(segment.endTime - segment.startTime) * 1000 + 60');
    });
});
