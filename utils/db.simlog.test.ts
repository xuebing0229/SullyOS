import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import { DB } from './db';
import { assembleV2Backup, writeV2Backup } from './backupFormat';
import type { CharacterProfile } from '../types';

// 复现「人格模拟生活记录导出再导入后消失」的报障：
// simLogs 存在 char.phoneState.simLogs，应随角色走现行 ZIP v2 备份链路。
describe('生活记录 (phoneState.simLogs) ZIP v2 导出/导入 round-trip', () => {
  it('当前 ZIP v2 链路写入并组装后，importFullData 能恢复 simLogs', async () => {
    const char = {
      id: 'sim-rt-char',
      name: '阿狸',
      persona: '测试角色',
      phoneState: {
        records: [],
        simLogs: [
          { id: 'sim-1', mode: 'daily', theme: '雨天', title: '一个雨天', summary: '', ending: 'soft', beatsCount: 12, memoryText: '下了一天的雨。', timestamp: 1718900000000,
            script: { title: '一个雨天', summary: '', ending: 'soft', beats: [
              { kind: 'lock', time: '07:00', monologue: '不想起床。' },
              { kind: 'thought', monologue: '又下雨了。', vibe: 'numb' },
              { kind: 'end' },
            ] } },
          { id: 'sim-2', mode: 'event', theme: '搬家', title: '搬家那天', summary: '', ending: 'open', beatsCount: 20, memoryText: '箱子堆满了客厅。', timestamp: 1718990000000 },
        ],
      },
    } as unknown as CharacterProfile;

    await DB.saveCharacter(char);

    // 与 OSContext.exportSystem 相同地读取 characters store，并走现行 ZIP v2 写入/组装。
    const zip = new JSZip();
    const manifest = await writeV2Backup(zip, {
      characters: await DB.getRawStoreData('characters'),
    });
    const onDisk = await assembleV2Backup(zip, manifest);

    const exportedChar = (onDisk.characters as CharacterProfile[]).find(c => c.id === 'sim-rt-char');
    expect(exportedChar?.phoneState?.simLogs?.length).toBe(2);

    await DB.saveCharacter({ ...char, phoneState: { records: [] } } as any);
    await DB.importFullData(onDisk as any, {});

    const restored = (await DB.getAllCharacters()).find(c => c.id === 'sim-rt-char');
    const restoredLogs = restored?.phoneState?.simLogs;
    expect(restoredLogs?.length).toBe(2);
    expect(restoredLogs?.[0].memoryText).toBe('下了一天的雨。');
    expect(restoredLogs?.[0].script?.beats?.length).toBe(3);
    expect(restoredLogs?.[0].script?.beats?.[0].monologue).toBe('不想起床。');
    expect(restoredLogs?.[1].script).toBeUndefined();
  });
});
