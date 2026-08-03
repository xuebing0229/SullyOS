import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

describe('Game Hall account + handoff architecture contract', () => {
  it('has no automatic secret redaction in Game Hall agent', () => {
    const source = read('./gameHallAgent.ts');
    expect(source).not.toContain('SECRET_FIELD_RE');
    expect(source).not.toContain('sanitizeToolResultValue');
    expect(source).not.toContain('[已隐藏]');
    expect(source).toContain('未打码、未删字段、未截断');
  });

  it('stores account before character response and state refresh', () => {
    const source = read('../apps/GameHallApp.tsx');
    const persist = source.indexOf('persistCharacterAccountFromToolResult');
    const respond = source.indexOf('respondToGameHallToolResult({');
    const refresh = source.indexOf('await refreshState(false)');
    expect(persist).toBeGreaterThan(-1);
    expect(respond).toBeGreaterThan(persist);
    expect(refresh).toBeGreaterThan(respond);
  });

  it('uses a true main-chat card rather than the old bridge snapshot', () => {
    const app = read('../apps/GameHallApp.tsx');
    const handoff = read('./gameHallHandoff.ts');
    expect(app).not.toContain('writeGameHallBridgeSnapshot');
    expect(app).not.toContain('recordGameHallMemoryEvent');
    expect(handoff).toContain("type: 'game_hall_card'");
    expect(handoff).toContain('DB.saveMessage');
    expect(app).toContain('setActiveCharacterId(selected.id)');
    expect(app).toContain("openApp('chat')");
  });
});
