import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('mobile toggle thumb containment', () => {
  it('anchors image engine thumb inside the track instead of translating it', () => {
    const source = readFileSync('components/settings/ImageGenerationSettings.tsx', 'utf8');
    expect(source).toContain("checked ? 'right-0.5' : 'left-0.5'");
    expect(source).toContain('overflow-hidden rounded-full');
    expect(source).not.toContain("checked ? 'translate-x-5' : 'translate-x-0.5'");
  });

  it('anchors schedule thumb inside the track in both states', () => {
    const source = readFileSync('components/chat/ChatModals.tsx', 'utf8');
    expect(source).toContain("isScheduleFeatureEnabled ? 'right-1' : 'left-1'");
    expect(source).not.toContain("isScheduleFeatureEnabled ? 'translate-x-4' : ''");
  });
});
