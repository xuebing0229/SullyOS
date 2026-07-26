import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('mobile toggle track isolation', () => {
  it('uses the same padded track and translate pattern as stable chat toggles', () => {
    const source = readFileSync('components/settings/ImageGenerationSettings.tsx', 'utf8');
    expect(source).toContain('flex h-6 w-10 items-center rounded-full p-1 transition-colors');
    expect(source).toContain("checked ? 'translate-x-4' : ''");
    expect(source).toContain('appearance-none border-0 bg-transparent p-0');
  });

  it('isolates the schedule track from button theme styles', () => {
    const source = readFileSync('components/chat/ChatModals.tsx', 'utf8');
    expect(source).toContain('flex-shrink-0 appearance-none border-0 bg-transparent p-0');
    expect(source).toContain('flex h-6 w-10 items-center rounded-full p-1 transition-colors');
    expect(source).toContain("isScheduleFeatureEnabled ? 'translate-x-4' : ''");
  });
});
