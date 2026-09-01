import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const settingsSource = readFileSync(
    new URL('../apps/Settings.tsx', import.meta.url),
    'utf8',
);

describe('Settings API preset per-model pricing entry contract', () => {
    it('keeps a visible pricing action for every saved model', () => {
        expect(settingsSource).toContain(
            "item.pricing ? '修改价格' : '设置价格'",
        );
        expect(settingsSource).toContain(
            'setPricingPresetId(preset.id)',
        );
        expect(settingsSource).toContain(
            'setPricingModel(item.model)',
        );
        expect(settingsSource).toContain(
            'getApiPresetPricing(preset, item.model)',
        );
    });

    it('saves pricing onto the targeted model instead of the preset root', () => {
        expect(settingsSource).toContain(
            'setApiPresetModelPricing(preset, pricingModel, pricingDraft)',
        );
        expect(settingsSource).toContain(
            'updateApiPreset(preset.id, { models: updated.models })',
        );
        expect(settingsSource).not.toContain(
            'updateApiPreset(preset.id, { pricing: pricingDraft })',
        );
    });

    it('does not make opening pricing also select or delete the preset', () => {
        const pricingStart = settingsSource.lastIndexOf(
            '<button',
            settingsSource.indexOf(
                'setPricingPresetId(preset.id)',
            ),
        );
        const pricingEnd = settingsSource.indexOf(
            '</button>',
            settingsSource.indexOf(
                'setPricingPresetId(preset.id)',
            ),
        );
        const pricingButton = settingsSource.slice(
            pricingStart,
            pricingEnd,
        );

        expect(pricingButton).toContain(
            'event.stopPropagation()',
        );
        expect(pricingButton).not.toContain(
            'deleteApiPreset(',
        );
        expect(pricingButton).not.toContain(
            'removeApiPreset(',
        );
    });
});
