import { describe, expect, it } from 'vitest';
import type { APIConfig, UserProfile } from '../types';
import { canSynthesizeSpeech, characterHasVoice } from './ttsRouter';
import { createUserVoiceTarget, USER_VOICE_TARGET_ID } from './userVoice';

describe('user voice target', () => {
  it('reuses the exact persisted user voice profile without copying API credentials', () => {
    const voiceProfile = { voiceId: 'user-voice', speed: 1.08, emotion: 'calm' };
    const user = { name: '我', avatar: 'avatar', bio: '', voiceProfile } as UserProfile;
    const target = createUserVoiceTarget(user);
    expect(target.id).toBe(USER_VOICE_TARGET_ID);
    expect(target.name).toBe('我');
    expect(target.voiceProfile).toBe(voiceProfile);
    expect((target as any).apiKey).toBeUndefined();
  });

  it('routes the user dialogue to the selected ElevenLabs voice without losing MiniMax settings', () => {
    const voiceProfile = {
      voiceId: 'my-minimax-id',
      model: 'speech-2.8-hd',
      elevenLabsVoiceId: 'https://elevenlabs.io/app/voice-library?voiceId=21m00Tcm4TlvDq8ikWAM',
    };
    const user = { name: '我', avatar: '', bio: '', voiceProfile } as UserProfile;
    const target = createUserVoiceTarget(user);
    const elevenConfig = {
      ttsProvider: 'elevenlabs',
      elevenLabsApiKey: 'test-elevenlabs-key',
    } as APIConfig;
    expect(target.voiceProfile?.voiceId).toBe('my-minimax-id');
    expect(target.voiceProfile?.elevenLabsVoiceId).toBe(voiceProfile.elevenLabsVoiceId);
    expect(characterHasVoice(target, elevenConfig)).toBe(true);
    expect(canSynthesizeSpeech(target, elevenConfig)).toBe(true);
    expect(characterHasVoice(target, { ...elevenConfig, ttsProvider: 'minimax' })).toBe(true);
    expect(canSynthesizeSpeech(target, { ...elevenConfig, elevenLabsApiKey: '' })).toBe(false);
  });
});
