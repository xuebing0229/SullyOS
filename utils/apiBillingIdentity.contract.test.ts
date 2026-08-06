import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('API billing identity wiring contract', () => {
    it('passes explicit preset identity and request headers to billing capture', () => {
        const source = readFileSync(
            new URL('../context/OSContext.tsx', import.meta.url),
            'utf8',
        );

        expect(source).toContain(
            'requestMeta?.apiPresetId',
        );
        expect(source).toContain(
            'requestMeta?.failoverPresetId',
        );
        expect(source).toContain('requestHeaders');
        expect(source).toContain(
            'captureApiBillingContext(',
        );
    });

    it('marks direct and failover requests with the actual route preset', () => {
        const source = readFileSync(
            new URL('./apiFailover.ts', import.meta.url),
            'utf8',
        );

        expect(source).toContain(
            'apiPresetId:',
        );
        expect(source).toContain(
            'apiPresetName:',
        );
        expect(source).toContain(
            'findApiPresetForConfig',
        );
    });
});
