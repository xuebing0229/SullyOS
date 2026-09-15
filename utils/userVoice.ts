import type { CharacterProfile, UserProfile } from '../types';

export const USER_VOICE_TARGET_ID = '__sully_user_voice__';

/**
 * TTS providers already consume CharacterProfile.voiceProfile. Keep one voice
 * schema instead of inventing a parallel user-only request shape.
 */
export const createUserVoiceTarget = (userProfile: UserProfile): CharacterProfile => ({
  id: USER_VOICE_TARGET_ID,
  name: String(userProfile.name || '我'),
  avatar: String(userProfile.avatar || ''),
  voiceProfile: userProfile.voiceProfile,
} as CharacterProfile);
