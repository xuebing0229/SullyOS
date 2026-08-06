import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DB } from './db';
import {
  getGameHallMessages,
  getGameHallSession,
  getOpenGameHallUserMessages,
  recoverInterruptedGameHallReplyTurn,
  saveGameHallMessage,
  saveGameHallSession,
  sealGameHallTurnForReply,
} from './gameHallStore';
import type { GameHallMessage, GameHallSession } from './gameHallTypes';

const session = (): GameHallSession => ({
  id: 'session-1', charId: 'char-1', mode: 'ask-before-action', status: 'active',
  openTurnId: 'turn-open', createdAt: 1, updatedAt: 1,
});

const message = (index: number, turnId = 'turn-open'): GameHallMessage => ({
  id: `message-${index}`, sessionId: 'session-1', charId: 'char-1', role: 'user',
  content: `user-${index}`, turnId, batchIndex: index, createdAt: index + 1,
});

describe.sequential('Game Hall batched reply turns', () => {
  beforeEach(async () => { await DB.deleteDB(); localStorage.clear(); });
  afterEach(async () => { await DB.deleteDB(); });

  it('keeps three queued user messages in one open turn and seals them atomically', async () => {
    await saveGameHallSession(session());
    await Promise.all([0, 1, 2].map(index => saveGameHallMessage(message(index))));
    const before = await getGameHallMessages('session-1');
    expect(getOpenGameHallUserMessages(before, 'turn-open')).toHaveLength(3);

    const sealed = await sealGameHallTurnForReply({
      sessionId: 'session-1', expectedOpenTurnId: 'turn-open', userMessageIds: before.map(item => item.id),
    });
    expect(sealed.activeReplyTurn?.userMessageIds).toEqual(['message-0', 'message-1', 'message-2']);
    expect(sealed.openTurnId).not.toBe('turn-open');
    const saved = await getGameHallMessages('session-1');
    expect(new Set(saved.map(item => item.replyRequestedAt)).size).toBe(1);
    expect(saved.every(item => !!item.replyRequestedAt)).toBe(true);

    await saveGameHallMessage(message(3, sealed.openTurnId));
    const after = await getGameHallMessages('session-1');
    expect(getOpenGameHallUserMessages(after, sealed.openTurnId).map(item => item.id)).toEqual(['message-3']);
  });

  it('converts an interrupted running turn to failed without creating messages or retrying', async () => {
    const running: GameHallSession = {
      ...session(), openTurnId: 'next-turn',
      activeReplyTurn: { turnId: 'turn-open', userMessageIds: ['message-0'], status: 'running', requestedAt: 2, updatedAt: 2 },
    };
    await saveGameHallSession(running);
    await saveGameHallMessage({ ...message(0), replyRequestedAt: 2 });
    const recovered = await recoverInterruptedGameHallReplyTurn((await getGameHallSession('session-1'))!);
    expect(recovered.activeReplyTurn?.status).toBe('failed');
    expect(recovered.activeReplyTurn?.error).toContain('手动重试');
    expect(await getGameHallMessages('session-1')).toHaveLength(1);
  });

  it('refuses to seal a stale subset when a newly persisted message belongs to the same open turn', async () => {
    await saveGameHallSession(session());
    await saveGameHallMessage(message(0));
    await saveGameHallMessage(message(1));
    await expect(sealGameHallTurnForReply({
      sessionId: 'session-1', expectedOpenTurnId: 'turn-open', userMessageIds: ['message-0'],
    })).rejects.toThrow('本轮消息已经变化');
    const unchanged = await getGameHallSession('session-1');
    expect(unchanged?.openTurnId).toBe('turn-open');
    expect(unchanged?.activeReplyTurn).toBeUndefined();
    expect((await getGameHallMessages('session-1')).every(item => !item.replyRequestedAt)).toBe(true);
  });
});