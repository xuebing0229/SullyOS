import { describe, expect, it } from 'vitest';
import {
  buildGameHallToolCallExamples,
  buildGameHallToolCorrectionFeedback,
  isCorrectableGameHallToolFailure,
} from './gameHallToolCorrection';

const tools = [
  {
    name: 'cedarToy',
    inputSchema: {
      type: 'object',
      required: ['action', 'gameId'],
      properties: {
        action: { type: 'string', enum: ['join', 'attack'] },
        gameId: { type: 'string' },
        confirm: { type: 'boolean' },
      },
    },
  },
  { name: 'cedarToy', inputSchema: { type: 'object', required: [], properties: {} } },
];

describe('Game Hall tool correction feedback', () => {
  it.each([
    'unknown arcade action "play"',
    'missing required parameter gameId',
    'action must be one of join, attack',
    'INVALID_ARGUMENT: args.action 类型错误',
    '未知 action：play',
  ])('classifies a request-shape failure as correctable: %s', error => {
    expect(isCorrectableGameHallToolFailure({ success: false, error })).toBe(true);
  });

  it.each([
    'HTTP 401 Unauthorized',
    '403 forbidden: invalid token',
    'HTTP 429 rate limited',
    'HTTP 503 service unavailable',
    'network timeout',
    'remote rejected',
  ])('does not retry infrastructure or ambiguous failures: %s', error => {
    expect(isCorrectableGameHallToolFailure({ success: false, error })).toBe(false);
  });

  it('generates schema-derived examples without filtering or deduplicating tools', () => {
    expect(buildGameHallToolCallExamples(tools)).toEqual([
      { toolIndex: 0, toolName: 'cedarToy', args: { action: 'join', gameId: '<gameId>' } },
      { toolIndex: 1, toolName: 'cedarToy', args: {} },
    ]);
  });

  it('includes the failed request, full result and real dynamic examples', () => {
    const feedback = buildGameHallToolCorrectionFeedback({
      failedAction: {
        id: 'bad', sessionId: 's', charId: 'c', toolIndex: 0,
        toolName: 'cedarToy', args: { action: 'play' }, reason: 'go',
        status: 'failed', createdAt: 1, updatedAt: 2,
      },
      failedRequest: {
        toolName: 'cedarToy', toolIndex: 0,
        modelArgs: { action: 'play' }, finalArgs: { action: 'play' },
        serverUrl: 'https://mcp.example',
      },
      failedResult: { success: false, error: 'unknown arcade action "play"' },
      availableTools: tools,
    });
    expect(feedback).toContain('unknown arcade action');
    expect(feedback).toContain('"action": "play"');
    expect(feedback).toContain('"action": "join"');
    expect(feedback).toContain('"toolIndex": 1');
    expect(feedback).toContain('仅此一次');
  });
});
