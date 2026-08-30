import type { ApiCallLogEntry } from './apiCallLog';
import { emitApiCostUpdated } from './apiCostEvents';
import { yuanStringToMicros } from './apiPricing';
import { DB } from './db';
import {
    getActiveImageGenerationPreset,
    type ImageGenerationPricing,
} from './imageGenerationPresets';
import type { BuiltinImageEngineId } from './builtinImageMcp';

export interface ImageGenerationBillingCapture {
    engineId: BuiltinImageEngineId;
    presetId?: string;
    presetName: string;
    baseUrl: string;
    pricing: ImageGenerationPricing;
}

export interface ImageGenerationFeatureUsage {
    characterReference: boolean;
    vibeReference: boolean;
    characterReferenceCount?: number;
    vibeReferenceCount?: number;
}

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value));

export function captureImageGenerationBilling(
    engineId: BuiltinImageEngineId,
): ImageGenerationBillingCapture {
    const preset = getActiveImageGenerationPreset(engineId);
    const remote = preset?.remoteConfig as any;
    return {
        engineId,
        presetId: preset?.id,
        presetName: preset?.name || (engineId === 'novelai' ? 'NovelAI 当前配置' : 'GPT 生图当前配置'),
        baseUrl: String(remote?.baseUrl || ''),
        pricing: clone(preset?.pricing || {
            enabled: false,
            basePricePerRequestYuan: '',
            addons: {
                characterReference: { enabled: false, pricePerRequestYuan: '' },
                vibeReference: { enabled: false, pricePerRequestYuan: '' },
            },
        }),
    };
}

export function detectImageGenerationFeatureUsage(args?: Record<string, any>): ImageGenerationFeatureUsage {
    const references = [
        {
            id: args?.reference_id || args?.referenceId,
            type: args?.reference_type || args?.referenceType || 'character',
        },
        {
            id: args?.user_reference_id || args?.userReferenceId,
            type: args?.user_reference_type || args?.userReferenceType || 'character',
        },
    ].filter(reference => Boolean(reference.id));
    const explicitCharacterReferenceCount = args?.character_reference_id || args?.characterReferenceId ? 1 : 0;
    const explicitVibeReferenceCount = args?.vibe_reference_id || args?.vibeReferenceId || args?.style_reference_id || args?.styleReferenceId ? 1 : 0;
    return {
        characterReference: references.length > 0 || explicitCharacterReferenceCount > 0,
        vibeReference: explicitVibeReferenceCount > 0,
        characterReferenceCount: references.length + explicitCharacterReferenceCount,
        vibeReferenceCount: explicitVibeReferenceCount,
    };
}

const localDateKey = (timestamp: number): string => {
    const date = new Date(timestamp);
    const pad = (value: number) => String(value).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};

export async function recordSuccessfulImageGeneration(input: {
    capture: ImageGenerationBillingCapture;
    requestId: string;
    model: string;
    featureUsage: ImageGenerationFeatureUsage;
    charId?: string;
    charName?: string;
    timestamp?: number;
}): Promise<boolean> {
    const timestamp = input.timestamp ?? Date.now();
    const pricing = input.capture.pricing;
    const basePrice = pricing.enabled ? yuanStringToMicros(pricing.basePricePerRequestYuan) : null;
    const addons: NonNullable<ApiCallLogEntry['imageBilling']>['addons'] = [];
    let invalidPrice = pricing.enabled && basePrice === null;

    const add = (
        count: number,
        key: 'character_reference' | 'vibe_reference',
        label: string,
        config: ImageGenerationPricing['addons']['characterReference'],
    ) => {
        if (count <= 0 || !config.enabled) return;
        const price = yuanStringToMicros(config.pricePerRequestYuan);
        if (price === null) { invalidPrice = true; return; }
        addons.push({
            key,
            label: count > 1 ? `${label} ×${count}` : label,
            priceMicros: (price * BigInt(count)).toString(),
            quantity: count,
            unitPriceMicros: price.toString(),
        });
    };
    add(input.featureUsage.characterReferenceCount ?? (input.featureUsage.characterReference ? 1 : 0), 'character_reference', '精密参考图', pricing.addons.characterReference);
    add(input.featureUsage.vibeReferenceCount ?? (input.featureUsage.vibeReference ? 1 : 0), 'vibe_reference', 'Vibe 参考', pricing.addons.vibeReference);

    const total = (basePrice ?? 0n) + addons.reduce((sum, item) => sum + BigInt(item.priceMicros), 0n);
    const priced = pricing.enabled && !invalidPrice;
    const entry: ApiCallLogEntry = {
        id: `image:${input.requestId}`,
        timestamp,
        presetId: input.capture.presetId,
        presetName: input.capture.presetName,
        baseUrl: input.capture.baseUrl,
        model: input.model,
        ok: true,
        status: 200,
        source: 'network',
        networkRequest: true,
        billingUsage: { inputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 0, usageAvailable: false },
        pricingSnapshot: input.capture.presetId ? {
            presetId: input.capture.presetId,
            presetName: input.capture.presetName,
            pricing: { mode: 'per_request', pricePerRequestYuan: pricing.basePricePerRequestYuan },
        } : undefined,
        costStatus: priced ? 'priced' : 'unpriced',
        costMicros: priced ? total.toString() : undefined,
        unpricedReason: priced ? undefined : 'pricing_not_configured',
        appId: 'image_generation',
        appName: '生图',
        purpose: '生图按次',
        charId: input.charId,
        charName: input.charName,
        imageBilling: {
            requestId: input.requestId,
            basePriceMicros: (basePrice ?? 0n).toString(),
            addons,
            totalPriceMicros: total.toString(),
        },
    };
    const inserted = await DB.appendApiCallLog(entry);
    if (inserted) emitApiCostUpdated({ dateKey: localDateKey(timestamp), entryId: entry.id });
    return inserted;
}
