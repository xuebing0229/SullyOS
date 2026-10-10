import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

describe('DateSession coauthor UI contract', () => {
  const session = readFileSync('components/date/DateSession.tsx', 'utf8');
  const settings = readFileSync('components/date/DateSettings.tsx', 'utf8');

  it('exposes the dual-OC switch directly in the live meeting menu', () => {
    expect(session).toContain('coauthorUserEnabled');
    expect(session).toContain('强化模式 · {coauthorUserEnabled ? \'开\' : \'关\'}');
    expect(session).toContain('dateStyleConfig: {');
    expect(session).toContain('coauthorUser: next ? true : undefined');
    expect(session).toContain('AI 可替双方写台词和动作，下条回复生效');
  });

  it('keeps the detailed switch in meeting settings and names the panel clearly', () => {
    expect(session).toContain('见面设置');
    expect(settings).toContain('见面设置');
    expect(settings).toContain('强化模式 · 双 OC 演绎');
  });
});
