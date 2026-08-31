import { beforeEach, describe, expect, it } from 'vitest';
import { DB } from './db';
import {
    VOICE_LIBRARY_INDEX_ASSET_ID,
    VOICE_LIBRARY_MIGRATION_ASSET_ID,
    getVoiceLibraryBlob,
    listVoiceLibrary,
    removeVoiceLibraryItem,
    saveVoiceLibraryItem,
    setLatestVoiceLibraryStarredByText,
    setVoiceLibraryStarred,
    sortVoiceLibrary,
    voiceLibraryAudioAssetId,
    type VoiceLibraryItem,
} from './voiceLibrary';

const base = {
    source: 'chat' as const,
    sourceKey: 'char-1:message-1',
    charId: 'char-1',
    charName: 'Sully',
    sourceTimestamp: 100,
    originalText: '你好',
};

beforeEach(async () => {
    const prior = await listVoiceLibrary();
    await Promise.all(prior.map(item => DB.deleteAsset(voiceLibraryAudioAssetId(item.id))));
    await DB.deleteAsset(VOICE_LIBRARY_INDEX_ASSET_ID);
    await DB.deleteAsset(VOICE_LIBRARY_MIGRATION_ASSET_ID);
});

describe('voice library repository', () => {
    it('keeps multiple generated renditions from the same source instead of overwriting', async () => {
        const first = await saveVoiceLibraryItem({
            ...base,
            savedAt: 10,
            blob: new Blob(['first'], { type: 'audio/mpeg' }),
        });
        const second = await saveVoiceLibraryItem({
            ...base,
            savedAt: 20,
            blob: new Blob(['second'], { type: 'audio/ogg' }),
        });

        expect(first.id).not.toBe(second.id);
        const items = await listVoiceLibrary();
        expect(items).toHaveLength(2);
        expect(items.map(item => item.id)).toEqual([second.id, first.id]);
        expect(await (await getVoiceLibraryBlob(first.id))?.text()).toBe('first');
        expect(await (await getVoiceLibraryBlob(second.id))?.text()).toBe('second');
    });

    it('stars independently and deletes metadata together with its audio asset', async () => {
        const saved = await saveVoiceLibraryItem({
            ...base,
            blob: new Blob(['voice']),
        });

        expect(await setVoiceLibraryStarred(saved.id, true)).toBe(true);
        expect((await listVoiceLibrary())[0].starred).toBe(true);

        expect(await removeVoiceLibraryItem(saved.id)).toBe(true);
        expect(await listVoiceLibrary()).toEqual([]);
        expect(await getVoiceLibraryBlob(saved.id)).toBeNull();
    });

    it('can match prefetched call audio by character and normalized text', async () => {
        const saved = await saveVoiceLibraryItem({
            ...base,
            source: 'call',
            sourceKey: undefined,
            originalText: '喂，  你在吗？',
            blob: new Blob(['call']),
        });

        expect(await setLatestVoiceLibraryStarredByText('call', 'char-1', '喂， 你在吗？', true)).toBe(true);
        expect((await listVoiceLibrary()).find(item => item.id === saved.id)?.starred).toBe(true);
    });

    it('sorts by archive time, not the source message time', () => {
        const item = (id: string, savedAt: number, sourceTimestamp: number): VoiceLibraryItem => ({
            ...base,
            id,
            savedAt,
            sourceTimestamp,
            starred: false,
        });
        expect(sortVoiceLibrary([
            item('old-save-new-message', 1, 999),
            item('new-save-old-message', 2, 1),
        ]).map(entry => entry.id)).toEqual(['new-save-old-message', 'old-save-new-message']);
    });
});
