import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('game hall API preset wiring', () => {
  it('uses the resolved game hall API for every game hall LLM call', () => {
    const source = readFileSync(
      new URL('../apps/GameHallApp.tsx', import.meta.url),
      'utf8',
    );

    expect(source.match(
      /const requestAi = resolveGameHallAiForRequest\(\);/g,
    )?.length).toBe(3);
    expect(source.match(
      /apiConfig: requestAi\.apiConfig/g,
    )?.length).toBe(3);
    expect(source.match(
      /apiIdentity: requestAi\.identity/g,
    )?.length).toBe(3);
    expect(source).toContain(
      'settings: loadGameHallAiSettings()',
    );
    expect(source).toContain(
      '游戏厅当前预设（可随时更换）',
    );
  });

  it('writes the actual selected preset identity into API request metadata', () => {
    const agent = readFileSync(
      new URL('./gameHallAgent.ts', import.meta.url),
      'utf8',
    );
    const handoff = readFileSync(
      new URL('./gameHallHandoff.ts', import.meta.url),
      'utf8',
    );

    expect(agent).toContain(
      'apiPresetId: input.apiIdentity?.presetId',
    );
    expect(agent).toContain(
      "purpose: '角色规划'",
    );
    expect(agent).toContain(
      "purpose: '工具结果回复'",
    );
    expect(handoff).toContain(
      "purpose: '回主对话交接总结'",
    );
  });

  it('includes the selector in the existing game hall local backup', () => {
    const adapter = readFileSync(
      new URL('./cedarToyMcpAdapter.ts', import.meta.url),
      'utf8',
    );

    expect(adapter).toContain('version: 2');
    expect(adapter).toContain(
      'aiSettings: normalizeGameHallAiSettings',
    );
    expect(adapter).toContain(
      'saveGameHallAiSettings',
    );
  });
  it('passes the explicit Game Hall preset id into central billing capture', () => {
    const osContext = readFileSync(
      new URL('../context/OSContext.tsx', import.meta.url),
      'utf8',
    );
    const apiLog = readFileSync(
      new URL('./apiCallLog.ts', import.meta.url),
      'utf8',
    );

    expect(apiLog).toContain('apiPresetId?: string');
    expect(osContext).toContain(
      'requestMeta?.apiPresetId || requestMeta?.failoverPresetId',
    );
  });

  it('preserves the atomic handoff commit while adding the selected preset', () => {
    const handoff = readFileSync(
      new URL('./gameHallHandoff.ts', import.meta.url),
      'utf8',
    );

    expect(handoff).toContain(
      'await commitGameHallHandoff(committedSession, meta.sourceMessageIds)',
    );
    expect(handoff).not.toContain(
      'await deleteGameHallMessages(meta.sourceMessageIds)',
    );
  });
});
