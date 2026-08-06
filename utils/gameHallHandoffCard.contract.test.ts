import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

describe('GameHallHandoffCard responsive width contract', () => {
  it('matches the VR card width and wraps long handoff content', () => {
    const source = fs.readFileSync(
      path.resolve(process.cwd(), 'components/chat/GameHallHandoffCard.tsx'),
      'utf8',
    );

    expect(source).toContain('w-64 max-w-full overflow-hidden');
    expect(source).not.toContain('w-72 overflow-hidden');
    expect(source).toContain('whitespace-pre-wrap break-words [overflow-wrap:anywhere]');
    expect(source).toContain('className="mt-1 break-all font-mono');
  });
});
