import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

describe('Game Hall unrestricted rewrite contract', () => {
  it('passes the raw tools/list array with order and duplicate names intact', () => {
    const app = read('../apps/GameHallApp.tsx');
    const agent = read('./gameHallAgent.ts');
    expect(app).toContain('const availableTools = connection.tools || []');
    expect(app).not.toContain('uniqueTools(');
    expect(app).not.toContain('capabilities?.account || []');
    expect(agent).toContain('toolIndex');
    expect(agent).not.toContain('HISTORY_COUNT_LIMIT');
  });

  it('reuses the normal main-chat context builder instead of a reduced prompt', () => {
    const agent = read('./gameHallAgent.ts');
    expect(agent).toContain('buildChatRequestPayload');
    expect(agent).toContain('loadCharacterContextRange');
    expect(agent).toContain('DB.getEmojis()');
    expect(agent).not.toContain('stripGameHallMemorySignals');
    expect(agent).not.toContain('response_format');
    expect(agent).not.toMatch(/temperature\s*:\s*(?:0\.7|0\.55|0\.35)/);
  });

  it('makes all use-affecting execution rules visible and defaults schema blocking off', () => {
    const app = read('../apps/GameHallApp.tsx');
    const types = read('./gameHallTypes.ts');
    expect(app).toContain('schema 校验');
    expect(app).toContain('规划失败自动修正次数');
    expect(app).toContain('value={session?.schemaValidationMode || \'off\'}');
    expect(types).toContain("schemaValidationMode?: GameHallSchemaValidationMode");
    expect(app).not.toContain('lastAutoActionStateHash');
    expect(app).not.toContain('state?.allowsAiAction');
  });

  it('makes context exact and never couples range selection to deletion', () => {
    const app = read('../apps/GameHallApp.tsx');
    const context = read('./gameHallContext.ts');
    expect(app).toContain('最近多少条进入上下文（0 = 全部）');
    expect(app).toContain('查看本轮准确上下文');
    expect(context).toContain('绝不删除');
    expect(context).not.toContain('deleteGameHallMessages');
  });

  it('supports images, visible working status, raw requests and raw results', () => {
    const app = read('../apps/GameHallApp.tsx');
    const agent = read('./gameHallAgent.ts');
    expect(app).toContain('accept="image/*"');
    expect(app).toContain('prepareChatImageForSend');
    expect(app).toContain('runStatus');
    expect(app).toContain('完整工具请求');
    expect(app).toContain('完整工具返回（未打码、未截断）');
    expect(agent).toContain("type: 'image_url'");
  });

  it('atomically confirms the session and deletes exact source messages only after main-chat writes', () => {
    const handoff = read('./gameHallHandoff.ts');
    const store = read('./gameHallStore.ts');
    const summaryAt = handoff.indexOf('const summary = await summarizeHandoff');
    const cardAt = handoff.indexOf("type: 'game_hall_card'");
    const commitAt = handoff.indexOf('await commitGameHallHandoff(committedSession, meta.sourceMessageIds)');
    expect(summaryAt).toBeGreaterThan(-1);
    expect(cardAt).toBeGreaterThan(summaryAt);
    expect(commitAt).toBeGreaterThan(cardAt);
    expect(store).toContain('[GAME_HALL_STORES.sessions, GAME_HALL_STORES.messages]');
    expect(store).toContain('uniqueIds.forEach(id => messageStore.delete(id))');
    expect(handoff).toContain('原文未删除');
  });

  it('removes browser iframe sandbox instead of silently disabling site functions', () => {
    const surface = read('../components/gameHall/CedarToySurface.tsx');
    expect(surface).not.toContain('sandbox=');
    expect(surface).toContain('allowFullScreen');
  });
});
