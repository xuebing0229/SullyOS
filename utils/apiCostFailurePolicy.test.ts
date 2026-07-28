import { describe, expect, it } from 'vitest';
import { failureMayHaveUpstreamCost } from './apiCostFailurePolicy';

describe('failed API cost policy', () => {
    it('treats missing response, timeout and server errors as cost unknown', () => {
        expect(failureMayHaveUpstreamCost(undefined)).toBe(true);
        expect(failureMayHaveUpstreamCost(408)).toBe(true);
        expect(failureMayHaveUpstreamCost(425)).toBe(true);
        expect(failureMayHaveUpstreamCost(500)).toBe(true);
        expect(failureMayHaveUpstreamCost(524)).toBe(true);
    });

    it('keeps clear client errors as free failures', () => {
        expect(failureMayHaveUpstreamCost(400)).toBe(false);
        expect(failureMayHaveUpstreamCost(401)).toBe(false);
        expect(failureMayHaveUpstreamCost(403)).toBe(false);
        expect(failureMayHaveUpstreamCost(404)).toBe(false);
        expect(failureMayHaveUpstreamCost(422)).toBe(false);
        expect(failureMayHaveUpstreamCost(429)).toBe(false);
    });
});
