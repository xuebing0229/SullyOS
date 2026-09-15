import { describe, expect, it } from 'vitest';
import type { UserProfile } from '../types';
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
});
