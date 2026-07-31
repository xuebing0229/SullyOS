import { describe, expect, it, vi } from 'vitest';
import type { APIConfig, CharacterProfile } from '../types';

vi.mock('./minimaxTts', () => ({ synthesizeSpeechDetailed: vi.fn(async () => ({ url: 'mini', blob: new Blob() })) }));
vi.mock('./fishAudioTts', () => ({ synthesizeSpeechFishDetailed: vi.fn(async () => ({ url: 'fish', blob: new Blob() })) }));
vi.mock('./elevenLabsTts', () => ({ synthesizeSpeechElevenLabsDetailed: vi.fn(async () => ({ url: 'eleven', blob: new Blob() })) }));

import { characterHasVoice, synthesizeSpeechDetailed } from './ttsRouter';

const config = (ttsProvider: APIConfig['ttsProvider']): APIConfig => ({ baseUrl: '', apiKey: '', model: '', ttsProvider });
const char = (voiceProfile: CharacterProfile['voiceProfile']): CharacterProfile => ({ id: 'c', name: 'C', avatar: '', systemPrompt: '', voiceProfile } as CharacterProfile);

describe('TTS router with ElevenLabs', () => {
  it('routes only to the manually selected provider', async () => {
    expect((await synthesizeSpeechDetailed('hello', char({ elevenLabsVoiceId: 'voice' }), config('elevenlabs'))).url).toBe('eleven');
  });

  it('checks provider-specific voice fields without fallback', () => {
    expect(characterHasVoice(char({ elevenLabsVoiceId: 'voice' }), config('elevenlabs'))).toBe(true);
    expect(characterHasVoice(char({ voiceId: 'mini' }), config('elevenlabs'))).toBe(false);
    expect(characterHasVoice(char({ fishReferenceId: 'fish' }), config('fishaudio'))).toBe(true);
    expect(characterHasVoice(char({ voiceId: 'mini' }), config('minimax'))).toBe(true);
  });
});