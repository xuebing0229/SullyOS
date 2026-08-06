import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildGameHallHandoffMeta } from './gameHallHandoff';
import type { CharacterExternalAccount, GameHallMessage, GameHallSession } from './gameHallTypes';

const handoffSource = readFileSync(new URL('./gameHallHandoff.ts', import.meta.url), 'utf8');
const storeSource = readFileSync(new URL('./gameHallStore.ts', import.meta.url), 'utf8');

const session: GameHallSession = {
  id: 's1', charId: 'c1', mode: 'ask-before-action', status: 'active',
  gameName: 'Cedar Toy', createdAt: 1, updatedAt: 1,
};
const account: CharacterExternalAccount = {
  accountRef: 'cedar_toy:server:c1:account1', charId: 'c1', provider: 'cedar_toy',
  serverId: 'server', serverUrl: 'https://example.test', identityEndpoint: 'https://example.test/TOKEN',
  sourceToolName: 'account', credentials: { token: 'EXACT_TOKEN' },
  rawRegistrationResult: { token: 'EXACT_TOKEN' }, status: 'active', createdAt: 1, updatedAt: 1,
};
const sourceMessages: GameHallMessage[] = [
  { id: 'm1', sessionId: 's1', charId: 'c1', role: 'user', content: '回主对话继续。', createdAt: 10 },
  { id: 'm2', sessionId: 's1', charId: 'c1', role: 'assistant', content: '好。', createdAt: 11 },
];

describe('game hall main-chat handoff meta', () => {
  it('records exact source ids/count and stores the generated summary', () => {
    const meta = buildGameHallHandoffMeta({
      session,
      sourceMessages,
      accounts: [account],
      summary: '刚才约好回主对话继续讨论街机游戏。',
      transferredImageCount: 0,
    });
    expect(meta.sourceMessageIds).toEqual(['m1', 'm2']);
    expect(meta.sourceMessageCount).toBe(2);
    expect(meta.summary).toContain('街机游戏');
    expect(meta.transcript.map(line => line.text).join('\n')).toContain('街机游戏');
  });

  it('keeps the exact accountRef in the handoff metadata', () => {
    const meta = buildGameHallHandoffMeta({
      session,
      sourceMessages,
      accounts: [account],
      summary: '角色账号已经绑定，可继续玩。',
      transferredImageCount: 0,
    });
    expect(meta.accountRefs).toContain(account.accountRef);
  });
  it('atomically confirms the handoff cursor and deletes exact source messages last', () => {
    expect(storeSource).toContain('export async function commitGameHallHandoff');
    expect(storeSource).toContain('[GAME_HALL_STORES.sessions, GAME_HALL_STORES.messages]');
    expect(storeSource).toContain('tx.objectStore(GAME_HALL_STORES.sessions).put(session)');
    expect(storeSource).toContain('uniqueIds.forEach(id => messageStore.delete(id))');
    expect(handoffSource).toContain('await commitGameHallHandoff(committedSession, meta.sourceMessageIds)');
    expect(handoffSource.indexOf('cardMessageId = await DB.saveMessage')).toBeLessThan(
      handoffSource.indexOf('await commitGameHallHandoff(committedSession, meta.sourceMessageIds)'),
    );
    expect(handoffSource).toContain('await DB.deleteMessages(rollbackIds).catch(() => undefined)');
  });

  it('excludes the unsealed open turn and failed/running active reply turn from handoff deletion', () => {
    expect(handoffSource).toContain('session.openTurnId');
    expect(handoffSource).toContain('session.activeReplyTurn?.turnId');
    expect(handoffSource).toContain('!excludedTurnIds.has(message.turnId)');
  });

});
