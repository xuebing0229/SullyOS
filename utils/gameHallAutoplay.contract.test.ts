import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (relative: string) =>
  fs.readFileSync(
    path.resolve(process.cwd(), relative),
    'utf8',
  );

describe('game hall autoplay integration contract', () => {
  it('normal chat enables autoplay control prompt', () => {
    const source = read('hooks/useChatAI.ts');
    expect(source).toContain(
      'allowGameHallAutoplayControl: true',
    );
  });

  it('game hall agent disables recursive control prompt', () => {
    const source = read('utils/gameHallAgent.ts');
    expect(source).toContain(
      'allowGameHallAutoplayControl: false',
    );
  });

  it('global host is mounted beside PhoneShell', () => {
    const source = read('App.tsx');
    expect(source).toContain('<GameHallAutoplayHost');
  });

  it('runner does not use old hidden state gates', () => {
    const source = read(
      'utils/gameHallAutoplayRunner.ts',
    );
    expect(source).not.toContain(
      'lastAgentActionStateHash',
    );
    expect(source).not.toContain(
      'allowsAiAction === false',
    );
    expect(source).not.toContain(
      'currentTurn !==',
    );
  });

  it('no hidden default max turn cap exists', () => {
    const settings = read(
      'utils/gameHallApiPreset.ts',
    );
    expect(settings).toContain('maxTurns: null');
  });

  it('does not add a store or upgrade IndexedDB', () => {
    const db = read('utils/db.ts');
    expect(db).toContain('const DB_VERSION = 76');
    expect(db).not.toContain('gameHallAutoplaySessions');
    expect(db).not.toContain('gameHallAutoplayState');
  });

  it('game hall UI uses its own API preset and queues user messages while autoplay remains context-aware', () => {
    const source = read('apps/GameHallApp.tsx');
    const runner = read('utils/gameHallAutoplayRunner.ts');
    expect(source).toContain('resolveGameHallAiForRequest');
    expect(source).toContain('resolvedGameHallAi.apiConfig');
    expect(source).toContain('apiIdentity: requestAi.identity');
    expect(source).toContain('await queueUserMessage(text);');
    expect(source).toContain("await queueUserMessage(caption || '[图片]'");
    expect(runner).toContain('resolveApi: () =>');
    expect(runner).toContain('getGameHallMessages(session.id)');
    expect(runner).toContain('下一步立刻可见');
  });

  it('hidden commands are stripped from bubbles, notifications and push segments', () => {
    const source = read('utils/sanitize.ts');
    expect(source).toContain('stripGameHallAutoplayCommands(result)');
    expect(source).toContain('stripGameHallAutoplayCommands(cleaned)');
    expect(source).toContain('GAME_HALL_AUTOPLAY_(?:START|PAUSE|RESUME|STOP)');
  });

  it('paused sessions are restored by the global host without planning', () => {
    const host = read('components/GameHallAutoplayHost.tsx');
    const runner = read('utils/gameHallAutoplayRunner.ts');
    expect(host).toContain("['queued', 'running', 'paused', 'stopping']");
    expect(runner.indexOf("autoplay.status === 'paused'")).toBeLessThan(
      runner.indexOf('plan = await planGameHallTurn'),
    );
  });

  it('runner rechecks persisted pause and stop state after planning', () => {
    const source = read('utils/gameHallAutoplayRunner.ts');
    expect(source).toContain('const latestAfterPlan = await getGameHallSession(session.id) || session');
    expect(source).toContain("latestAfterPlan.autoplay?.status === 'paused'");
    expect(source).toContain("latestAfterPlan.autoplay?.status === 'stopping'");
  });

  it('Instant Push tool requests persist and replay autoplay directives before tools', () => {
    const worker = read('worker/sw-keep-alive.ts');
    const runner = read('utils/instantToolRunner.ts');
    const types = read('types.ts');
    expect(types).toContain('directives?: Array<Record<string, unknown>>');
    expect(worker).toContain('directives: Array.isArray(payload?.metadata?.directives)');
    expect(runner).toContain('enqueueInstantToolAutoplayDirectives(item);');
    expect(runner.indexOf('enqueueInstantToolAutoplayDirectives(item);')).toBeLessThan(
      runner.indexOf('for (const call of item.toolCalls)'),
    );
  });
});
