import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('NovelAI 精密参照集成接线', () => {
  it('私聊正规 FC 与正文兼容路径都准备参数', () => {
    const source = readFileSync('hooks/useChatAI.ts', 'utf8');
    expect(source.match(/prepareBuiltinImageToolArguments/g)?.length).toBeGreaterThanOrEqual(3);
    expect(source).toContain('character: char');
  });
  it('群聊两条路径显式禁用自动锁脸', () => {
    const source = readFileSync('utils/groupChat/mcp.ts', 'utf8');
    expect(source.match(/character: null/g)?.length).toBe(2);
  });
  it('角色编辑页和三种备份模式已接线', () => {
    expect(readFileSync('apps/Character.tsx', 'utf8')).toContain('<NovelAiReferenceSettings');
    const os = readFileSync('context/OSContext.tsx', 'utf8');
    expect(os).toContain('rawData.map(stripNovelAiReferenceForTextOnlyBackup)');
    expect(os).toContain('novelAiReference: c.novelAiReference');
    expect(readFileSync('utils/db.ts', 'utf8')).toContain('novelAiReference: media.novelAiReference || c.novelAiReference');
  });
});
