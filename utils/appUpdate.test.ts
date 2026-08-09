import { describe, expect, it, vi } from 'vitest';

vi.mock('./buildInfo', () => ({ APP_RELEASE_VERSION: '2.3.0' }));

import { compareVersions } from './appUpdate';

describe('compareVersions', () => {
    it('compares normal semantic versions', () => {
        expect(compareVersions('2.3.0', '2.2.9')).toBe(1);
        expect(compareVersions('2.3.0', '2.3.1')).toBe(-1);
        expect(compareVersions('v2.3.0', '2.3.0')).toBe(0);
    });

    it('normalizes missing version segments', () => {
        expect(compareVersions('2.3', '2.3.0')).toBe(0);
        expect(compareVersions('2.3.1', '2.3')).toBe(1);
    });

    it('does not treat malformed labels as newer', () => {
        expect(compareVersions('latest', '2.3.0')).toBe(0);
    });
});
