export const STORY_IMAGE_TEXT_PRESETS_KEY = 'sullyos_story_image_text_presets_v1';

export interface StoryImageTextPreset {
    id: string;
    name: string;
    stylePrompt: string;
    negativePrompt: string;
    userAnchor: string;
    characterAnchors: Record<string, string>;
    characterAnchorNames: Record<string, string>;
    updatedAt: number;
}

export interface StoryImagePresetActor {
    id: string;
    name: string;
}

const normalizePreset = (item: any): StoryImageTextPreset | null => {
    if (!item || typeof item !== 'object' || typeof item.name !== 'string') return null;
    const name = item.name.trim();
    if (!name) return null;
    return {
        id: typeof item.id === 'string' && item.id
            ? item.id
            : `story_img_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        name,
        stylePrompt: typeof item.stylePrompt === 'string' ? item.stylePrompt : '',
        negativePrompt: typeof item.negativePrompt === 'string' ? item.negativePrompt : '',
        userAnchor: typeof item.userAnchor === 'string' ? item.userAnchor : '',
        characterAnchors: item.characterAnchors && typeof item.characterAnchors === 'object'
            ? item.characterAnchors
            : {},
        characterAnchorNames: item.characterAnchorNames && typeof item.characterAnchorNames === 'object'
            ? item.characterAnchorNames
            : {},
        updatedAt: typeof item.updatedAt === 'number' ? item.updatedAt : 0,
    };
};

export const loadStoryImageTextPresets = (): StoryImageTextPreset[] => {
    try {
        const raw = JSON.parse(localStorage.getItem(STORY_IMAGE_TEXT_PRESETS_KEY) || '[]');
        if (!Array.isArray(raw)) return [];
        return raw
            .map(normalizePreset)
            .filter((item): item is StoryImageTextPreset => Boolean(item))
            .sort((a, b) => b.updatedAt - a.updatedAt);
    } catch {
        return [];
    }
};

export const persistStoryImageTextPresets = (presets: StoryImageTextPreset[]) => {
    localStorage.setItem(STORY_IMAGE_TEXT_PRESETS_KEY, JSON.stringify(presets));
};

export const resolveStoryImagePresetForActors = (
    preset: StoryImageTextPreset,
    actors: StoryImagePresetActor[],
): {
    stylePrompt: string;
    negativePrompt: string;
    userAnchor: string;
    characterAnchors: Record<string, string>;
} => {
    const savedAnchorValues = Object.values(preset.characterAnchors || {})
        .filter(value => typeof value === 'string' && value.trim().length > 0);
    const singleSavedAnchor = savedAnchorValues.length === 1 ? savedAnchorValues[0] : '';
    const characterAnchors: Record<string, string> = {};

    for (const actor of actors) {
        characterAnchors[actor.id] = preset.characterAnchors?.[actor.id]
            ?? preset.characterAnchorNames?.[actor.name]
            ?? (actors.length === 1 ? singleSavedAnchor : '')
            ?? '';
    }

    return {
        stylePrompt: preset.stylePrompt,
        negativePrompt: preset.negativePrompt,
        userAnchor: preset.userAnchor,
        characterAnchors,
    };
};

export const upsertStoryImageTextPreset = (input: {
    presets: StoryImageTextPreset[];
    name: string;
    stylePrompt?: string;
    negativePrompt?: string;
    userAnchor?: string;
    actors: StoryImagePresetActor[];
    characterAnchors?: Record<string, string>;
}): { presets: StoryImageTextPreset[]; preset: StoryImageTextPreset; replaced: boolean } => {
    const name = input.name.trim();
    if (!name) throw new Error('预设名称不能为空');

    const existing = input.presets.find(item => item.name === name);
    const now = Date.now();
    const characterAnchorNames = input.actors.reduce<Record<string, string>>((result, actor) => {
        result[actor.name] = input.characterAnchors?.[actor.id] || '';
        return result;
    }, {});
    const characterAnchors = input.actors.reduce<Record<string, string>>((result, actor) => {
        result[actor.id] = input.characterAnchors?.[actor.id] || '';
        return result;
    }, {});
    const preset: StoryImageTextPreset = {
        id: existing?.id || `story_img_${now}_${Math.random().toString(36).slice(2, 8)}`,
        name,
        stylePrompt: input.stylePrompt || '',
        negativePrompt: input.negativePrompt || '',
        userAnchor: input.userAnchor || '',
        characterAnchors,
        characterAnchorNames,
        updatedAt: now,
    };
    const presets = [preset, ...input.presets.filter(item => item.id !== preset.id)]
        .sort((a, b) => b.updatedAt - a.updatedAt);
    persistStoryImageTextPresets(presets);
    return { presets, preset, replaced: Boolean(existing) };
};

export const renameStoryImageTextPreset = (
    presets: StoryImageTextPreset[],
    presetId: string,
    name: string,
): StoryImageTextPreset[] => {
    const trimmed = name.trim();
    if (!trimmed) throw new Error('预设名称不能为空');
    if (presets.some(item => item.id !== presetId && item.name === trimmed)) {
        throw new Error('已经有同名配图预设');
    }
    const next = presets
        .map(item => item.id === presetId ? { ...item, name: trimmed, updatedAt: Date.now() } : item)
        .sort((a, b) => b.updatedAt - a.updatedAt);
    persistStoryImageTextPresets(next);
    return next;
};

export const deleteStoryImageTextPreset = (
    presets: StoryImageTextPreset[],
    presetId: string,
): StoryImageTextPreset[] => {
    const next = presets.filter(item => item.id !== presetId);
    persistStoryImageTextPresets(next);
    return next;
};
