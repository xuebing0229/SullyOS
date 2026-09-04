import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isMessageSemanticallyRelevant } from './messageFormat';

const source = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

describe('万象匣 / 素页同栖集成契约', () => {
  it('iframe 保持隔离 sandbox，并只接受当前 iframe 发来的动作', () => {
    const simulator = source('apps/SimulatorApp.tsx');
    expect(simulator).toContain('sandbox="allow-scripts allow-forms allow-modals"');
    expect(simulator).not.toContain('allow-same-origin');
    expect(simulator).toContain('event.source !== iframeRef.current?.contentWindow');
  });

  it('七类独立数据同时登记在 text/full 导出映射和导入恢复中', () => {
    const os = source('context/OSContext.tsx');
    const db = source('utils/db.ts');
    const pairs = [
      ['simulator_projects', 'simulatorProjects'],
      ['simulator_sessions', 'simulatorSessions'],
      ['reading_projects', 'readingProjects'],
      ['reading_records', 'readingRecords'],
      ['reading_writings', 'readingWritings'],
      ['reading_style_presets', 'readingStylePresets'],
      ['app_memory_candidates', 'appMemoryCandidates'],
    ];
    for (const [store, field] of pairs) {
      expect(os).toContain(`${store}: '${field}'`);
      expect(os).toContain(`case '${store}': backupData.${field} = processedData`);
      expect(db).toContain(`data.${field} !== undefined`);
    }
  });

  it('确认后的 app_memory_card 仍显示在聊天，但不进入二次记忆提取', () => {
    const card = {
      id: 1,
      charId: 'c',
      role: 'assistant',
      type: 'app_memory_card',
      content: '共同经历',
      timestamp: 1,
      metadata: { skipMemoryExtraction: true, appMemoryCard: true },
    } as any;
    expect(isMessageSemanticallyRelevant(card)).toBe(false);
    expect(source('components/chat/MessageItem.tsx')).toContain("m.type === 'app_memory_card'");
  });

  it('App 文本调用显式禁用自动重试并记录 App/用途 meta', () => {
    const context = source('utils/appContext.ts');
    expect(context).toContain('}, 0, 0, {');
    expect(context).toContain("deps.sourceApp === 'reading_together' ? '素页同栖'");
    expect(context).toContain("deps.sourceApp === 'story_theater' ? '剧情剧场'");
    expect(context).toContain("purpose: deps.purpose || 'App 内文本生成'");
  });
});
