import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearCedarConnection,
  exportCedarToyConnectionForBackup,
  importCedarToyConnectionFromBackup,
  loadCedarConnection,
  saveCedarConnection,
} from './cedarToyMcpAdapter';
import { loadGameHallAiSettings, saveGameHallAiSettings } from './gameHallAiSettings';

describe('Cedar Toy connection backup', () => {
  beforeEach(() => localStorage.clear());

  it('round-trips URL, token, proxy and discovered tools', () => {
    saveCedarConnection({
      url: 'https://toy.example/mcp',
      token: 'bearer-token',
      proxyUrl: 'https://proxy.example',
      proxyKey: 'proxy-key',
      updatedAt: 123,
      tools: [{ name: 'read_state', inputSchema: { type: 'object' } }],
    });

    const backup = exportCedarToyConnectionForBackup();
    clearCedarConnection();
    expect(loadCedarConnection().url).toBe('');

    expect(importCedarToyConnectionFromBackup(backup)).toBe(true);
    expect(loadCedarConnection()).toEqual({
      url: 'https://toy.example/mcp',
      token: 'bearer-token',
      proxyUrl: 'https://proxy.example',
      proxyKey: 'proxy-key',
      updatedAt: 123,
      tools: [{ name: 'read_state', inputSchema: { type: 'object' } }],
    });
  });

  it('exports and restores an explicitly empty state so stale device config is cleared', () => {
    const emptyBackup = exportCedarToyConnectionForBackup();
    saveCedarConnection({ url: 'https://stale.example/mcp', token: 'stale', updatedAt: 1 });
    expect(importCedarToyConnectionFromBackup(emptyBackup)).toBe(true);
    expect(loadCedarConnection()).toMatchObject({
      url: '', token: '', proxyUrl: '', proxyKey: '', updatedAt: 0,
    });
    expect(loadCedarConnection().tools).toBeUndefined();
  });

  it('round-trips the Game Hall AI selection in backup v2', () => {
    saveGameHallAiSettings({
      source: 'preset',
      selectedPresetId: 'game-hall-line-b',
      updatedAt: 1,
    });

    const backup = exportCedarToyConnectionForBackup();
    expect(backup.version).toBe(2);
    expect(backup.aiSettings).toMatchObject({
      source: 'preset',
      selectedPresetId: 'game-hall-line-b',
    });

    saveGameHallAiSettings({ source: 'global', updatedAt: 2 });
    expect(importCedarToyConnectionFromBackup(backup)).toBe(true);
    expect(loadGameHallAiSettings()).toMatchObject({
      source: 'preset',
      selectedPresetId: 'game-hall-line-b',
    });
  });

  it('imports a v1 backup without overwriting the current Game Hall AI selection', () => {
    saveGameHallAiSettings({
      source: 'preset',
      selectedPresetId: 'keep-this-line',
      updatedAt: 1,
    });

    expect(importCedarToyConnectionFromBackup({
      version: 1,
      connection: { url: 'https://legacy.example/mcp', updatedAt: 3 },
    })).toBe(true);
    expect(loadCedarConnection().url).toBe('https://legacy.example/mcp');
    expect(loadGameHallAiSettings()).toMatchObject({
      source: 'preset',
      selectedPresetId: 'keep-this-line',
    });
  });

  it('rejects malformed backup objects without changing current config', () => {
    saveCedarConnection({ url: 'https://keep.example/mcp', updatedAt: 5 });
    expect(importCedarToyConnectionFromBackup({ version: 999 } as any)).toBe(false);
    expect(importCedarToyConnectionFromBackup({ version: 1, connection: [] } as any)).toBe(false);
    expect(loadCedarConnection().url).toBe('https://keep.example/mcp');
  });
});
