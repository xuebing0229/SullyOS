import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { stripElevenLabsMarkupForDisplay } from './elevenLabsTts';

describe('见面 Audio Tags 显示层', () => {
  it('ElevenLabs 标签只给 TTS，不出现在用户看到的台词里', () => {
    const raw = '"[wet kiss] 嗯……[soft sticky kiss] 阿竹……[voice trembling slightly] 想你……"';
    expect(stripElevenLabsMarkupForDisplay(raw)).toBe('" 嗯…… 阿竹…… 想你……"');
  });

  it('GAL 模式动画和 SAR 显示都走清洗后的文本，原始 speechText 仍用于 TTS', () => {
    const source = readFileSync('components/date/DateSession.tsx', 'utf8');
    expect(source).toContain('const currentDisplayText = stripTtsMarkupForDisplay(currentText, apiConfig);');
    expect(source).toContain('const galDisplayText = stripTtsMarkupForDisplay(galShownText, apiConfig);');
    expect(source).toContain('setDisplayedText(currentDisplayText.substring(0, i + 1))');
    expect(source).toContain('{galShownText === currentText ? displayedText : galDisplayText}');
    expect(source).toContain('currentLineSpeechRef.current = item.speechText || extractDialogueSpeech(item.text);');
  });
});
