import 'fake-indexeddb/auto';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __aiRequestManagerTest, buildAiCacheKey, clearAiCache, invalidateAiCacheWhere, runAiRequest,
} from './aiRequestManager';

describe('aiRequestManager', () => {
  beforeAll(() => {
    if (!globalThis.crypto?.subtle) throw new Error('WebCrypto is required');
  });

  beforeEach(async () => {
    await clearAiCache();
    __aiRequestManagerTest.inFlight.clear();
  });

  it('caches a completed request and survives the in-memory layer being cleared', async () => {
    const execute = vi.fn().mockResolvedValue({ answer: 'ok' });
    const request = { model: 'm', messages: [{ role: 'user', content: 'hi' }] };
    const first = await runAiRequest({ kind: 'chat', request, execute });
    __aiRequestManagerTest.inFlight.clear();
    const second = await runAiRequest({ kind: 'chat', request, execute });
    expect(first.source).toBe('network');
    expect(second.source).toBe('indexeddb-cache');
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('deduplicates concurrent identical requests', async () => {
    let resolve!: (value: string) => void;
    const execute = vi.fn(() => new Promise<string>(r => { resolve = r; }));
    const a = runAiRequest({ kind: 'chat', request: { model: 'm' }, execute });
    const b = runAiRequest({ kind: 'chat', request: { model: 'm' }, execute });
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    resolve('done');
    expect((await a).source).toBe('network');
    expect((await b).source).toBe('memory-dedupe');
  });

  it('does not cache failures or aborts', async () => {
    const execute = vi.fn()
      .mockRejectedValueOnce(new DOMException('cancelled', 'AbortError'))
      .mockResolvedValueOnce('retry-ok');
    await expect(runAiRequest({ kind: 'chat', request: { id: 1 }, execute })).rejects.toThrow();
    expect((await runAiRequest({ kind: 'chat', request: { id: 1 }, execute })).source).toBe('network');
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('changes the key when model, messages, or temperature changes', async () => {
    const base = { model: 'a', messages: ['x'], temperature: 0.7 };
    const keys = await Promise.all([
      buildAiCacheKey('chat', base),
      buildAiCacheKey('chat', { ...base, model: 'b' }),
      buildAiCacheKey('chat', { ...base, messages: ['y'] }),
      buildAiCacheKey('chat', { ...base, temperature: 0.8 }),
    ]);
    expect(new Set(keys).size).toBe(4);
  });

  it('stably serializes repeated object references while still rejecting real cycles', async () => {
    const shared = { role: 'user', content: 'same' };
    await expect(buildAiCacheKey('chat', { first: shared, second: shared })).resolves.toMatch(/^[a-f0-9]{64}$/);
    const cyclic: any = {};
    cyclic.self = cyclic;
    await expect(buildAiCacheKey('chat', cyclic)).rejects.toThrow('circular');
  });

  it('bypass skips a stored result and forceRefresh also skips in-flight dedupe', async () => {
    const execute = vi.fn().mockResolvedValueOnce('one').mockResolvedValueOnce('two').mockResolvedValueOnce('three');
    const request = { id: 'regen' };
    await runAiRequest({ kind: 'chat', request, execute });
    expect((await runAiRequest({ kind: 'chat', request, execute, bypass: true })).value).toBe('two');
    expect((await runAiRequest({ kind: 'chat', request, execute, forceRefresh: true })).value).toBe('three');
  });

  it('invalidates the emotion result bound to an edited or regenerated character conversation', async () => {
    const execute = vi.fn().mockResolvedValueOnce({ mood: 'calm' }).mockResolvedValueOnce({ mood: 'new' });
    const request = { characterId: 'c1', userMessageId: 'u1', assistantMessageId: 'a1' };
    const options = { kind: 'emotion' as const, request, execute, metadata: { charId: 'c1' } };
    await runAiRequest(options);
    expect(await invalidateAiCacheWhere(entry => entry.kind === 'emotion' && entry.metadata?.charId === 'c1')).toBe(1);
    expect((await runAiRequest(options)).source).toBe('network');
    expect(execute).toHaveBeenCalledTimes(2);
  });
});
