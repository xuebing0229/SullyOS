import { describe, expect, it } from 'vitest';
import {
  buildAssistantDisplayResult,
  extractAssistantThinking,
  normalizeAssistantContent,
  splitAssistantDisplayParts,
} from './assistantDisplayPipeline';

describe('assistant display pipeline', () => {
  it('removes complete think/thought blocks and unterminated reasoning from visible content', () => {
    expect(normalizeAssistantContent('<think>secret</think>hello')).toBe('hello');
    expect(normalizeAssistantContent('<thought>secret</thought>hello')).toBe('hello');
    expect(normalizeAssistantContent('hello<thought>secret forever')).toBe('hello');
  });

  it('returns reasoning only when enabled and deduplicates equal blocks', () => {
    expect(extractAssistantThinking({ rawContent: '<think>same</think>x', reasoningContent: 'same', enabled: false })).toBeUndefined();
    expect(extractAssistantThinking({ rawContent: '<think>same</think>x', reasoningContent: 'same', enabled: true })).toBe('same');
  });

  it('uses ChatParser splitting for newlines, separators and emoji parts', () => {
    const parts = splitAssistantDisplayParts('第一条\n第二条\n---\n第三条\n[[SEND_EMOJI: 开心]]');
    expect(parts.filter(part => part.type === 'text').map(part => part.type === 'text' ? part.content : '')).toEqual([
      '第一条', '第二条', '第三条',
    ]);
    expect(parts.at(-1)).toEqual({ type: 'emoji', name: '开心' });
  });

  it('does not produce a bubble when hidden/control content sanitizes to empty', () => {
    expect(buildAssistantDisplayResult({ rawContent: '<thought>only hidden</thought>', showThinkingChain: false }).parts).toEqual([]);
  });
});
