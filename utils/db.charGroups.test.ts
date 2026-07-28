import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import { DB } from './db';
import { assembleV2Backup, writeV2Backup } from './backupFormat';
import type { CharacterProfile, CharacterGroup } from '../types';

// 角色分组的现行 ZIP v2 导出/导入 round-trip：
// 分组定义存独立 store（character_groups），角色只带 groupId 指针——
// 两边必须同进退，漏掉任何一边都会让导入端全员回落「未分组」。
describe('角色分组 (character_groups + groupId) ZIP v2 导出/导入 round-trip', () => {
  it('当前 ZIP v2 链路写入并组装后，importFullData 能恢复分组定义与角色 groupId', async () => {
    const group: CharacterGroup = { id: 'cgroup-rt-1', name: '测试分组', createdAt: 1718900000000 };
    const char = {
      id: 'cgroup-rt-char',
      name: '小组员',
      avatar: '',
      description: '',
      systemPrompt: '',
      memories: [],
      groupId: 'cgroup-rt-1',
    } as unknown as CharacterProfile;

    await DB.saveCharacterGroup(group);
    await DB.saveCharacter(char);

    // 与 OSContext.exportSystem 相同的 store → 备份字段映射，再走现行 ZIP v2 写入/组装。
    const zip = new JSZip();
    const manifest = await writeV2Backup(zip, {
      characters: await DB.getRawStoreData('characters'),
      characterGroups: await DB.getRawStoreData('character_groups'),
    });
    const onDisk = await assembleV2Backup(zip, manifest);

    expect((onDisk.characterGroups as CharacterGroup[]).find(g => g.id === 'cgroup-rt-1')?.name).toBe('测试分组');
    expect((onDisk.characters as CharacterProfile[]).find(c => c.id === 'cgroup-rt-char')?.groupId).toBe('cgroup-rt-1');

    await DB.deleteCharacterGroup('cgroup-rt-1');
    await DB.saveCharacter({ ...char, groupId: undefined } as any);
    await DB.importFullData(onDisk as any, {});

    const groups = await DB.getCharacterGroups();
    expect(groups.find(g => g.id === 'cgroup-rt-1')?.name).toBe('测试分组');
    const restored = (await DB.getAllCharacters()).find(c => c.id === 'cgroup-rt-char');
    expect(restored?.groupId).toBe('cgroup-rt-1');
  });
});
