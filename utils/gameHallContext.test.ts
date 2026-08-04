import { describe, expect, it } from 'vitest';
import { normalizeGameHallContextLimit, selectGameHallContext } from './gameHallContext';
import type { GameHallMessage } from './gameHallTypes';

const messages: GameHallMessage[] = Array.from({ length: 6 }, (_, index) => ({
  id: `m${index + 1}`,
  sessionId: 's1',
  charId: 'c1',
  role: index % 2 ? 'assistant' : 'user',
  content: `message-${index + 1}`,
  createdAt: index + 1,
}));

describe('game hall user-controlled context', () => {
  it('treats zero/negative/empty as all with no hidden cap', () => {
    expect(normalizeGameHallContextLimit(0)).toBeNull();
    expect(normalizeGameHallContextLimit(-10)).toBeNull();
    expect(normalizeGameHallContextLimit(undefined)).toBeNull();
    const selected = selectGameHallContext(messages, null);
    expect(selected.messages.map(message => message.id)).toEqual(messages.map(message => message.id));
    expect(selected.excludedCount).toBe(0);
  });

  it('selects exactly the latest N without mutating or deleting the source', () => {
    const selected = selectGameHallContext(messages, 3);
    expect(selected.messages.map(message => message.id)).toEqual(['m4', 'm5', 'm6']);
    expect(selected.includedCount).toBe(3);
    expect(selected.excludedCount).toBe(3);
    expect(messages).toHaveLength(6);
  });

  it('accepts a limit larger than history instead of silently clamping it', () => {
    const selected = selectGameHallContext(messages, 999999);
    expect(selected.limit).toBe(999999);
    expect(selected.includedCount).toBe(6);
  });
});
