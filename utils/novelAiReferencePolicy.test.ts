import { describe, expect, it } from 'vitest';
import {
    countNovelAiCharacterPromptSeparators,
    isNovelAiMultiCharacterPrompt,
    resolveNovelAiReferenceArguments,
} from './novelAiReferencePolicy';

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

    it('keeps character and user Precise references together for a non-multi-character prompt', () => {
        const result = resolveNovelAiReferenceArguments({
            args: {
                prompt: 'two people standing together',
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
            prompt: 'two people standing together',
            reference_id: 'actor_slot',
            reference_strength: 0.7,
            user_reference_id: 'user_slot',
            user_reference_fidelity: 0.8,
        });
        expect(result.selected).toEqual({ character: true, user: true, vibe: false });
    });

    it('disables Precise references for native NovelAI character_prompts', () => {
        const args = {
            prompt: 'casino, medium shot, exactly two people',
            character_prompts: [
                'silver hair, heterochromia, left side',
                'black hair, green eyes only, right side',
            ],
            use_character_reference: true,
            use_user_reference: true,
            use_vibe_reference: false,
        };
        expect(isNovelAiMultiCharacterPrompt(args)).toBe(true);

        const result = resolveNovelAiReferenceArguments({
            args,
            references: {
                character: { reference_id: 'actor_slot' },
                user: { user_reference_id: 'user_slot' },
            },
        });

        expect(result.arguments).toEqual({
            prompt: args.prompt,
            character_prompts: args.character_prompts,
        });
        expect(result.selected).toEqual({ character: false, user: false, vibe: false });
    });

    it('disables Precise references for a real NovelAI multi-character prompt', () => {
        const prompt = '2boys, casino, full scene | boy, silver hair, heterochromia, left side | boy, black hair, green eyes only, right side';
        expect(isNovelAiMultiCharacterPrompt({ prompt })).toBe(true);

        const result = resolveNovelAiReferenceArguments({
            args: {
                prompt,
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
                character: { reference_id: 'actor_slot' },
                user: { user_reference_id: 'user_slot' },
            },
        });

        expect(result.arguments).toEqual({ prompt });
        expect(result.requested).toEqual({ character: false, user: false, vibe: false });
        expect(result.selected).toEqual({ character: false, user: false, vibe: false });
    });

    it('does not mistake Prompt Randomizer pipes for multi-character separators', () => {
        const prompt = '1girl, ||red|blue|green|| hair, portrait';
        expect(countNovelAiCharacterPromptSeparators(prompt)).toBe(0);
        expect(isNovelAiMultiCharacterPrompt({ prompt })).toBe(false);

        const result = resolveNovelAiReferenceArguments({
            args: {
                prompt,
                use_character_reference: true,
                use_vibe_reference: false,
            },
            references: {
                character: { reference_id: 'actor_slot' },
            },
        });

        expect(result.selected.character).toBe(true);
        expect(result.arguments.reference_id).toBe('actor_slot');
    });

    it('ignores escaped pipes when detecting multi-character syntax', () => {
        const prompt = String.raw`1girl, sign with \| symbol, portrait`;
        expect(countNovelAiCharacterPromptSeparators(prompt)).toBe(0);
        expect(isNovelAiMultiCharacterPrompt({ prompt })).toBe(false);
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
