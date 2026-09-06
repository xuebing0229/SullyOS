import { describe, expect, it } from 'vitest';
import { resolveNovelAiReferenceArguments } from './novelAiReferencePolicy';

describe('NovelAI reference policy', () => {
    it('lets selected-tool policy override planner wishes and strips managed ids', () => {
        const result = resolveNovelAiReferenceArguments({
            args: {
                prompt: 'portrait',
                use_character_reference: true,
                use_user_reference: true,
                reference_id: 'planner_actor_slot',
                user_reference_id: 'planner_user_slot',
            },
            policy: {
                allowCharacterReference: false,
                allowUserReference: false,
                allowVibeReference: true,
            },
            references: {
                character: { reference_id: 'managed_actor_slot' },
                user: { user_reference_id: 'managed_user_slot' },
            },
        });

        expect(result.arguments).toEqual({ prompt: 'portrait' });
        expect(result.selected).toEqual({ character: false, user: false, vibe: false });
    });

    it('keeps character and user Precise references together when the selected preset allows them', () => {
        const result = resolveNovelAiReferenceArguments({
            args: {
                prompt: 'two people',
                use_character_reference: true,
                use_user_reference: true,
                use_vibe_reference: false,
            },
            policy: {
                allowCharacterReference: true,
                allowUserReference: true,
                allowVibeReference: true,
            },
            references: {
                character: {
                    reference_id: 'actor_slot',
                    reference_strength: 0.7,
                },
                user: {
                    user_reference_id: 'user_slot',
                    user_reference_fidelity: 0.8,
                },
            },
        });

        expect(result.arguments).toEqual({
            prompt: 'two people',
            reference_id: 'actor_slot',
            reference_strength: 0.7,
            user_reference_id: 'user_slot',
            user_reference_fidelity: 0.8,
        });
        expect(result.selected).toEqual({ character: true, user: true, vibe: false });
    });

    it('makes Vibe win over Precise exactly once', () => {
        const result = resolveNovelAiReferenceArguments({
            args: {
                prompt: 'night street',
                use_character_reference: true,
                use_user_reference: true,
                use_vibe_reference: true,
            },
            policy: {
                allowCharacterReference: true,
                allowUserReference: true,
                allowVibeReference: true,
            },
            references: {
                character: { reference_id: 'actor_slot' },
                user: { user_reference_id: 'user_slot' },
                vibe: {
                    vibe_reference_id: 'vibe_slot',
                    vibe_reference_strength: 0.6,
                    vibe_reference_information_extracted: 0.9,
                },
            },
        });

        expect(result.arguments).toEqual({
            prompt: 'night street',
            vibe_reference_id: 'vibe_slot',
            vibe_reference_strength: 0.6,
            vibe_reference_information_extracted: 0.9,
        });
        expect(result.selected).toEqual({ character: false, user: false, vibe: true });
    });

    it('does not allow raw planner Vibe fields to bypass a disabled Vibe policy', () => {
        const result = resolveNovelAiReferenceArguments({
            args: {
                prompt: 'plain',
                vibe_reference_id: 'planner_vibe_slot',
                use_vibe_reference: true,
            },
            policy: {
                allowCharacterReference: true,
                allowUserReference: true,
                allowVibeReference: false,
            },
            references: {
                vibe: { vibe_reference_id: 'managed_vibe_slot' },
            },
        });

        expect(result.arguments).toEqual({ prompt: 'plain' });
        expect(result.selected.vibe).toBe(false);
    });
});
