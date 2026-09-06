export interface NovelAiReferencePolicy {
    allowCharacterReference: boolean;
    allowUserReference: boolean;
    allowVibeReference: boolean;
}

export interface NovelAiReferenceFragments {
    character?: Record<string, unknown>;
    user?: Record<string, unknown>;
    vibe?: Record<string, unknown>;
}

export interface NovelAiReferenceResolution {
    arguments: Record<string, any>;
    requested: {
        character: boolean;
        user: boolean;
        vibe: boolean;
    };
    selected: {
        character: boolean;
        user: boolean;
        vibe: boolean;
    };
}

export const DEFAULT_NOVEL_AI_REFERENCE_POLICY: NovelAiReferencePolicy = {
    allowCharacterReference: true,
    allowUserReference: true,
    allowVibeReference: true,
};

const MANAGED_REFERENCE_KEYS = new Set([
    'reference_id',
    'reference_type',
    'reference_strength',
    'reference_fidelity',
    'user_reference_id',
    'user_reference_type',
    'user_reference_strength',
    'user_reference_fidelity',
    'vibe_reference_id',
    'vibe_reference_strength',
    'vibe_reference_information_extracted',
    'use_character_reference',
    'use_user_reference',
    'use_vibe_reference',
    'story_reference_actor_id',
    'story_use_character_reference',
    'story_use_user_reference',
    'story_use_vibe_reference',
]);

const CHARACTER_FRAGMENT_KEYS = new Set([
    'reference_id',
    'reference_type',
    'reference_strength',
    'reference_fidelity',
]);
const USER_FRAGMENT_KEYS = new Set([
    'user_reference_id',
    'user_reference_type',
    'user_reference_strength',
    'user_reference_fidelity',
]);
const VIBE_FRAGMENT_KEYS = new Set([
    'vibe_reference_id',
    'vibe_reference_strength',
    'vibe_reference_information_extracted',
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
    Boolean(value && typeof value === 'object' && !Array.isArray(value));

const hasFragment = (value: unknown): boolean =>
    isRecord(value) && Object.keys(value).length > 0;

const copyFragment = (
    value: Record<string, unknown> | undefined,
    allowed: Set<string>,
): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    if (!value) return out;
    for (const [key, field] of Object.entries(value)) {
        if (allowed.has(key)) out[key] = field;
    }
    return out;
};

/**
 * Remove every NovelAI managed reference field and every client-only selector.
 * A planner may ask whether a managed reference should be used, but it can never
 * smuggle its own slot id/strength/fidelity into the real image backend request.
 */
export const sanitizeNovelAiReferenceArguments = (
    args?: Record<string, any> | null,
): Record<string, any> => {
    const clean = { ...(args || {}) };
    for (const key of MANAGED_REFERENCE_KEYS) delete clean[key];
    return clean;
};

export const normalizeNovelAiReferencePolicy = (
    value?: Partial<NovelAiReferencePolicy> | null,
): NovelAiReferencePolicy => ({
    allowCharacterReference: value?.allowCharacterReference !== false,
    allowUserReference: value?.allowUserReference !== false,
    allowVibeReference: value?.allowVibeReference !== false,
});

/**
 * Pure reference decision shared by foreground MCP execution and the AMSG Worker.
 *
 * Semantics intentionally match the established foreground behavior:
 * - use_* defaults to true when omitted;
 * - story_use_* is an additional client selector used by background story planning;
 * - selected-tool policy is authoritative over planner wishes;
 * - an available+requested Vibe reference wins over all Precise references because
 *   NovelAI does not allow Vibe Transfer and Precise Reference together;
 * - only whitelisted managed fragments can be merged into the final arguments.
 */
export const resolveNovelAiReferenceArguments = (input: {
    args?: Record<string, any> | null;
    policy?: Partial<NovelAiReferencePolicy> | null;
    references?: NovelAiReferenceFragments | null;
}): NovelAiReferenceResolution => {
    const source = input.args || {};
    const policy = normalizeNovelAiReferencePolicy(input.policy);
    const requested = {
        character:
            source.story_use_character_reference !== false
            && source.use_character_reference !== false,
        user:
            source.story_use_user_reference !== false
            && source.use_user_reference !== false,
        vibe:
            source.story_use_vibe_reference !== false
            && source.use_vibe_reference !== false,
    };
    const references = input.references || {};
    const vibeSelected = Boolean(
        policy.allowVibeReference
        && requested.vibe
        && hasFragment(references.vibe),
    );
    const selected = {
        character: Boolean(
            !vibeSelected
            && policy.allowCharacterReference
            && requested.character
            && hasFragment(references.character),
        ),
        user: Boolean(
            !vibeSelected
            && policy.allowUserReference
            && requested.user
            && hasFragment(references.user),
        ),
        vibe: vibeSelected,
    };

    const finalArgs = sanitizeNovelAiReferenceArguments(source);
    if (selected.vibe) {
        Object.assign(finalArgs, copyFragment(references.vibe, VIBE_FRAGMENT_KEYS));
    } else {
        if (selected.character) {
            Object.assign(finalArgs, copyFragment(references.character, CHARACTER_FRAGMENT_KEYS));
        }
        if (selected.user) {
            Object.assign(finalArgs, copyFragment(references.user, USER_FRAGMENT_KEYS));
        }
    }

    return { arguments: finalArgs, requested, selected };
};
