import { beforeEach, describe, expect, it, vi } from 'vitest';

const fakes = vi.hoisted(() => ({
  session: null as any,
  messages: [] as any[],
  actions: [] as any[],
  ids: 0,
  plan: vi.fn(),
  execute: vi.fn(),
  handoff: vi.fn(),
}));

vi.mock('./gameHallStore', () => ({
  gameHallId: (prefix: string) => `${prefix}_${++fakes.ids}`,
  getGameHallSession: vi.fn(async () => fakes.session),
  saveGameHallSession: vi.fn(async (session: any) => { fakes.session = structuredClone(session); }),
  getGameHallMessages: vi.fn(async () => [...fakes.messages]),
  saveGameHallMessage: vi.fn(async (message: any) => { fakes.messages.push(structuredClone(message)); }),
  savePendingGameHallAction: vi.fn(async (action: any) => {
    const index = fakes.actions.findIndex(item => item.id === action.id);
    if (index >= 0) fakes.actions[index] = structuredClone(action);
    else fakes.actions.push(structuredClone(action));
  }),
}));
vi.mock('./gameHallAgent', () => ({
  planGameHallTurn: (...args: any[]) => fakes.plan(...args),
  executePendingGameHallAction: (...args: any[]) => fakes.execute(...args),
  stateFromGameHallToolResult: (result: any) => ({ gameId: result?.data?.gameId, raw: result }),
}));
vi.mock('./gameHallAccount', () => ({ persistCharacterAccountFromToolResultIfPresent: vi.fn(async () => undefined) }));
vi.mock('./characterExternalAccountStore', () => ({ listCharacterExternalAccounts: vi.fn(async () => []) }));
vi.mock('./gameHallHandoff', () => ({ createGameHallMainChatHandoff: (...args: any[]) => fakes.handoff(...args) }));
vi.mock('./chatGenEvents', () => ({ announceChatGen: vi.fn(), CHAT_GEN_EVENTS: { replyArrived: 'reply-arrived' } }));

import {
  pauseGameHallAutoplay,
  requestStopGameHallAutoplay,
  resumeGameHallAutoplay,
  runGameHallAutoplay,
  startGameHallAutoplay,
} from './gameHallAutoplayRunner';

const baseSession = () => ({ id: 'session-1', charId: 'char-1', mode: 'auto-turn', status: 'active', contextMessageLimit: null, schemaValidationMode: 'off', planRepairAttempts: 0, autoArchiveAccounts: true, createdAt: 1, updatedAt: 1 });
const pending = (id: string) => ({ id, sessionId: 'session-1', charId: 'char-1', toolIndex: 0, toolName: 'play', args: { move: id }, reason: 'continue', status: 'proposed', createdAt: Date.now(), updatedAt: Date.now() });
const deps = () => ({ sessionId: 'session-1', connection: { url: 'https://mcp.example', tools: [{ name: 'play' }] }, resolveApi: () => ({ apiConfig: { baseUrl: 'https://api.example/v1', apiKey: 'k', model: 'm' }, apiIdentity: { source: 'global' } }), char: { id: 'char-1', name: 'Sully' }, userProfile: { name: 'User' }, groups: [] });

beforeEach(() => {
  fakes.session = null; fakes.messages = []; fakes.actions = []; fakes.ids = 0;
  fakes.plan.mockReset(); fakes.execute.mockReset(); fakes.handoff.mockReset();
  fakes.handoff.mockResolvedValue({ messageId: 42, deletedMessageIds: [], lastHandoffMessageAt: 1 });
});

async function start(options: { maxTurns?: number | null; returnToMainChat?: boolean } = {}) {
  fakes.session = await startGameHallAutoplay({ session: baseSession() as any, requestedFrom: 'game-hall', instruction: 'keep playing', returnToMainChat: options.returnToMainChat ?? false, maxTurns: options.maxTurns ?? null, stepDelayMs: 0 });
}

describe('GameHall autonomous runner', () => {
  it('continues plan and execute until action=null', async () => {
    await start();
    fakes.plan.mockResolvedValueOnce({ reply: 'one', pending: pending('a1') }).mockResolvedValueOnce({ reply: 'two', pending: pending('a2') }).mockResolvedValueOnce({ reply: 'done' });
    fakes.execute.mockResolvedValue({ request: { name: 'play' }, result: { success: true, data: { gameId: 'g' } } });
    await runGameHallAutoplay(deps() as any);
    expect(fakes.plan).toHaveBeenCalledTimes(3); expect(fakes.execute).toHaveBeenCalledTimes(2);
    expect(fakes.session.autoplay).toMatchObject({ turnCount: 2, status: 'completed', stopReason: 'character-finished' });
  });

  it('has no hidden cap when maxTurns=null', async () => {
    await start({ maxTurns: null });
    for (let i = 0; i < 5; i += 1) fakes.plan.mockResolvedValueOnce({ reply: `step ${i}`, pending: pending(`a${i}`) });
    fakes.plan.mockResolvedValueOnce({ reply: 'done' });
    fakes.execute.mockResolvedValue({ request: {}, result: { success: true, data: {} } });
    await runGameHallAutoplay(deps() as any);
    expect(fakes.execute).toHaveBeenCalledTimes(5); expect(fakes.session.autoplay.turnCount).toBe(5);
  });

  it('stops after the visible maxTurns count completes', async () => {
    await start({ maxTurns: 3 });
    fakes.plan.mockImplementation(async () => ({ reply: 'continue', pending: pending(`a${fakes.plan.mock.calls.length}`) }));
    fakes.execute.mockResolvedValue({ request: {}, result: { success: true, data: {} } });
    await runGameHallAutoplay(deps() as any);
    expect(fakes.execute).toHaveBeenCalledTimes(3);
    expect(fakes.session.autoplay).toMatchObject({ turnCount: 3, stopReason: 'visible-turn-limit' });
  });

  it('pauses without planning and resumes from persisted progress', async () => {
    await start(); fakes.session = await pauseGameHallAutoplay(fakes.session);
    await runGameHallAutoplay(deps() as any); expect(fakes.plan).not.toHaveBeenCalled();
    fakes.session = await resumeGameHallAutoplay(fakes.session); fakes.plan.mockResolvedValue({ reply: 'done' });
    await runGameHallAutoplay(deps() as any); expect(fakes.plan).toHaveBeenCalledTimes(1);
  });

  it('resumes a restored session without losing progress', async () => {
    await start();
    fakes.session.autoplay = {
      ...fakes.session.autoplay,
      status: 'paused',
      stopReason: 'restored-from-backup',
      restoredFromBackupAt: 1000,
      turnCount: 3,
      latestState: { gameId: 'g1', raw: { score: 9 } },
    };
    fakes.session = await resumeGameHallAutoplay(fakes.session);
    expect(fakes.session.autoplay).toMatchObject({
      status: 'queued',
      turnCount: 3,
      latestState: { gameId: 'g1', raw: { score: 9 } },
    });
    expect(fakes.session.autoplay.stopReason).toBeUndefined();
    expect(fakes.session.autoplay.restoredFromBackupAt).toBeUndefined();
  });

  it('turns stopping into cancelled without a new plan', async () => {
    await start(); fakes.session = await requestStopGameHallAutoplay(fakes.session);
    await runGameHallAutoplay(deps() as any);
    expect(fakes.plan).not.toHaveBeenCalled(); expect(fakes.session.autoplay).toMatchObject({ status: 'cancelled', stopReason: 'user-stopped' });
  });

  it('persists MCP success=false and stops failed', async () => {
    await start(); fakes.plan.mockResolvedValue({ reply: 'try', pending: pending('bad') });
    fakes.execute.mockResolvedValue({ request: { name: 'play' }, result: { success: false, error: 'remote rejected' } });
    await runGameHallAutoplay(deps() as any);
    expect(fakes.session.autoplay).toMatchObject({ status: 'failed', stopReason: 'mcp-error' });
    expect(fakes.messages.some(message => message.toolResult?.success === false)).toBe(true);
  });

  it('feeds a correctable failure back once, executes the replacement, and continues', async () => {
    await start();
    fakes.plan
      .mockResolvedValueOnce({ reply: 'try', pending: pending('bad') })
      .mockResolvedValueOnce({ reply: 'corrected', pending: pending('fixed') })
      .mockResolvedValueOnce({ reply: 'done' });
    fakes.execute
      .mockResolvedValueOnce({
        request: { name: 'play', modelArgs: { move: 'bad' } },
        result: { success: false, error: 'unknown arcade action "play"' },
      })
      .mockResolvedValueOnce({
        request: { name: 'play', modelArgs: { move: 'fixed' } },
        result: { success: true, data: { gameId: 'g' } },
      });

    await runGameHallAutoplay(deps() as any);

    expect(fakes.plan).toHaveBeenCalledTimes(3);
    expect(fakes.execute).toHaveBeenCalledTimes(2);
    expect(fakes.plan.mock.calls[1][0]).toMatchObject({
      repairAttempts: 0,
      toolCorrection: {
        failedAction: { id: 'bad', status: 'failed' },
        failedResult: { success: false, error: 'unknown arcade action "play"' },
      },
    });
    expect(fakes.actions.find(action => action.id === 'bad')).toMatchObject({ status: 'superseded' });
    expect(fakes.actions.find(action => action.id === 'fixed')).toMatchObject({ status: 'executed' });
    expect(fakes.messages.some(message => message.toolResult?.success === false)).toBe(true);
    expect(fakes.session.autoplay).toMatchObject({ turnCount: 1, status: 'completed' });
  });

  it('stops after the single corrected action also fails', async () => {
    await start();
    fakes.plan
      .mockResolvedValueOnce({ reply: 'try', pending: pending('bad') })
      .mockResolvedValueOnce({ reply: 'corrected', pending: pending('still-bad') });
    fakes.execute
      .mockResolvedValueOnce({ request: {}, result: { success: false, error: 'unknown arcade action "play"' } })
      .mockResolvedValueOnce({ request: {}, result: { success: false, error: 'invalid argument: gameId' } });

    await runGameHallAutoplay(deps() as any);

    expect(fakes.plan).toHaveBeenCalledTimes(2);
    expect(fakes.execute).toHaveBeenCalledTimes(2);
    expect(fakes.session.autoplay).toMatchObject({ turnCount: 0, status: 'failed', stopReason: 'mcp-error' });
    expect(fakes.actions.find(action => action.id === 'still-bad')).toMatchObject({ status: 'failed' });
  });

  it('does not spend a correction call on auth, network, throttling, or server failures', async () => {
    for (const error of ['HTTP 401 Unauthorized', 'network timeout', 'HTTP 429 rate limited', 'HTTP 503 unavailable']) {
      await start();
      fakes.plan.mockResolvedValue({ reply: 'try', pending: pending(`bad-${error}`) });
      fakes.execute.mockResolvedValue({ request: {}, result: { success: false, error } });

      await runGameHallAutoplay(deps() as any);

      expect(fakes.plan).toHaveBeenCalledTimes(1);
      expect(fakes.execute).toHaveBeenCalledTimes(1);
      fakes.plan.mockClear();
      fakes.execute.mockClear();
    }
  });

  it('marks transport exceptions failed and preserves original messages', async () => {
    await start(); fakes.messages.push({ id: 'original', sessionId: 'session-1', charId: 'char-1', role: 'user', content: 'keep', createdAt: 1 });
    fakes.plan.mockResolvedValue({ reply: 'try', pending: pending('boom') }); fakes.execute.mockRejectedValue(new Error('network down'));
    await runGameHallAutoplay(deps() as any);
    expect(fakes.session.autoplay).toMatchObject({ status: 'failed', lastError: 'network down' });
    expect(fakes.messages.some(message => message.id === 'original')).toBe(true); expect(fakes.handoff).not.toHaveBeenCalled();
  });

  it('uses the existing handoff once after requested successful completion', async () => {
    await start({ returnToMainChat: true }); fakes.plan.mockResolvedValue({ reply: 'done' });
    await runGameHallAutoplay(deps() as any);
    expect(fakes.handoff).toHaveBeenCalledTimes(1); expect(fakes.session.autoplay.handoffMessageId).toBe(42);
  });

  it('records handoffError while preserving original messages', async () => {
    await start({ returnToMainChat: true }); fakes.messages.push({ id: 'original', sessionId: 'session-1', charId: 'char-1', role: 'user', content: 'keep', createdAt: 1 });
    fakes.plan.mockResolvedValue({ reply: 'done' }); fakes.handoff.mockRejectedValue(new Error('summary failed'));
    await runGameHallAutoplay(deps() as any);
    expect(fakes.session.autoplay.handoffError).toBe('summary failed'); expect(fakes.messages.some(message => message.id === 'original')).toBe(true);
  });

  it('deduplicates concurrent wakeups for one session', async () => {
    await start(); let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    fakes.plan.mockImplementationOnce(async () => { await gate; return { reply: 'done' }; });
    const first = runGameHallAutoplay(deps() as any); const second = runGameHallAutoplay(deps() as any);
    expect(first).toBe(second); release(); await Promise.all([first, second]); expect(fakes.plan).toHaveBeenCalledTimes(1);
  });
});
