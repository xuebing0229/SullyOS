import type { NovelAiPreciseReferenceConfig } from '../types';
import {
    clampReferenceUnit,
    createReferenceConfigFromSource,
    deleteRemoteNovelAiReference,
} from './novelAiReference';

export const VIBE_REFERENCE_LIBRARY_KEY = 'aetheros.imageGeneration.vibeLibrary.v1';
export const VIBE_REFERENCE_CHANGED_EVENT = 'sullyos:vibe-reference-changed';

export interface VibeReferenceItem extends NovelAiPreciseReferenceConfig {
    id: string;
    name: string;
    type: 'style';
}

export interface VibeReferenceLibrary {
    version: 1;
    enabled: boolean;
    activeId: string | null;
    items: VibeReferenceItem[];
}

const EMPTY_LIBRARY: VibeReferenceLibrary = {
    version: 1,
    enabled: false,
    activeId: null,
    items: [],
};

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value));

function sanitizeItem(value: unknown): VibeReferenceItem | null {
    if (!value || typeof value !== 'object') return null;
    const raw = value as any;
    if (!raw.imageRef || !raw.slotId) return null;
    const updatedAt = Number.isFinite(raw.updatedAt) ? raw.updatedAt : Date.now();
    return {
        id: typeof raw.id === 'string' && raw.id ? raw.id : `vibe_${updatedAt}_${Math.random().toString(36).slice(2, 8)}`,
        name: typeof raw.name === 'string' && raw.name.trim()
            ? raw.name.trim().slice(0, 80)
            : (typeof raw.sourceName === 'string' && raw.sourceName.trim() ? raw.sourceName.trim().slice(0, 80) : '未命名 Vibe'),
        enabled: true,
        imageRef: String(raw.imageRef),
        imageSha256: typeof raw.imageSha256 === 'string' ? raw.imageSha256 : '',
        slotId: String(raw.slotId),
        type: 'style',
        strength: clampReferenceUnit(Number.isFinite(raw.strength) ? raw.strength : 0.6),
        fidelity: clampReferenceUnit(Number.isFinite(raw.fidelity) ? raw.fidelity : 0.85),
        sourceName: typeof raw.sourceName === 'string' ? raw.sourceName : undefined,
        updatedAt,
    };
}

export function loadVibeReferenceLibrary(): VibeReferenceLibrary {
    try {
        const raw = localStorage.getItem(VIBE_REFERENCE_LIBRARY_KEY);
        if (!raw) return clone(EMPTY_LIBRARY);
        const parsed = JSON.parse(raw);
        const items = Array.isArray(parsed?.items)
            ? parsed.items.map(sanitizeItem).filter(Boolean) as VibeReferenceItem[]
            : [];
        const activeId = typeof parsed?.activeId === 'string' && items.some(item => item.id === parsed.activeId)
            ? parsed.activeId
            : (items[0]?.id || null);
        return {
            version: 1,
            enabled: parsed?.enabled === true && Boolean(activeId),
            activeId,
            items,
        };
    } catch {
        return clone(EMPTY_LIBRARY);
    }
}

export function saveVibeReferenceLibrary(library: VibeReferenceLibrary): void {
    const items = library.items.map(sanitizeItem).filter(Boolean) as VibeReferenceItem[];
    const activeId = library.activeId && items.some(item => item.id === library.activeId)
        ? library.activeId
        : (items[0]?.id || null);
    const normalized: VibeReferenceLibrary = {
        version: 1,
        enabled: library.enabled === true && Boolean(activeId),
        activeId,
        items,
    };
    localStorage.setItem(VIBE_REFERENCE_LIBRARY_KEY, JSON.stringify(normalized));
    if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(VIBE_REFERENCE_CHANGED_EVENT));
}

export function getActiveVibeReference(): VibeReferenceItem | null {
    const library = loadVibeReferenceLibrary();
    if (!library.enabled || !library.activeId) return null;
    return library.items.find(item => item.id === library.activeId) || null;
}

export async function addVibeReference(source: Blob, sourceName: string): Promise<VibeReferenceItem> {
    const reference = await createReferenceConfigFromSource(source, sourceName);
    const now = Date.now();
    const item: VibeReferenceItem = {
        ...reference,
        id: `vibe_${now}_${Math.random().toString(36).slice(2, 8)}`,
        name: sourceName.replace(/\.[^.]+$/, '').trim().slice(0, 80) || '未命名 Vibe',
        type: 'style',
        strength: 0.6,
        fidelity: 0.85,
        updatedAt: now,
    };
    const library = loadVibeReferenceLibrary();
    library.items.push(item);
    library.activeId = item.id;
    library.enabled = true;
    saveVibeReferenceLibrary(library);
    return item;
}

export function updateVibeReference(id: string, patch: Partial<Pick<VibeReferenceItem, 'name' | 'strength' | 'fidelity'>>): void {
    const library = loadVibeReferenceLibrary();
    library.items = library.items.map(item => item.id === id ? {
        ...item,
        ...(typeof patch.name === 'string' ? { name: patch.name.trim().slice(0, 80) || item.name } : {}),
        ...(patch.strength !== undefined ? { strength: clampReferenceUnit(patch.strength) } : {}),
        ...(patch.fidelity !== undefined ? { fidelity: clampReferenceUnit(patch.fidelity) } : {}),
        updatedAt: Date.now(),
    } : item);
    saveVibeReferenceLibrary(library);
}

export function setActiveVibeReference(id: string): void {
    const library = loadVibeReferenceLibrary();
    if (!library.items.some(item => item.id === id)) return;
    library.activeId = id;
    saveVibeReferenceLibrary(library);
}

export function setVibeReferenceEnabled(enabled: boolean): void {
    const library = loadVibeReferenceLibrary();
    library.enabled = enabled && library.items.length > 0;
    saveVibeReferenceLibrary(library);
}

export async function removeVibeReference(id: string): Promise<void> {
    const library = loadVibeReferenceLibrary();
    const removed = library.items.find(item => item.id === id);
    library.items = library.items.filter(item => item.id !== id);
    if (library.activeId === id) library.activeId = library.items[0]?.id || null;
    if (!library.activeId) library.enabled = false;
    saveVibeReferenceLibrary(library);
    if (removed) void deleteRemoteNovelAiReference(removed).catch(() => {});
}

export function clearVibeReferenceLibrary(): void {
    localStorage.removeItem(VIBE_REFERENCE_LIBRARY_KEY);
    if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(VIBE_REFERENCE_CHANGED_EVENT));
}

export function exportVibeReferenceLibrary(): VibeReferenceLibrary {
    return clone(loadVibeReferenceLibrary());
}

export function importVibeReferenceLibrary(value: unknown): void {
    if (!value || typeof value !== 'object') return;
    const raw = value as any;
    saveVibeReferenceLibrary({
        version: 1,
        enabled: raw.enabled === true,
        activeId: typeof raw.activeId === 'string' ? raw.activeId : null,
        items: Array.isArray(raw.items) ? raw.items : [],
    });
}
