import { blobIdFromRef, isBlobRef, putImageBlob } from './blobRef';
import { DB } from './db';

export interface PortableBlobBackupStats {
    referenced: number;
    written: number;
    missing: number;
    bytes: number;
}

interface RefLocation {
    parent: any;
    key: string | number;
    ref: string;
}

export interface PortableBlobWriteContext {
    hasPath: (path: string) => boolean;
    writeBytes: (path: string, bytes: Uint8Array) => void;
}

export interface PortableBlobReadContext {
    readBytes: (path: string) => Promise<Uint8Array | null>;
}

const extensionForMime = (mime: string): string => {
    const value = mime.toLowerCase();
    if (value.includes('jpeg')) return 'jpg';
    if (value.includes('gif')) return 'gif';
    if (value.includes('webp')) return 'webp';
    if (value.includes('avif')) return 'avif';
    if (value.includes('bmp')) return 'bmp';
    return 'png';
};

export const mimeForBackupPath = (path: string): string => {
    const ext = path.split('.').pop()?.toLowerCase();
    if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
    if (ext === 'gif') return 'image/gif';
    if (ext === 'webp') return 'image/webp';
    if (ext === 'avif') return 'image/avif';
    if (ext === 'bmp') return 'image/bmp';
    return 'image/png';
};

const collectStringLocations = (root: unknown, predicate: (value: string) => boolean): RefLocation[] => {
    const refs: RefLocation[] = [];
    const seen = new WeakSet<object>();
    const stack: unknown[] = [root];
    while (stack.length > 0) {
        const value = stack.pop();
        if (!value || typeof value !== 'object') continue;
        if (value instanceof Blob || value instanceof ArrayBuffer || ArrayBuffer.isView(value)) continue;
        if (seen.has(value as object)) continue;
        seen.add(value as object);
        if (Array.isArray(value)) {
            for (let index = 0; index < value.length; index++) {
                const child = value[index];
                if (typeof child === 'string' && predicate(child)) refs.push({ parent: value, key: index, ref: child });
                else if (child && typeof child === 'object') stack.push(child);
            }
            continue;
        }
        for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
            if (typeof child === 'string' && predicate(child)) refs.push({ parent: value, key, ref: child });
            else if (child && typeof child === 'object') stack.push(child);
        }
    }
    return refs;
};

export async function externalizeBlobRefsInPlace(
    root: unknown,
    context: PortableBlobWriteContext,
    pathByBlobId: Map<string, string>,
): Promise<PortableBlobBackupStats> {
    const refs = collectStringLocations(root, isBlobRef);
    const stats: PortableBlobBackupStats = { referenced: refs.length, written: 0, missing: 0, bytes: 0 };
    const locationsById = new Map<string, RefLocation[]>();
    for (const location of refs) {
        const id = blobIdFromRef(location.ref);
        if (!id) continue;
        const list = locationsById.get(id) || [];
        list.push(location);
        locationsById.set(id, list);
    }
    for (const [id, locations] of locationsById) {
        let path = pathByBlobId.get(id);
        if (!path) {
            const blob = await DB.getBlobAsset(id);
            if (!blob) {
                stats.missing += locations.length;
                for (const location of locations) location.parent[location.key] = '';
                continue;
            }
            path = `assets/blobrefs/${encodeURIComponent(id)}.${extensionForMime(blob.type || 'image/png')}`;
            pathByBlobId.set(id, path);
            if (!context.hasPath(path)) {
                const bytes = new Uint8Array(await blob.arrayBuffer());
                context.writeBytes(path, bytes);
                stats.written += 1;
                stats.bytes += bytes.byteLength;
            }
        }
        for (const location of locations) location.parent[location.key] = path;
    }
    return stats;
}

export async function restorePortableBlobRefsInPlace(
    root: unknown,
    context: PortableBlobReadContext,
    refByPath: Map<string, string>,
): Promise<{ restored: number; missing: number }> {
    const refs = collectStringLocations(root, value => value.startsWith('assets/blobrefs/'));
    let restored = 0;
    let missing = 0;
    const locationsByPath = new Map<string, RefLocation[]>();
    for (const location of refs) {
        const list = locationsByPath.get(location.ref) || [];
        list.push(location);
        locationsByPath.set(location.ref, list);
    }
    for (const [path, locations] of locationsByPath) {
        let blobRef = refByPath.get(path);
        if (!blobRef) {
            const bytes = await context.readBytes(path);
            if (!bytes) {
                missing += locations.length;
                for (const location of locations) location.parent[location.key] = '';
                continue;
            }
            const ownedBytes = Uint8Array.from(bytes);
            blobRef = await putImageBlob(new Blob([ownedBytes.buffer], { type: mimeForBackupPath(path) }));
            refByPath.set(path, blobRef);
        }
        for (const location of locations) {
            location.parent[location.key] = blobRef;
            restored += 1;
        }
    }
    return { restored, missing };
}
