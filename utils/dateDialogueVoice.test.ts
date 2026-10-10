import { describe, expect, it } from 'vitest';
import { alignDateDialogueSegments, buildDateDialogueBatch, resolveDateVoiceSpeaker } from './dateDialogueVoice';

const turns = [
  { lineId: '1', speaker: 'char' as const, speech: '[softly] 你怎么还没睡？', voiceId: 'char-voice' },
  { lineId: '2', speaker: 'user' as const, speech: '[chuckles] 等你啊。', voiceId: 'user-voice' },
  { lineId: '3', speaker: 'char' as const, speech: '不是说了不用等吗？', voiceId: 'char-voice' },
];

describe('见面声线归属', () => {
  it('关闭强化模式时即使模型错标 user 也只能使用角色 Voice ID', () => {
    expect(resolveDateVoiceSpeaker('user', false)).toBe('char');
    expect(resolveDateVoiceSpeaker('char', false)).toBe('char');
    expect(resolveDateVoiceSpeaker(undefined, false)).toBe('char');
  });
  it('开启强化模式后 char 和 user 仍各自使用独立声线', () => {
    expect(resolveDateVoiceSpeaker('char', true)).toBe('char');
    expect(resolveDateVoiceSpeaker('user', true)).toBe('user');
  });
});

describe('见面模式双 OC 配音批次', () => {
  it('按剧情原顺序保留双人台词与原生 Audio Tags', () => {
    expect(buildDateDialogueBatch(turns)).toEqual({
      inputs: [
        { text: '[softly] 你怎么还没睡？', voice_id: 'char-voice' },
        { text: '[chuckles] 等你啊。', voice_id: 'user-voice' },
        { text: '不是说了不用等吗？', voice_id: 'char-voice' },
      ],
      lineIds: ['1', '2', '3'],
    });
  });
  it('按台词 ID 对齐时间区间', () => {
    expect(alignDateDialogueSegments(turns, [
      { start: 0, end: 2 }, { start: 2.1, end: 4 }, { start: 4.1, end: 7 },
    ])).toEqual([
      { lineId: '1', speaker: 'char', startTime: 0, endTime: 2 },
      { lineId: '2', speaker: 'user', startTime: 2.1, endTime: 4 },
      { lineId: '3', speaker: 'char', startTime: 4.1, endTime: 7 },
    ]);
  });
  it('缺失或非法时间戳时拒绝猜测', () => {
    expect(() => alignDateDialogueSegments(turns, [{ start: 0, end: 1 }])).toThrow();
    expect(() => alignDateDialogueSegments(turns, [
      { start: 0, end: 1 }, { start: 2, end: 1 }, { start: 3, end: 4 },
    ])).toThrow();
    // 上游在长对白后偶发重叠或塌缩的 voice_segments：不得拿来截取别人台词。
    expect(() => alignDateDialogueSegments(turns, [
      { start: 0, end: 2.5 }, { start: 1, end: 4 }, { start: 4, end: 6 },
    ])).toThrow();
    expect(() => alignDateDialogueSegments(turns, [
      { start: 0, end: 2 }, { start: 2, end: 4 }, { start: 2, end: 4.5 },
    ])).toThrow();
  });
});
