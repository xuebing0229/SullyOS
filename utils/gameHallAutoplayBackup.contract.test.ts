import fs from 'node:fs';
import path from 'node:path';
import {
  describe,
  expect,
  it,
} from 'vitest';

const read = (relative: string) =>
  fs.readFileSync(
    path.resolve(process.cwd(), relative),
    'utf8',
  );

describe('Game Hall autoplay backup integration contract', () => {
  it('declares one explicit FullBackupData field', () => {
    expect(read('types.ts')).toContain(
      'gameHallAutoplayLocal?',
    );
  });

  it('exports settings only in text/full backup', () => {
    const source = read('context/OSContext.tsx');
    expect(source).toContain(
      'exportGameHallAutoplayBackup',
    );
    expect(source).toContain(
      'gameHallAutoplayLocal:',
    );
    expect(source).toContain(
      'exportLegacySullyEventFlags',
    );
  });

  it('cleans old runtime keys before generic event flag restore', () => {
    const source = read('context/OSContext.tsx');
    expect(source).toContain(
      'stripGameHallAutoplayKeysFromLegacyFlags',
    );
    expect(source).toContain(
      'importGameHallAutoplayBackup',
    );
  });

  it('normalizes sessions inside DB.importFullData', () => {
    const source = read('utils/db.ts');
    expect(source).toContain(
      'prepareGameHallSessionsForRestore',
    );
  });

  it('does not add an autoplay object store', () => {
    const source = read('utils/db.ts');
    expect(source).not.toMatch(
      /STORE_GAME_HALL_AUTOPLAY/,
    );
    expect(source).not.toMatch(
      /createObjectStore\(['"]gameHallAutoplay/,
    );
  });

  it('shows restored sessions as paused', () => {
    const runner = read(
      'utils/gameHallAutoplayRunner.ts',
    );
    expect(runner).toContain(
      'restored-from-backup',
    );
    expect(runner).toContain(
      '从备份恢复',
    );
  });
});
