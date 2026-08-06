import { describe, expect, it } from 'vitest';
import { parseGameHallAgentDisplay } from './gameHallAgent';

describe('Game Hall agent display parsing', () => {
  it('parses a replies array into independent display parts', () => {
    const result = parseGameHallAgentDisplay({
      rawContent: '{"replies":["第一条","第二条\\n第三条","[[SEND_EMOJI: 开心]]"],"action":null}',
      showThinkingChain: false,
    });
    expect(result.replies).toEqual([
      { type: 'text', content: '第一条' },
      { type: 'text', content: '第二条' },
      { type: 'text', content: '第三条' },
      { type: 'emoji', name: '开心' },
    ]);
  });

  it('keeps backward compatibility with the legacy reply string', () => {
    const result = parseGameHallAgentDisplay({
      rawContent: '{"reply":"旧格式仍可显示","action":null}',
      showThinkingChain: false,
    });
    expect(result.replies).toEqual([{ type: 'text', content: '旧格式仍可显示' }]);
  });

  it('removes outer and per-reply thought blocks without leaking them into text', () => {
    const result = parseGameHallAgentDisplay({
      rawContent: '<thought>outer secret</thought>{"replies":["<thought>inner secret</thought>正文"],"action":null}',
      reasoningContent: 'provider reasoning',
      showThinkingChain: true,
    });
    expect(result.replies).toEqual([{ type: 'text', content: '正文' }]);
    expect(result.thinkingChain).toBe('provider reasoning\n\nouter secret\n\ninner secret');
    expect(JSON.stringify(result.replies)).not.toContain('secret');
  });

  it('throws a controlled error instead of using raw output as visible text', () => {
    expect(() => parseGameHallAgentDisplay({
      rawContent: '<thought>private</thought>not json at all',
      showThinkingChain: false,
    })).toThrow('游戏厅回复格式解析失败');
  });

  it('keeps one action object while splitting many replies', () => {
    const result = parseGameHallAgentDisplay({
      rawContent: '{"replies":["一","二","三"],"action":{"toolIndex":0,"toolName":"play","args":{},"reason":"go"}}',
      showThinkingChain: false,
    });
    expect(result.replies).toHaveLength(3);
    expect(result.parsed.action).toEqual({ toolIndex: 0, toolName: 'play', args: {}, reason: 'go' });
  });
});