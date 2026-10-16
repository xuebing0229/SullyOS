import { DB } from './db';
import type { DateDialogueSegment } from './dateDialogueVoice';
import { hashTtsParams } from './ttsCache';

const DATE_DIALOGUE_CACHE_VERSION = 1;

type DateDialogueAudioCacheEntry = {
  kind: 'audio';
  blob: Blob;
  segments: DateDialogueSegment[];
  createdAt: number;
  lastUsedAt: number;
};

type DateDialogueForcedSinglesCacheEntry = {
  kind: 'forced-singles';
  createdAt: number;
  lastUsedAt: number;
};

export type DateDialoguePersistentCacheEntry =
  | DateDialogueAudioCacheEntry
  | DateDialogueForcedSinglesCacheEntry;

export const dateDialoguePersistentCacheKey = (batchKey: string): string =>
  `date_dialogue_v${DATE_DIALOGUE_CACHE_VERSION}_${hashTtsParams(batchKey).replace(/^tts_/, '')}`;

const validSegments = (segments: unknown): segments is DateDialogueSegment[] =>
  Array.isArray(segments) && segments.length > 0 && segments.every(segment => {
    if (!segment || typeof segment !== 'object') return false;
    const value = segment as DateDialogueSegment;
    return (value.speaker === 'char' || value.speaker === 'user')
      && typeof value.lineId === 'string'
      && (value.unusable === true
        || (Number.isFinite(value.startTime)
          && Number.isFinite(value.endTime)
          && value.startTime >= 0
          && value.endTime > value.startTime));
  });

export async function getCachedDateDialogue(
  batchKey: string,
): Promise<DateDialoguePersistentCacheEntry | null> {
  try {
    const key = dateDialoguePersistentCacheKey(batchKey);
    const entry = await DB.getAssetRaw(key) as DateDialoguePersistentCacheEntry | null;
    if (!entry || (entry.kind !== 'audio' && entry.kind !== 'forced-singles')) return null;
    if (entry.kind === 'audio' && (!(entry.blob instanceof Blob) || !entry.blob.size || !validSegments(entry.segments))) {
      return null;
    }
    const touched = { ...entry, lastUsedAt: Date.now() };
    void DB.saveAssetRaw(key, touched).catch(() => { /* best-effort LRU touch */ });
    return entry;
  } catch {
    return null;
  }
}

export async function saveCachedDateDialogue(
  batchKey: string,
  blob: Blob,
  segments: DateDialogueSegment[],
): Promise<void> {
  if (!(blob instanceof Blob) || !blob.size || !validSegments(segments)) return;
  try {
    const now = Date.now();
    await DB.saveAssetRaw(dateDialoguePersistentCacheKey(batchKey), {
      kind: 'audio',
      blob,
      segments,
      createdAt: now,
      lastUsedAt: now,
    } satisfies DateDialogueAudioCacheEntry);
  } catch (error) {
    console.warn('[DateDialogue cache] save failed', error);
  }
}

export async function markDateDialogueForcedSingles(batchKey: string): Promise<void> {
  try {
    const now = Date.now();
    await DB.saveAssetRaw(dateDialoguePersistentCacheKey(batchKey), {
      kind: 'forced-singles',
      createdAt: now,
      lastUsedAt: now,
    } satisfies DateDialogueForcedSinglesCacheEntry);
  } catch (error) {
    console.warn('[DateDialogue cache] forced-singles marker save failed', error);
  }
}
