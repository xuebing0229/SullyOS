import { describe, expect, it } from 'vitest';
import { extractDateSpokenText, isDateSpokenLine } from './dateDialogueLines';

describe('见面 VN 台词识别（不让旁白进入语音）', () => {
  it('只保留台词里的 Audio Tags，忽略外部控制标签', () => {
    expect(extractDateSpokenText('[happy] "[chuckles] 等你啊。" [speaker:user]')).toBe('[chuckles] 等你啊。');
    expect(extractDateSpokenText('[normal] 「别乱晃。」 [speaker:char]')).toBe('别乱晃。');
    expect(extractDateSpokenText('[normal] “站好。” [v:angry] [speaker:char]')).toBe('站好。');
  });
  it('纯旁白、旁白引号、引号不匹配均不送 TTS', () => {
    for (const input of [
      '[normal] 他扫了一眼桌上的“新指令”，缓缓开口。',
      '[normal] “站好。”他说着转身离开。',
      '[normal] “站好。 他说着转身离开。',
      '[normal] 她说：“我知道。”',
      '[normal] （他没有回应）',
      '[normal] [speaker:user] 他点了点头。',
    ]) {
      expect(isDateSpokenLine(input)).toBe(false);
      expect(extractDateSpokenText(input)).toBe('');
    }
  });
  it('普通引号与模型意外追加句号能正确判定', () => {
    expect(isDateSpokenLine('[normal] "站好。" [speaker:char]')).toBe(true);
    expect(extractDateSpokenText('[normal] “不。”。 [speaker:user]')).toBe('不。');
  });
});
