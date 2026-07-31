import { describe, expect, it } from 'vitest';
import { getElevenLabsModel, normalizeTtsProvider, setElevenLabsModel } from './ttsProvider';

describe('ElevenLabs provider normalization', () => {
  it('accepts elevenlabs and preserves legacy defaults', () => {
    expect(normalizeTtsProvider('elevenlabs')).toBe('elevenlabs');
    expect(normalizeTtsProvider('fishaudio')).toBe('fishaudio');
    expect(normalizeTtsProvider('unknown')).toBe('minimax');
  });

  it('tracks the manually selected ElevenLabs model', () => {
    setElevenLabsModel('eleven_flash_v2_5');
    expect(getElevenLabsModel()).toBe('eleven_flash_v2_5');
    setElevenLabsModel('invalid');
    expect(getElevenLabsModel()).toBe('eleven_v3');
  });
});
