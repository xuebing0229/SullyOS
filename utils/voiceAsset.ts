import type { APIConfig, CharacterProfile } from '../types';
import { DB } from './db';
import { synthesizeSpeechDetailed } from './ttsRouter';

/**
 * Persisted TTS asset shared by chat and story dialogue.
 * Audio lives in the existing IndexedDB `assets` store; this is only a stable
 * binding from a concrete UI/message segment to already-generated audio.
 */
export interface StoredVoiceAsset {
  blob?: Blob;
  remoteUrl?: string;
  favorite?: boolean;
  /** Exact source text this concrete asset is bound to. Text edits invalidate it. */
  originalText: string;
  /** Optional display subtitle after provider-specific voice markup is stripped. */
  spokenText?: string;
  lang?: string;
}

export interface VoiceAssetPlayback {
  key: string;
  url: string;
  blob: Blob | null;
  stored: StoredVoiceAsset;
  /** True only when this call performed a new paid/provider synthesis. */
  generated: boolean;
}

export interface EnsureVoiceAssetOptions {
  key: string;
  /** Exact text binding for edit invalidation and synthesis. */
  text: string;
  char: CharacterProfile;
  apiConfig: APIConfig;
  languageBoost?: string;
  groupId?: string;
  emotion?: string;
  spokenText?: string;
  lang?: string;
  /** Explicit refresh. Existing audio is kept until replacement succeeds. */
  force?: boolean;
}

export const chatVoiceAssetKey = (messageId: number): string => `voice_msg_${messageId}`;

export const storyVoiceAssetKey = (
  storyId: string,
  messageId: number,
  dialogueIndex: number,
): string => `voice_story_${storyId}_${messageId}_${dialogueIndex}`;

export const loadPersistedVoiceAsset = async (key: string): Promise<StoredVoiceAsset | null> => {
  const value = await DB.getAssetRaw(key) as StoredVoiceAsset | null;
  if (!value || typeof value !== 'object') return null;
  if (!(value.blob instanceof Blob) && !value.remoteUrl) return null;
  return value;
};

export const savePersistedVoiceAsset = async (
  key: string,
  asset: StoredVoiceAsset,
): Promise<void> => {
  await DB.saveAssetRaw(key, asset);
};

export const deletePersistedVoiceAsset = async (key: string): Promise<void> => {
  await DB.deleteAsset(key);
};

/**
 * Materialize a persisted asset into something <audio> can play.
 * Blob URLs belong to the caller and must be revoked when no longer needed.
 */
export const materializePersistedVoiceAsset = (
  key: string,
  stored: StoredVoiceAsset,
): VoiceAssetPlayback | null => {
  if (stored.blob instanceof Blob) {
    return {
      key,
      url: URL.createObjectURL(stored.blob),
      blob: stored.blob,
      stored,
      generated: false,
    };
  }
  if (stored.remoteUrl) {
    return {
      key,
      url: stored.remoteUrl,
      blob: null,
      stored,
      generated: false,
    };
  }
  return null;
};

/**
 * One in-flight synthesis per concrete asset key. Repeated taps while a line is
 * generating await the same Promise instead of issuing another provider request.
 */
const inFlightVoiceAssets = new Map<string, Promise<VoiceAssetPlayback>>();

export const ensureVoiceAsset = async (
  options: EnsureVoiceAssetOptions,
): Promise<VoiceAssetPlayback> => {
  const text = String(options.text || '').trim();
  if (!text) throw new Error('没有可朗读的对白');

  if (!options.force) {
    const stored = await loadPersistedVoiceAsset(options.key);
    // Voice/profile/provider changes deliberately do NOT invalidate old audio.
    // Only editing the bound dialogue text does.
    if (stored?.originalText === text) {
      const ready = materializePersistedVoiceAsset(options.key, stored);
      if (ready) return ready;
    }
  }

  const existingTask = inFlightVoiceAssets.get(options.key);
  if (existingTask) return existingTask;

  const task = (async (): Promise<VoiceAssetPlayback> => {
    const { url, blob } = await synthesizeSpeechDetailed(text, options.char, options.apiConfig, {
      languageBoost: options.languageBoost,
      groupId: options.groupId,
      emotion: options.emotion,
    });
    const stored: StoredVoiceAsset = blob instanceof Blob
      ? {
          blob,
          originalText: text,
          spokenText: options.spokenText,
          lang: options.lang,
          favorite: false,
        }
      : {
          remoteUrl: url,
          originalText: text,
          spokenText: options.spokenText,
          lang: options.lang,
          favorite: false,
        };

    // Replacement is atomic from the caller's point of view: explicit refresh
    // does not destroy the old playable asset unless synthesis has succeeded.
    await savePersistedVoiceAsset(options.key, stored);
    return { key: options.key, url, blob, stored, generated: true };
  })();

  inFlightVoiceAssets.set(options.key, task);
  try {
    return await task;
  } finally {
    if (inFlightVoiceAssets.get(options.key) === task) inFlightVoiceAssets.delete(options.key);
  }
};

/** Test/debug helper; production callers should not need it. */
export const isVoiceAssetGenerating = (key: string): boolean => inFlightVoiceAssets.has(key);
