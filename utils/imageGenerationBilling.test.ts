import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { DB } from './db';
import { detectImageGenerationFeatureUsage, recordSuccessfulImageGeneration } from './imageGenerationBilling';

describe('image generation billing', () => {
    beforeEach(async () => {
        localStorage.clear();
        await DB.deleteDB().catch(() => undefined);
    });

    it('charges each add-on once per actually sent reference image', async () => {
        const usage = detectImageGenerationFeatureUsage({
            reference_id: 'character-slot',
            reference_type: 'character&style',
            user_reference_id: 'user-slot',
            user_reference_type: 'character&style',
        });
        expect(usage).toEqual({
            characterReference: true,
            vibeReference: false,
            characterReferenceCount: 2,
            vibeReferenceCount: 0,
        });
        const capture = {
            engineId: 'novelai' as const,
            presetId: 'preset-1', presetName: 'NAI 线路', baseUrl: 'https://example.test',
            pricing: {
                enabled: true, basePricePerRequestYuan: '0.25',
                addons: {
                    characterReference: { enabled: true, pricePerRequestYuan: '0.10' },
                    vibeReference: { enabled: true, pricePerRequestYuan: '0.05' },
                },
            },
        };
        expect(await recordSuccessfulImageGeneration({ capture, requestId: 'req-1', model: 'nai-full', featureUsage: usage })).toBe(true);
        expect(await recordSuccessfulImageGeneration({ capture, requestId: 'req-1', model: 'nai-full', featureUsage: usage })).toBe(false);
        const entries = await DB.getApiCallLog();
        expect(entries).toHaveLength(1);
        expect(entries[0]).toMatchObject({ presetId: 'preset-1', model: 'nai-full', costStatus: 'priced', costMicros: '450000' });
        expect(entries[0].imageBilling.addons).toHaveLength(1);
        expect(entries[0].imageBilling.addons).toEqual(expect.arrayContaining([
            expect.objectContaining({ key: 'character_reference', quantity: 2, priceMicros: '200000' }),
        ]));
        expect((await DB.getApiCostOverview()).totalCostMicros).toBe('450000');
    });

    it('does not turn disabled pricing into token billing', async () => {
        await recordSuccessfulImageGeneration({
            capture: {
                engineId: 'gpt-image', presetName: '当前配置', baseUrl: '',
                pricing: { enabled: false, basePricePerRequestYuan: '', addons: { characterReference: { enabled: false, pricePerRequestYuan: '' }, vibeReference: { enabled: false, pricePerRequestYuan: '' } } },
            },
            requestId: 'req-unpriced', model: 'gpt-image',
            featureUsage: { characterReference: false, vibeReference: false },
        });
        const [entry] = await DB.getApiCallLog();
        expect(entry.costStatus).toBe('unpriced');
        expect(entry.billingUsage.usageAvailable).toBe(false);
    });

    it('counts character and user references separately', () => {
        expect(detectImageGenerationFeatureUsage({
            reference_id: 'character-slot',
            reference_type: 'character',
            user_reference_id: 'user-slot',
            user_reference_type: 'character&style',
        })).toEqual({ characterReference: true, vibeReference: false, characterReferenceCount: 2, vibeReferenceCount: 0 });
        expect(detectImageGenerationFeatureUsage({
            user_reference_id: 'user-slot',
            user_reference_type: 'character',
        })).toEqual({ characterReference: true, vibeReference: false, characterReferenceCount: 1, vibeReferenceCount: 0 });
        expect(detectImageGenerationFeatureUsage({
            vibe_reference_id: 'vibe-slot',
        })).toEqual({ characterReference: false, vibeReference: true, characterReferenceCount: 0, vibeReferenceCount: 1 });
    });
});
