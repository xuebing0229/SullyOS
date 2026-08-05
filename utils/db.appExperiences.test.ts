import { beforeEach, describe, expect, it } from 'vitest';
import { DB, openDB } from './db';
import type { FullBackupData } from '../types';

const now = 1719000000000;

beforeEach(async () => {
  await DB.deleteDB().catch(() => undefined);
  localStorage.clear();
});

describe.sequential('万象匣 + 素页同栖 v76 数据层', () => {
  it('创建七张 Store 与关键索引', async () => {
    const db = await openDB();
    const stores = [
      'simulator_projects', 'simulator_sessions', 'reading_projects',
      'reading_records', 'reading_writings', 'reading_style_presets',
      'app_memory_candidates',
    ];
    stores.forEach(name => expect(db.objectStoreNames.contains(name)).toBe(true));

    const tx = db.transaction(['simulator_sessions', 'reading_records', 'reading_writings', 'app_memory_candidates'], 'readonly');
    expect(Array.from(tx.objectStore('simulator_sessions').indexNames)).toEqual(expect.arrayContaining(['projectId', 'charId', 'updatedAt']));
    expect(Array.from(tx.objectStore('reading_records').indexNames)).toEqual(expect.arrayContaining(['projectId', 'segmentId', 'charId']));
    expect(Array.from(tx.objectStore('reading_writings').indexNames)).toEqual(expect.arrayContaining(['projectId', 'charId']));
    expect(Array.from(tx.objectStore('app_memory_candidates').indexNames)).toEqual(expect.arrayContaining(['charId', 'sourceApp', 'sourceRecordId', 'status']));
  });

  it('项目 CRUD 持久化且删除项目会级联清理局内数据', async () => {
    await DB.saveSimulatorProject({ id: 'sp1', name: '匣', mode: 'text', charId: 'c1', html: '', prompt: '', worldbookEnabled: true, regexEnabled: false, mainContextEnabled: true, localContextLimit: 20, createdAt: now, updatedAt: now });
    await DB.saveSimulatorSession({ id: 'ss1', projectId: 'sp1', charId: 'c1', status: 'active', turns: [], createdAt: now, updatedAt: now });
    expect(await DB.getSimulatorProjects()).toHaveLength(1);
    expect(await DB.getSimulatorSessionsByProject('sp1')).toHaveLength(1);
    await DB.deleteSimulatorProject('sp1');
    expect(await DB.getSimulatorProjects()).toHaveLength(0);
    expect(await DB.getSimulatorSessionsByProject('sp1')).toHaveLength(0);

    await DB.saveReadingProject({ id: 'rp1', title: '书', sourceName: 'a.md', format: 'md', charId: 'c1', segments: [], progressIndex: 0, localContextLimit: 20, createdAt: now, updatedAt: now });
    await DB.saveReadingRecord({ id: 'rr1', projectId: 'rp1', segmentId: 'seg1', charId: 'c1', type: 'annotation', role: 'assistant', content: '批注', createdAt: now });
    await DB.saveReadingWriting({ id: 'rw1', projectId: 'rp1', charId: 'c1', type: 'free', title: '文', prompt: '写', content: '正文', createdAt: now, updatedAt: now });
    expect(await DB.getReadingRecordsByProject('rp1')).toHaveLength(1);
    await DB.deleteReadingProject('rp1');
    expect(await DB.getReadingProjects()).toHaveLength(0);
    expect(await DB.getReadingRecordsByProject('rp1')).toHaveLength(0);
    expect(await DB.getRawStoreData('reading_writings')).toHaveLength(0);
  });

  it('importFullData 恢复七类独立数据', async () => {
    const backup: FullBackupData = {
      timestamp: now,
      version: 3,
      simulatorProjects: [{ id: 'sp', name: '匣', mode: 'html', charId: 'c', html: '<p>x</p>', prompt: '', worldbookEnabled: true, regexEnabled: false, mainContextEnabled: true, localContextLimit: 10, createdAt: now, updatedAt: now }],
      simulatorSessions: [{ id: 'ss', projectId: 'sp', charId: 'c', status: 'ended', turns: [], createdAt: now, updatedAt: now, endedAt: now }],
      readingProjects: [{ id: 'rp', title: '书', sourceName: 'b.txt', format: 'txt', charId: 'c', segments: [], progressIndex: 0, localContextLimit: 10, createdAt: now, updatedAt: now }],
      readingRecords: [{ id: 'rr', projectId: 'rp', segmentId: 's', charId: 'c', type: 'user_note', role: 'user', content: '记', createdAt: now }],
      readingWritings: [{ id: 'rw', projectId: 'rp', charId: 'c', type: 'continue', title: '续', prompt: '续写', content: '文', createdAt: now, updatedAt: now }],
      readingStylePresets: [{ id: 'style', name: '清淡', prompt: '克制', target: 'all', createdAt: now, updatedAt: now }],
      appMemoryCandidates: [{ id: 'am', charId: 'c', sourceApp: 'simulator', sourceRecordId: 'ss', title: '记忆', summary: '共同经历', room: 'living_room', tags: ['万象匣'], importance: 6, mood: 'warm', status: 'pending', createdAt: now, updatedAt: now }],
    };
    await DB.importFullData(backup);
    expect(await DB.getRawStoreData('simulator_projects')).toHaveLength(1);
    expect(await DB.getRawStoreData('simulator_sessions')).toHaveLength(1);
    expect(await DB.getRawStoreData('reading_projects')).toHaveLength(1);
    expect(await DB.getRawStoreData('reading_records')).toHaveLength(1);
    expect(await DB.getRawStoreData('reading_writings')).toHaveLength(1);
    expect(await DB.getRawStoreData('reading_style_presets')).toHaveLength(1);
    expect(await DB.getRawStoreData('app_memory_candidates')).toHaveLength(1);
  });
});
