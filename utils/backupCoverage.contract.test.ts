import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { GAME_HALL_BACKUP_STORES } from './gameHallBackup';

const read = (relative: string) => readFileSync(new URL(`../${relative}`, import.meta.url), 'utf8');
const osContext = read('context/OSContext.tsx');
const dbSource = read('utils/db.ts');
const typesSource = read('types.ts');

describe('backup coverage contract', () => {
  it('exports and imports every persistent Game Hall store through the shared registry', () => {
    expect(osContext).toContain('GAME_HALL_BACKUP_STORES.map(item => item.storeName)');
    expect(osContext).toContain('GAME_HALL_BACKUP_FIELD_BY_STORE');
    expect(dbSource).toContain('for (const descriptor of GAME_HALL_BACKUP_STORES)');
    const declaredGameHallStores = [...dbSource.matchAll(/const STORE_GAME_HALL_[A-Z_]+ = '([^']+)'/g)]
      .map(match => match[1])
      .filter(name => name !== 'gameHallProtocolCache')
      .sort();
    expect(declaredGameHallStores).toEqual(
      GAME_HALL_BACKUP_STORES.map(item => item.storeName).slice().sort(),
    );
    for (const descriptor of GAME_HALL_BACKUP_STORES) {
      expect(typesSource).toContain(`${descriptor.field}?:`);
      expect(osContext).not.toContain(`case '${descriptor.storeName}'`);
    }
    expect(osContext).not.toContain("'gameHallProtocolCache'");
  });

  it('backs up the five-day API detail log without rebuilding permanent daily summaries', () => {
    expect(osContext).toContain('apiCallLog: (mode === \'text_only\' || mode === \'full\') ? await DB.getApiCallLog() : undefined');
    expect(dbSource).toContain('replaceApiCallLog: async');
    const method = dbSource.slice(
      dbSource.indexOf('replaceApiCallLog: async'),
      dbSource.indexOf('replaceApiCallLogAndRebuildCost: async'),
    );
    expect(method).toContain('STORE_API_CALL_LOG');
    expect(method).not.toContain('STORE_API_COST_DAILY');
  });

  it('backs up Cedar connection and resumable background image jobs in text/full only', () => {
    expect(osContext).toContain('gameHallCedarConnection:');
    expect(osContext).toContain('backgroundImageJobs:');
    expect(osContext).toContain('importCedarToyConnectionFromBackup');
    expect(osContext).toContain('importBackgroundImageJobsFromBackup');
    expect(typesSource).toContain('gameHallCedarConnection?:');
    expect(typesSource).toContain('backgroundImageJobs?:');
  });

  it('continues to exclude rebuildable caches', () => {
    expect(osContext).not.toContain("'ai_response_cache'");
    expect(osContext).not.toContain("'gameHallProtocolCache'");
  });

  it('backs up Game Hall local settings without runtime commands', () => {
    expect(typesSource).toContain('gameHallAutoplayLocal?');
    expect(osContext).toContain('gameHallAutoplayLocal:');
    expect(osContext).toContain('exportGameHallAutoplayBackup');
    expect(osContext).toContain('importGameHallAutoplayBackup');
    expect(osContext).toContain('exportLegacySullyEventFlags');
    const backupSource = read('utils/gameHallAutoplayBackup.ts');
    expect(backupSource).toContain('GAME_HALL_AUTOPLAY_COMMAND_QUEUE_STORAGE_KEY');
    expect(backupSource).toContain('clearGameHallAutoplayCommandQueue');
  });
});
