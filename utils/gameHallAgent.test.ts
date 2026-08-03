import { describe, expect, it } from 'vitest';
import {
  canCallWithoutGuessing,
  hashGameHallState,
  requiredSchemaKeys,
  summarizeGameHallToolResult,
} from './gameHallAgent';

describe('GameHall action safety', () => {
  const tool = {
    name: 'play',
    inputSchema: {
      type: 'object',
      required: ['gameId', 'move'],
      properties: {
        gameId: { type: 'string' },
        move: { type: 'string' },
      },
    },
  };

  it('requires every server-declared required argument', () => {
    expect(requiredSchemaKeys(tool)).toEqual(['gameId', 'move']);
    expect(canCallWithoutGuessing(tool, { gameId: 'g' })).toBe(false);
    expect(
      canCallWithoutGuessing(tool, { gameId: 'g', move: 'left' }),
    ).toBe(true);
  });

  it('hashes normalized data deterministically regardless of object key order', () => {
    expect(hashGameHallState({ b: 2, a: 1 })).toBe(
      hashGameHallState({ a: 1, b: 2 }),
    );
  });

  it('keeps Cedar binding codes and credentials complete', () => {
    const summary = summarizeGameHallToolResult({
      success: true,
      data: {
        accountId: 'ai_123',
        bindingCode: 'CEDAR-ABCD-1234',
        token: 'must-not-leak',
        nested: {
          password: 'must-not-leak-either',
        },
      },
    });
    expect(summary).toContain('CEDAR-ABCD-1234');
    expect(summary).toContain('ai_123');
    expect(summary).toContain('must-not-leak');
    expect(summary).toContain('must-not-leak-either');
    expect(summary).not.toContain('[已隐藏]');
  });
  it('keeps image base64 complete in the tool result', () => {
    const summary = summarizeGameHallToolResult({
      success: true,
      structuredContent: {
        preview: 'data:image/png;base64,AAAA',
      },
    });
    expect(summary).toContain('data:image/png;base64,AAAA');
    expect(summary).not.toContain('[图片数据已省略]');
  });
});
