import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FullBackupData } from '../types';
import { DB } from './db';
import { GAME_HALL_BACKUP_STORES } from './gameHallBackup';

const makeRows = (): Record<string, any[]> => Object.fromEntries(
  GAME_HALL_BACKUP_STORES.map((descriptor, index) => [
    descriptor.field,
    descriptor.storeName === 'characterExternalAccounts'
      ? [{
          accountRef: 'account:char-1:cedar:server-1',
          charId: 'char-1',
          provider: 'cedar',
          serverId: 'server-1',
          serverUrl: 'https://cedar.example',
          accountId: 'account-1',
          username: '角色账号',
          credentials: { token: 'exact-secret-token' },
          rawRegistrationResult: { token: 'exact-secret-token' },
          registrationToolName: 'register_account',
          registeredAt: 1,
          createdAt: 1,
          updatedAt: 1,
          status: 'active',
        }]
      : [{ id: `${descriptor.field}-${index}`, marker: descriptor.label }],
  ]),
);

describe.sequential('Game Hall database backup restore', () => {
  beforeEach(async () => {
    await DB.deleteDB();
    localStorage.clear();
  });

  afterEach(async () => {
    await DB.deleteDB();
  });

  it('restores every persistent Game Hall store from the shared registry', async () => {
    const rows = makeRows();
    const expected = structuredClone(rows);
    await DB.importFullData({
      timestamp: Date.now(),
      version: 3,
      ...rows,
    } as FullBackupData);

    for (const descriptor of GAME_HALL_BACKUP_STORES) {
      expect(await DB.getRawStoreData(descriptor.storeName)).toEqual(expected[descriptor.field]);
    }
  });

  it('an explicitly empty backup clears stale Game Hall rows', async () => {
    const rows = makeRows();
    await DB.importFullData({ timestamp: Date.now(), version: 3, ...rows } as FullBackupData);

    const empty = Object.fromEntries(GAME_HALL_BACKUP_STORES.map(item => [item.field, []]));
    await DB.importFullData({ timestamp: Date.now(), version: 3, ...empty } as FullBackupData);

    for (const descriptor of GAME_HALL_BACKUP_STORES) {
      expect(await DB.getRawStoreData(descriptor.storeName)).toEqual([]);
    }
  });

  it('preserves the persisted autoplay state inside the existing session store', async () => {
    const session = {
      id: 'session-autoplay',
      charId: 'char-1',
      mode: 'auto-turn',
      status: 'active',
      createdAt: 1,
      updatedAt: 2,
      autoplay: {
        version: 1,
        runId: 'run-1',
        status: 'paused',
        requestedFrom: 'main-chat',
        instruction: '继续玩到告一段落',
        returnToMainChat: true,
        turnCount: 4,
        maxTurns: null,
        stepDelayMs: 0,
        createdAt: 1,
        updatedAt: 2,
        latestState: { gameId: 'game-1', raw: { score: 9 } },
        stopReason: 'user-paused',
      },
    };
    const empty = Object.fromEntries(GAME_HALL_BACKUP_STORES.map(item => [item.field, []]));
    await DB.importFullData({
      timestamp: Date.now(),
      version: 3,
      ...empty,
      gameHallSessions: [session],
    } as FullBackupData);

    expect(await DB.getRawStoreData('gameHallSessions')).toEqual([session]);
  });

  it('preserves optional batched-turn fields in the existing session and message stores', async () => {
    const rows = makeRows();
    rows.gameHallSessions = [{
      id: 'session-batch', charId: 'char-1', mode: 'ask-before-action', status: 'active',
      openTurnId: 'turn-next',
      activeReplyTurn: {
        turnId: 'turn-failed', userMessageIds: ['message-1'], status: 'failed',
        requestedAt: 10, updatedAt: 11, error: '手动重试',
      },
      lastCompletedTurnId: 'turn-done', createdAt: 1, updatedAt: 11,
    }];
    rows.gameHallMessages = [{
      id: 'message-1', sessionId: 'session-batch', charId: 'char-1', role: 'user', content: '原消息',
      turnId: 'turn-failed', batchIndex: 0, displayType: 'text', replyRequestedAt: 10, createdAt: 2,
    }];
    const expectedSessions = structuredClone(rows.gameHallSessions);
    const expectedMessages = structuredClone(rows.gameHallMessages);
    await DB.importFullData({ timestamp: Date.now(), version: 3, ...rows } as FullBackupData);
    expect(await DB.getRawStoreData('gameHallSessions')).toEqual(expectedSessions);
    expect(await DB.getRawStoreData('gameHallMessages')).toEqual(expectedMessages);
  });

  it('pauses active autoplay sessions restored through importFullData', async () => {
    const empty = Object.fromEntries(GAME_HALL_BACKUP_STORES.map(item => [item.field, []]));
    await DB.importFullData({
      timestamp: Date.now(), version: 3, ...empty,
      gameHallSessions: [{
        id: 'session-running', charId: 'char-1', mode: 'auto-turn', status: 'active',
        openTurnId: 'turn-next', createdAt: 1, updatedAt: 2,
        autoplay: {
          version: 1, runId: 'run-1', status: 'running', requestedFrom: 'main-chat',
          instruction: '继续玩', returnToMainChat: true, turnCount: 4, maxTurns: null,
          stepDelayMs: 0, createdAt: 1, updatedAt: 2,
          latestState: { gameId: 'game-1', raw: { score: 9 } },
        },
      }],
      gameHallMessages: [{ id: 'm1', sessionId: 'session-running', charId: 'char-1', role: 'tool', content: '完整工具返回', createdAt: 3 }],
      characterExternalAccounts: [{ accountRef: 'a1', charId: 'char-1', provider: 'cedar', serverId: 's1', marker: 'account-kept' }],
    } as FullBackupData);
    const sessions = await DB.getRawStoreData('gameHallSessions');
    expect(sessions[0]).toMatchObject({
      id: 'session-running', openTurnId: 'turn-next',
      autoplay: { runId: 'run-1', status: 'paused', stopReason: 'restored-from-backup', turnCount: 4, latestState: { gameId: 'game-1', raw: { score: 9 } } },
    });
    expect(await DB.getRawStoreData('gameHallMessages')).toMatchObject([{ content: '完整工具返回' }]);
    expect(await DB.getRawStoreData('characterExternalAccounts')).toMatchObject([{ marker: 'account-kept' }]);
  });
});
