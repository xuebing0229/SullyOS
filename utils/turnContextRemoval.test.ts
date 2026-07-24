import { describe, expect, it } from 'vitest';
import { ChatPrompts } from './chatPrompts';

describe('legacy aiTurnContext removal', () => {
  it('does not replay snapshots stored in old user-message metadata', () => {
    const marker = 'LEGACY_SNAPSHOT_MUST_NOT_ENTER_PROMPT';
    const messages = [{
      id: 1,
      charId: 'c1',
      role: 'user',
      type: 'text',
      content: '正常聊天正文',
      timestamp: Date.now(),
      metadata: { aiTurnContext: marker },
    }] as any[];

    const { apiMessages } = ChatPrompts.buildMessageHistory(
      messages,
      20,
      { id: 'c1', name: '角色', contextRangePolicyVersion: 1 } as any,
      { name: '用户' } as any,
      [],
    );

    const text = apiMessages.map(message =>
      typeof message.content === 'string' ? message.content : JSON.stringify(message.content),
    ).join('\n');
    expect(text).toContain('正常聊天正文');
    expect(text).not.toContain(marker);
    expect(text).not.toContain('Turn Context Snapshot');
  });
});
