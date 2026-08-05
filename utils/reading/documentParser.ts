import type { ReadingSegment } from '../../types';

const uid = (index: number) =>
  `readseg_${Date.now().toString(36)}_${index}_${Math.random()
    .toString(36)
    .slice(2, 6)}`;

export interface ParseDocumentOptions {
  targetChars?: number;
  maxChars?: number;
}

/**
 * 按自然段切块；超长段按句末标点继续拆。
 * 不改写原文，不调用 OCR，不吞空格。
 */
export function parseReadingDocument(
  raw: string,
  options: ParseDocumentOptions = {},
): ReadingSegment[] {
  const target = Math.max(300, options.targetChars ?? 900);
  const max = Math.max(target, options.maxChars ?? 1600);
  const text = String(raw || '').replace(/\r\n?/g, '\n').trim();
  if (!text) return [];

  const paragraphs = text
    .split(/\n{2,}/)
    .map((v) => v.trim())
    .filter(Boolean);

  const atoms: string[] = [];
  for (const paragraph of paragraphs) {
    if (paragraph.length <= max) {
      atoms.push(paragraph);
      continue;
    }
    // 旧 iOS 不支持正则 lookbehind；手动扫描句末标点，保留等价分段语义。
    const sentences: string[] = [];
    let sentenceStart = 0;
    for (let i = 0; i < paragraph.length; i += 1) {
      if (!'。！？!?；;'.includes(paragraph[i])) continue;
      let end = i + 1;
      while (end < paragraph.length && /\s/.test(paragraph[end])) end += 1;
      const sentence = paragraph.slice(sentenceStart, end).trim();
      if (sentence) sentences.push(sentence);
      sentenceStart = end;
      i = end - 1;
    }
    const tail = paragraph.slice(sentenceStart).trim();
    if (tail) sentences.push(tail);
    let buffer = '';
    for (const sentence of sentences) {
      if (buffer && buffer.length + sentence.length > max) {
        atoms.push(buffer);
        buffer = '';
      }
      if (sentence.length > max) {
        for (let i = 0; i < sentence.length; i += max) {
          const part = sentence.slice(i, i + max);
          if (part) atoms.push(part);
        }
      } else {
        buffer += sentence;
      }
    }
    if (buffer) atoms.push(buffer);
  }

  const chunks: string[] = [];
  let current = '';
  for (const atom of atoms) {
    if (!current) {
      current = atom;
      continue;
    }
    if (current.length >= target || current.length + atom.length + 2 > max) {
      chunks.push(current);
      current = atom;
    } else {
      current += `\n\n${atom}`;
    }
  }
  if (current) chunks.push(current);

  return chunks.map((chunk, index) => ({
    id: uid(index),
    index,
    text: chunk,
    chars: [...chunk].length,
  }));
}

export function readingContextAround(
  segments: ReadingSegment[],
  index: number,
  radius = 1,
): string {
  const from = Math.max(0, index - radius);
  const to = Math.min(segments.length, index + radius + 1);
  return segments
    .slice(from, to)
    .map((seg) => `[第 ${seg.index + 1} 段]\n${seg.text}`)
    .join('\n\n');
}
