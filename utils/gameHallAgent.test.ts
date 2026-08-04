import { describe, expect, it } from 'vitest';
import { hashGameHallState, validateGameHallToolArgs } from './gameHallAgent';
import type { McpToolDef } from './mcpClient';

const playTool: McpToolDef = {
  name: 'play',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['action'],
    properties: {
      action: { type: 'string', enum: ['join', 'move', 'leave'] },
      count: { type: 'integer' },
    },
  },
};

describe('game hall optional schema diagnostics', () => {
  it('can describe invented enum values and extra fields when warn/strict is enabled', () => {
    const errors = validateGameHallToolArgs(playTool, { action: 'arcade', surprise: true });
    expect(errors.join('\n')).toContain('join');
    expect(errors.join('\n')).toContain('surprise');
  });

  it('accepts exact schema values', () => {
    expect(validateGameHallToolArgs(playTool, { action: 'move', count: 2 })).toEqual([]);
  });

  it('hashes full state deterministically without truncation', () => {
    expect(hashGameHallState({ b: 2, a: 1 })).toBe(hashGameHallState({ a: 1, b: 2 }));
  });
});
