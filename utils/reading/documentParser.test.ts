import { describe, expect, it } from 'vitest';
import {
  parseReadingDocument,
  readingContextAround,
} from './documentParser';

describe('parseReadingDocument', () => {
  it('keeps original text and splits long content', () => {
    const raw = `${'第一段。'.repeat(300)}\n\n第二段。`;
    const result = parseReadingDocument(raw, { targetChars: 300, maxChars: 500 });
    expect(result.length).toBeGreaterThan(1);
    expect(result.map((v) => v.text).join('\n\n')).toContain('第二段。');
    expect(result.every((v, i) => v.index === i)).toBe(true);
  });

  it('returns empty for empty input', () => {
    expect(parseReadingDocument(' \n ')).toEqual([]);
  });

  it('builds nearby reading context', () => {
    const segments = parseReadingDocument(
      '一。'.repeat(200) + '\n\n' + '二。'.repeat(200) + '\n\n' + '三。'.repeat(200),
      { targetChars: 100, maxChars: 300 },
    );
    const ctx = readingContextAround(segments, 1, 1);
    expect(ctx).toContain('第 1 段');
    expect(ctx).toContain('第 2 段');
  });
});
