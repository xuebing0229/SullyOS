import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
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


describe('见面 Voice ID 路由合约', () => {
  const session = readFileSync('components/date/DateSession.tsx', 'utf8');
  const synthesis = readFileSync('utils/dateDialogueSynthesis.ts', 'utf8');

  it('普通模式的一口气 Dialogue 每条都以归属解析后的声线 ID 生成', () => {
    expect(session).toContain('const speaker = resolveDateVoiceSpeaker(item.speaker, coauthorUserEnabled);');
    expect(session).toContain('voiceId: dialogueVoiceId(speaker)');
    expect(session).toContain("if (!voiceEnabled || voiceLang || resolveTtsProvider(apiConfig) !== 'elevenlabs') return null;");
    expect(session).toContain("const speaker = resolveDateVoiceSpeaker(currentLineSpeakerRef.current, coauthorUserEnabled);");
    expect(session).toContain("const favoriteSpeaker = resolveDateVoiceSpeaker(target.speaker, coauthorUserEnabled);");
  });

  it('校验 ElevenLabs 回传 voice_id；声线或时间戳不匹配则单句重试', () => {
    expect(synthesis).toContain('segment.voice_id !== turns[index!].voiceId');
    expect(synthesis).toContain('return alignDateDialogueSegments(turns, ranges);');
  });

  it('单句 TTS 缓存必须绑定实际声线配置与模型设置', () => {
    expect(session).toContain('voice: profile,');
    expect(session).toContain('elevenLabsModel: apiConfig.elevenLabsModel,');
    expect(session).toContain('elevenLabsSimilarityBoost: apiConfig.elevenLabsSimilarityBoost,');
  });
});


describe('见面逐轮重新配音（正文不变）', () => {
  const session = readFileSync('components/date/DateSession.tsx', 'utf8');
  const router = readFileSync('utils/ttsRouter.ts', 'utf8');
  const eleven = readFileSync('utils/elevenLabsTts.ts', 'utf8');
  const fish = readFileSync('utils/fishAudioTts.ts', 'utf8');
  const minimax = readFileSync('utils/minimaxTts.ts', 'utf8');

  it('GAL 与历史每轮分别有仅重配语音入口，并保留已有正文重生成入口', () => {
    expect(session).toContain('仅重配本轮语音');
    expect(session).toContain('重配这轮语音');
    expect(session).toContain('handleRerollClick()');
    expect(session).toContain('regenerateNovelVoiceTurn(msg, shown)');
    expect(session).toContain("regenerateVoiceTurn(dialogueBatch, 'gal')");
    expect(session).toContain('文字和演出标签都不变');
  });

  it('强制新合成，整轮优先，逐句兜底，不改变历史消息', () => {
    expect(session).toContain('await synthesizeDateDialogue(turns, apiConfig)');
    expect(session).toContain('translateAndSpeak(speechText, item.voiceEmotion, undefined, speaker, true)');
    expect(session).toContain('dialogueForcedSinglesRef.current.add(batchKey)');
    expect(session).toContain('dialogueVoiceRevisionRef.current[batchKey]');
    expect(session).toContain('voiceRegenerationLockRef.current');
    expect(session).toContain('Object.assign(voiceCacheRef.current, freshLines)');
    expect(session).not.toContain("await onReroll();\n            const { rest:");
  });

  it('所有 TTS 服务商都可以明确绕过磁盘缓存', () => {
    expect(router).toContain('forceRefresh?: boolean');
    for (const provider of [eleven, fish, minimax]) {
      expect(provider).toContain('options?.forceRefresh ? null : await getCachedTts(cacheKey)');
    }
  });

  it('整轮重配之后不会复用相同文本的旧 PCM 解码', () => {
    expect(session).toContain('cached?.blob === batch.blob');
    expect(session).toContain('decodedDialogueRef.current = { key: batch.key, blob: batch.blob, buffer };');
  });
});
