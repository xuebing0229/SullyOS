import { describe, expect, it } from 'vitest';
import { buildGameHallHandoffMeta } from './gameHallHandoff';
import type {
  CharacterExternalAccount,
  GameHallMessage,
  GameHallSession,
} from './gameHallTypes';

const session: GameHallSession = {
  id: 's1',
  charId: 'c1',
  mode: 'ask-before-action',
  status: 'active',
  gameName: 'Cedar Toy',
  createdAt: 1,
  updatedAt: 1,
};

const account: CharacterExternalAccount = {
  accountRef: 'cedar_toy:server:c1',
  charId: 'c1',
  provider: 'cedar_toy',
  serverId: 'server',
  serverUrl: 'https://example.test/mcp',
  sourceToolName: 'account',
  credentials: { token: 'EXACT_TOKEN' },
  rawRegistrationResult: { token: 'EXACT_TOKEN' },
  status: 'active',
  createdAt: 1,
  updatedAt: 1,
};

const messages: GameHallMessage[] = [
  { id: 'm1', sessionId: 's1', charId: 'c1', role: 'user', content: '去主对话继续说这个。', createdAt: 10 },
  { id: 'm2', sessionId: 's1', charId: 'c1', role: 'assistant', content: '好，我们回去接着说。', createdAt: 11 },
  {
    id: 'm3',
    sessionId: 's1',
    charId: 'c1',
    role: 'tool',
    content: '已确认执行 account 成功。',
    toolName: 'account',
    accountRef: account.accountRef,
    toolResult: { success: true, rawResult: { token: 'EXACT_TOKEN' } },
    createdAt: 12,
  },
];

describe('game hall main-chat handoff', () => {
  it('creates a normal main-chat card payload with conversation and accountRef', () => {
    const meta = buildGameHallHandoffMeta({
      session,
      messages,
      accounts: [account],
      charName: '祁连云',
    });
    expect(meta.gameHallCard).toBe(true);
    expect(meta.transcript.map(line => line.text)).toContain('去主对话继续说这个。');
    expect(meta.transcript.map(line => line.text)).toContain('好，我们回去接着说。');
    expect(meta.accountRefs).toContain(account.accountRef);
  });

  it('does not copy credentials into the memory card; it references the exact account record', () => {
    const meta = buildGameHallHandoffMeta({
      session,
      messages,
      accounts: [account],
      charName: '祁连云',
    });
    expect(JSON.stringify(meta)).not.toContain('EXACT_TOKEN');
    expect(JSON.stringify(meta)).toContain(account.accountRef);
  });
});
