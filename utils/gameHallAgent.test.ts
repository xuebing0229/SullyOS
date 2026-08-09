import { afterEach, describe, expect, it, vi } from 'vitest';
import { hashGameHallState, planGameHallTurn, validateGameHallToolArgs } from './gameHallAgent';
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


describe('game hall batched planning requests', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it('calls the chat API once for a valid action-null batch even when repair attempts are configured', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: '{"replies":["第一条","第二条"],"action":null}' } }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await planGameHallTurn({
      apiConfig: { baseUrl: 'https://api.example.test/v1', apiKey: 'key', model: 'model', stream: false },
      char: { id: 'char-1', name: '角色' } as any,
      userProfile: { name: '用户' } as any,
      groups: [],
      mode: 'ask-before-action',
      userText: '[本轮用户消息 1] 一\n[本轮用户消息 2] 二',
      availableTools: [playTool],
      sessionId: 'session-1',
      history: [],
      repairAttempts: 3,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.replies).toEqual([
      { type: 'text', content: '第一条' },
      { type: 'text', content: '第二条' },
    ]);
    expect(result.pending).toBeUndefined();
  });

  it('injects the exact failed call and schema-derived examples into a correction request', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: '{"replies":["改一下"],"action":{"toolIndex":0,"toolName":"play","args":{"action":"join"},"reason":"修正动作"}}' } }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    await planGameHallTurn({
      apiConfig: { baseUrl: 'https://api.example.test/v1', apiKey: 'key', model: 'model', stream: false },
      char: { id: 'char-1', name: '角色' } as any,
      userProfile: { name: '用户' } as any,
      groups: [],
      mode: 'auto-turn',
      userText: '继续玩',
      availableTools: [playTool],
      sessionId: 'session-1',
      history: [],
      repairAttempts: 0,
      toolCorrection: {
        failedAction: {
          id: 'bad', sessionId: 'session-1', charId: 'char-1', toolIndex: 0,
          toolName: 'play', args: { action: 'arcade' }, reason: '攻击',
          status: 'failed', createdAt: 1, updatedAt: 2,
        },
        failedRequest: {
          toolName: 'play', toolIndex: 0,
          modelArgs: { action: 'arcade' }, finalArgs: { action: 'arcade' },
          serverUrl: 'https://mcp.example',
        },
        failedResult: { success: false, error: 'unknown arcade action "arcade"' },
      },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const requestBody = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    const prompt = JSON.stringify(requestBody.messages);
    expect(prompt).toContain('游戏厅工具纠错：仅此一次');
    expect(prompt).toContain('unknown arcade action');
    expect(prompt).toContain('arcade');
    expect(prompt).toContain('join');
  });
});
