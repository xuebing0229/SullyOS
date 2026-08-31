import { DB } from './db';
import { getVoiceFavoriteBlob, listVoiceFavorites } from './voiceFavorites';

export const VOICE_LIBRARY_INDEX_ASSET_ID = 'voice_library_index_v1';
export const VOICE_LIBRARY_AUDIO_PREFIX = 'voice_library_audio_';
export const VOICE_LIBRARY_MIGRATION_ASSET_ID = 'voice_library_migration_v1';
export const VOICE_LIBRARY_CHANGED_EVENT = 'sully:voice-library-changed';

export type VoiceLibrarySource = 'chat' | 'call' | 'date';

export interface VoiceLibraryItem {
    id: string;
    source: VoiceLibrarySource;
    sourceKey?: string;
    charId: string;
    charName: string;
    sourceTimestamp: number;
    savedAt: number;
    originalText: string;
    spokenText?: string;
    translation?: string;
    language?: string;
    provider?: string;
    voiceId?: string;
    model?: string;
    starred: boolean;
    importedFrom?: string;
}

export interface SaveVoiceLibraryInput extends Omit<VoiceLibraryItem, 'id' | 'savedAt' | 'starred'> {
    blob: Blob;
    savedAt?: number;
    starred?: boolean;
}

interface VoiceLibraryIndex {
    version: 1;
    items: VoiceLibraryItem[];
}

interface VoiceLibraryAudioAsset {
    blob: Blob;
    mimeType: string;
    savedAt: number;
}

let writeQueue: Promise<unknown> = Promise.resolve();

const withWriteLock = async <T>(work: () => Promise<T>): Promise<T> => {
    const next = writeQueue.then(work, work);
    writeQueue = next.catch(() => undefined);
    return next;
};

const isSource = (value: unknown): value is VoiceLibrarySource => (
    value === 'chat' || value === 'call' || value === 'date'
);

const normalizeTimestamp = (value: unknown, fallback: number): number => (
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
);

const sanitizeItem = (value: unknown): VoiceLibraryItem | null => {
    if (!value || typeof value !== 'object') return null;
    const item = value as Partial<VoiceLibraryItem>;
    if (typeof item.id !== 'string' || !item.id || !isSource(item.source)) return null;
    if (typeof item.charId !== 'string' || typeof item.charName !== 'string') return null;
    const now = Date.now();
    return {
        id: item.id,
        source: item.source,
        sourceKey: typeof item.sourceKey === 'string' && item.sourceKey ? item.sourceKey : undefined,
        charId: item.charId,
        charName: item.charName || '未知角色',
        sourceTimestamp: normalizeTimestamp(item.sourceTimestamp, now),
        savedAt: normalizeTimestamp(item.savedAt, now),
        originalText: typeof item.originalText === 'string' ? item.originalText : '',
        spokenText: typeof item.spokenText === 'string' && item.spokenText ? item.spokenText : undefined,
        translation: typeof item.translation === 'string' && item.translation ? item.translation : undefined,
        language: typeof item.language === 'string' && item.language ? item.language : undefined,
        provider: typeof item.provider === 'string' && item.provider ? item.provider : undefined,
        voiceId: typeof item.voiceId === 'string' && item.voiceId ? item.voiceId : undefined,
        model: typeof item.model === 'string' && item.model ? item.model : undefined,
        starred: item.starred === true,
        importedFrom: typeof item.importedFrom === 'string' && item.importedFrom ? item.importedFrom : undefined,
    };
};

const loadIndex = async (): Promise<VoiceLibraryItem[]> => {
    const raw = await DB.getAssetRaw(VOICE_LIBRARY_INDEX_ASSET_ID).catch(() => null) as Partial<VoiceLibraryIndex> | VoiceLibraryItem[] | null;
    const items = Array.isArray(raw) ? raw : raw?.items;
    if (!Array.isArray(items)) return [];
    return items.map(sanitizeItem).filter((item): item is VoiceLibraryItem => !!item);
};

const saveIndex = async (items: VoiceLibraryItem[]): Promise<void> => {
    await DB.saveAssetRaw(VOICE_LIBRARY_INDEX_ASSET_ID, { version: 1, items } satisfies VoiceLibraryIndex);
};

const notifyChanged = () => {
    if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(VOICE_LIBRARY_CHANGED_EVENT));
};

const fallbackId = (source: VoiceLibrarySource, savedAt: number): string => {
    const random = Math.random().toString(36).slice(2, 10);
    return `voice_${source}_${savedAt.toString(36)}_${random}`;
};

const createId = (source: VoiceLibrarySource, savedAt: number): string => {
    try {
        const id = globalThis.crypto?.randomUUID?.();
        if (id) return `voice_${id}`;
    } catch { /* fallback below */ }
    return fallbackId(source, savedAt);
};

export const voiceLibraryAudioAssetId = (itemId: string): string => `${VOICE_LIBRARY_AUDIO_PREFIX}${itemId}`;

export const sortVoiceLibrary = (items: VoiceLibraryItem[]): VoiceLibraryItem[] => (
    [...items].sort((a, b) => b.savedAt - a.savedAt || b.sourceTimestamp - a.sourceTimestamp || b.id.localeCompare(a.id))
);

export const listVoiceLibrary = async (): Promise<VoiceLibraryItem[]> => sortVoiceLibrary(await loadIndex());

export const getVoiceLibraryBlob = async (itemId: string): Promise<Blob | null> => {
    const raw = await DB.getAssetRaw(voiceLibraryAudioAssetId(itemId)).catch(() => null) as VoiceLibraryAudioAsset | Blob | null;
    if (raw instanceof Blob) return raw;
    return raw?.blob instanceof Blob ? raw.blob : null;
};

/**
 * Save one generated rendition. This intentionally never upserts by sourceKey:
 * regenerating the same message three times preserves three performances.
 */
export const saveVoiceLibraryItem = async (input: SaveVoiceLibraryInput): Promise<VoiceLibraryItem> => withWriteLock(async () => {
    if (!(input.blob instanceof Blob) || input.blob.size <= 0) throw new Error('语音文件为空');
    const now = Date.now();
    const current = await loadIndex();

    if (input.importedFrom) {
        const imported = current.find(item => item.importedFrom === input.importedFrom);
        if (imported) return imported;
    }

    const savedAt = normalizeTimestamp(input.savedAt, now);
    const item: VoiceLibraryItem = {
        id: createId(input.source, savedAt),
        source: input.source,
        sourceKey: input.sourceKey || undefined,
        charId: input.charId,
        charName: input.charName || '未知角色',
        sourceTimestamp: normalizeTimestamp(input.sourceTimestamp, savedAt),
        savedAt,
        originalText: input.originalText || '',
        spokenText: input.spokenText || undefined,
        translation: input.translation || undefined,
        language: input.language || undefined,
        provider: input.provider || undefined,
        voiceId: input.voiceId || undefined,
        model: input.model || undefined,
        starred: input.starred === true,
        importedFrom: input.importedFrom || undefined,
    };

    await DB.saveAssetRaw(voiceLibraryAudioAssetId(item.id), {
        blob: input.blob,
        mimeType: input.blob.type || 'audio/mpeg',
        savedAt,
    } satisfies VoiceLibraryAudioAsset);

    try {
        await saveIndex([item, ...current]);
    } catch (error) {
        await DB.deleteAsset(voiceLibraryAudioAssetId(item.id)).catch(() => undefined);
        throw error;
    }

    notifyChanged();
    return item;
});

export const setVoiceLibraryStarred = async (itemId: string, starred: boolean): Promise<boolean> => withWriteLock(async () => {
    const current = await loadIndex();
    let changed = false;
    const next = current.map(item => {
        if (item.id !== itemId || item.starred === starred) return item;
        changed = true;
        return { ...item, starred };
    });
    if (!changed) return false;
    await saveIndex(next);
    notifyChanged();
    return true;
});

export const setVoiceLibraryStarredForSource = async (
    source: VoiceLibrarySource,
    sourceKey: string,
    starred: boolean,
): Promise<number> => withWriteLock(async () => {
    const current = await loadIndex();
    let changed = 0;
    const next = current.map(item => {
        if (item.source !== source || item.sourceKey !== sourceKey || item.starred === starred) return item;
        changed++;
        return { ...item, starred };
    });
    if (changed > 0) {
        await saveIndex(next);
        notifyChanged();
    }
    return changed;
});

const normalizeComparableText = (value: string): string => value.replace(/\s+/g, ' ').trim();

/** Fallback for call audio synthesized during prefetch, before a bubble/sourceKey exists. */
export const setLatestVoiceLibraryStarredByText = async (
    source: VoiceLibrarySource,
    charId: string,
    text: string,
    starred: boolean,
): Promise<boolean> => withWriteLock(async () => {
    const needle = normalizeComparableText(text);
    if (!needle) return false;
    const current = sortVoiceLibrary(await loadIndex());
    const target = current.find(item => (
        item.source === source
        && item.charId === charId
        && (
            normalizeComparableText(item.originalText) === needle
            || normalizeComparableText(item.spokenText || '') === needle
        )
    ));
    if (!target || target.starred === starred) return !!target;
    await saveIndex(current.map(item => item.id === target.id ? { ...item, starred } : item));
    notifyChanged();
    return true;
});

export const removeVoiceLibraryItem = async (itemId: string): Promise<boolean> => withWriteLock(async () => {
    const current = await loadIndex();
    if (!current.some(item => item.id === itemId)) return false;
    await saveIndex(current.filter(item => item.id !== itemId));
    await DB.deleteAsset(voiceLibraryAudioAssetId(itemId)).catch(() => undefined);
    notifyChanged();
    return true;
});

export const voiceLibrarySourceLabel = (source: VoiceLibrarySource): string => ({
    chat: '聊天',
    call: '通话',
    date: '见面',
}[source]);

type CharacterLookup = Array<{ id: string; name?: string }>;

interface LegacyStoredVoice {
    blob?: Blob;
    favorite?: boolean;
    originalText?: string;
    spokenText?: string;
    lang?: string;
}

/**
 * One-time bridge for data that existed before Voice Library shipped.
 * Persisted chat voice_msg_* Blobs and old explicit voice favorites are kept.
 * Remote-only URLs / bare tts_* cache rows lack reliable source metadata and
 * therefore cannot be reconstructed safely.
 */
export const migrateExistingVoiceHistoryToLibrary = async (
    characters: CharacterLookup = [],
): Promise<{ imported: number; alreadyDone: boolean }> => {
    const marker = await DB.getAssetRaw(VOICE_LIBRARY_MIGRATION_ASSET_ID).catch(() => null) as { version?: number } | null;
    if (marker?.version === 1) return { imported: 0, alreadyDone: true };

    const charNames = new Map(characters.map(char => [char.id, char.name || '未知角色']));
    let imported = 0;

    const assets = await DB.getAllAssets().catch(() => []) as unknown as Array<{ id?: unknown; data?: unknown }>;
    for (const asset of assets) {
        if (typeof asset?.id !== 'string' || !asset.id.startsWith('voice_msg_')) continue;
        const msgId = Number(asset.id.slice('voice_msg_'.length));
        if (!Number.isSafeInteger(msgId) || msgId <= 0) continue;
        const stored = asset.data as LegacyStoredVoice | null;
        if (!stored || !(stored.blob instanceof Blob) || stored.blob.size <= 0) continue;

        const message = await DB.getMessageById(msgId).catch(() => null);
        if (!message?.charId) continue;

        const importKey = `legacy-chat:${msgId}`;
        const before = await listVoiceLibrary();
        if (before.some(item => item.importedFrom === importKey)) continue;

        await saveVoiceLibraryItem({
            source: 'chat',
            sourceKey: `${message.charId}:${msgId}`,
            charId: message.charId,
            charName: charNames.get(message.charId) || '未知角色',
            sourceTimestamp: message.timestamp || Date.now(),
            originalText: stored.originalText || stored.spokenText || message.content || '',
            spokenText: stored.spokenText || undefined,
            language: stored.lang || undefined,
            blob: stored.blob,
            starred: stored.favorite === true,
            importedFrom: importKey,
        });
        imported++;
    }

    const favorites = await listVoiceFavorites().catch(() => []);
    for (const favorite of favorites) {
        const matched = await setVoiceLibraryStarredForSource(favorite.source, favorite.sourceKey, true);
        if (matched > 0) continue;

        const blob = await getVoiceFavoriteBlob(favorite.id).catch(() => null);
        if (!blob || blob.size <= 0) continue;
        const importKey = `legacy-favorite:${favorite.id}`;
        const existing = await listVoiceLibrary();
        if (existing.some(item => item.importedFrom === importKey)) continue;

        await saveVoiceLibraryItem({
            source: favorite.source,
            sourceKey: favorite.sourceKey,
            charId: favorite.charId,
            charName: favorite.charName,
            sourceTimestamp: favorite.sourceTimestamp,
            originalText: favorite.originalText,
            spokenText: favorite.spokenText,
            translation: favorite.translation,
            language: favorite.language,
            blob,
            starred: true,
            importedFrom: importKey,
        });
        imported++;
    }

    await DB.saveAssetRaw(VOICE_LIBRARY_MIGRATION_ASSET_ID, {
        version: 1,
        completedAt: Date.now(),
        imported,
    });
    return { imported, alreadyDone: false };
};
