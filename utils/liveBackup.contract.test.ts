import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (file: string) => fs.readFileSync(path.resolve(process.cwd(), file), 'utf8');

describe('live backup wiring', () => {
  it('exports and imports the shared live registry through the full backup path', () => {
    const context = read('context/OSContext.tsx');
    const db = read('utils/db.ts');
    const types = read('types.ts');
    expect(context).toContain('LIVE_BACKUP_STORES.map(item => item.storeName)');
    expect(context).toContain('LIVE_BACKUP_FIELD_BY_STORE');
    expect(db).toContain('prepareLiveRowsForRestore');
    expect(db).toContain('for (const descriptor of LIVE_BACKUP_STORES)');
    for (const field of ['liveSettings', 'liveRooms', 'liveEvents', 'liveSessions']) {
      expect(types).toContain(`${field}?:`);
    }
  });
});
