import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('NovelAI 精密参照集成接线', () => {
  it('私聊正规 FC 与正文兼容路径都准备参数', () => {
    const source = readFileSync('hooks/useChatAI.ts', 'utf8');
    expect(source.match(/prepareBuiltinImageToolArguments/g)?.length).toBeGreaterThanOrEqual(3);
    expect(source).toContain('character: char');
  });
  it('群聊两条路径传入当前发言角色与用户参考图', () => {
    const source = readFileSync('utils/groupChat/mcp.ts', 'utf8');
    expect(source.match(/character: options\.character/g)?.length).toBe(2);
    expect(source.match(/userProfile: options\.userProfile/g)?.length).toBe(2);
  });
  it('角色编辑页和三种备份模式已接线', () => {
    expect(readFileSync('apps/Character.tsx', 'utf8')).toContain('<NovelAiReferenceSettings');
    const os = readFileSync('context/OSContext.tsx', 'utf8');
    expect(os).toContain('rawData.map(stripNovelAiReferenceForTextOnlyBackup)');
    expect(os).toContain('novelAiReference: c.novelAiReference');
    expect(readFileSync('utils/db.ts', 'utf8')).toContain('novelAiReference: media.novelAiReference || c.novelAiReference');
  });
  it('Vibe 图库从加号菜单接入，并作为独立 style 参考注入', () => {
    const input = readFileSync('components/chat/ChatInputArea.tsx', 'utf8');
    const chat = readFileSync('apps/Chat.tsx', 'utf8');
    const reference = readFileSync('utils/novelAiReference.ts', 'utf8');
    expect(input).toContain("onPanelAction('vibe-reference')");
    expect(chat).toContain('setShowVibeReferenceLibrary(true)');
    expect(reference).toContain('vibe_reference_id: vibeReference.slotId');
    expect(reference).toContain('reference_id: characterReference.slotId');
  });
});
