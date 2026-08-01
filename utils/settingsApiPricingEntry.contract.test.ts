import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const settingsSource = readFileSync(
    new URL('../apps/Settings.tsx', import.meta.url),
    'utf8',
);

describe('Settings API preset pricing entry contract', () => {
    it('keeps a visible pricing action for every API preset', () => {
        expect(settingsSource).toContain(
            "preset.pricing ? '修改价格' : '设置价格'",
        );
        expect(settingsSource).toContain(
            'setPricingPresetId(preset.id)',
        );
        expect(settingsSource).toContain(
            'setPricingDraft(',
        );
    });

    it('keeps pricing and safe-delete as separate actions', () => {
        const pricingIndex = settingsSource.indexOf(
            'setPricingPresetId(preset.id)',
        );
        const safeDeleteIndex = settingsSource.indexOf(
            'aria-label={`长按或双击删除预设 ${preset.name}`}',
        );

        expect(pricingIndex).toBeGreaterThan(-1);
        expect(safeDeleteIndex).toBeGreaterThan(-1);
        expect(pricingIndex).toBeLessThan(safeDeleteIndex);
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
            'loadPreset(',
        );
        expect(pricingButton).not.toContain(
            'deleteApiPreset(',
        );
        expect(pricingButton).not.toContain(
            'removeApiPreset(',
        );
    });
});
