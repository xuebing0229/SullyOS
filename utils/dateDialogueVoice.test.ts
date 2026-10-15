import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { alignDateDialogueSegments, buildDateDialogueAlignmentTranscript, buildDateDialogueBatch, hasCollapsedDateDialogueAlignment, resolveDateDialogueCharacterRanges, resolveDateDialogueForcedAlignmentRanges, resolveDateDialogueSegmentForLine, resolveDateVoiceSpeaker, stabilizeDateDialogueForcedRanges } from './dateDialogueVoice';

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
  it('NPC 在任何模式下都没有主角或用户声线，绝不混入整轮配音', () => {
    expect(resolveDateVoiceSpeaker('npc', false)).toBeNull();
    expect(resolveDateVoiceSpeaker('npc', true)).toBeNull();
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


describe('见面逐句播放定位', () => {
  it('NPC 与旁白不占用配音索引，历史复用相同音频也能对应正确一句', () => {
    const voiced = [
      { lineId: 'historical:1', speaker: 'char' as const, voiceId: 'c', speech: '早上好' },
      { lineId: 'historical:4', speaker: 'user' as const, voiceId: 'u', speech: '你好' },
    ];
    // 原本的第 2/3 行是无声旁白、NPC；服务商只收到了这两条配音请求。
    const cachedAudioSegments = [
      { lineId: 'live:1', speaker: 'char' as const, startTime: 0, endTime: 1 },
      { lineId: 'live:4', speaker: 'user' as const, startTime: 1.1, endTime: 2.1 },
    ];
    expect(resolveDateDialogueSegmentForLine(voiced, cachedAudioSegments, 'historical:4'))
      .toEqual({ lineId: 'historical:4', speaker: 'user', startTime: 1.1, endTime: 2.1 });
    expect(resolveDateDialogueSegmentForLine(voiced, cachedAudioSegments, 'historical:2')).toBeNull();
    expect(resolveDateDialogueSegmentForLine(voiced, cachedAudioSegments, 'historical:3')).toBeNull();
    expect(resolveDateDialogueSegmentForLine(voiced, cachedAudioSegments.slice(0, 1), 'historical:4')).toBeNull();
  });

  it('声线或返回批次数量不一致时拒绝猜测切点', () => {
    const segments = [
      { lineId: 'old', speaker: 'user' as const, startTime: 0, endTime: 2 },
      { lineId: 'old2', speaker: 'user' as const, startTime: 2.1, endTime: 3 },
      { lineId: 'old3', speaker: 'char' as const, startTime: 3.1, endTime: 4 },
    ];
    expect(resolveDateDialogueSegmentForLine(turns, segments, '1')).toBeNull();
  });

  it('优先用字符级时间戳收紧 voice segment 粗边界，避免相邻台词串音', () => {
    const segments = [
      { dialogue_input_index: 0, character_start_index: 0, character_end_index: 4 },
      { dialogue_input_index: 1, character_start_index: 4, character_end_index: 8 },
      { dialogue_input_index: 2, character_start_index: 8, character_end_index: 12 },
    ];
    const alignment = {
      character_start_times_seconds: [0.10, 0.30, 0.55, 0.80, 1.15, 1.35, 1.55, 1.80, 2.15, 2.40, 2.65, 2.90],
      character_end_times_seconds: [0.25, 0.50, 0.75, 1.00, 1.30, 1.50, 1.75, 2.00, 2.35, 2.60, 2.85, 3.10],
    };
    expect(resolveDateDialogueCharacterRanges(segments, 3, alignment)).toEqual([
      { start: 0.10, end: 1.00 },
      { start: 1.15, end: 2.00 },
      { start: 2.15, end: 3.10 },
    ]);
  });

  it('同一 input 被拆成多个 voice segment 时合并字符跨度；索引坏掉则拒绝精切', () => {
    const alignment = {
      character_start_times_seconds: [0, 0.2, 0.4, 0.6, 0.8, 1.0],
      character_end_times_seconds: [0.15, 0.35, 0.55, 0.75, 0.95, 1.15],
    };
    expect(resolveDateDialogueCharacterRanges([
      { dialogue_input_index: 0, character_start_index: 0, character_end_index: 2 },
      { dialogue_input_index: 0, character_start_index: 2, character_end_index: 4 },
      { dialogue_input_index: 1, character_start_index: 4, character_end_index: 6 },
    ], 2, alignment)).toEqual([
      { start: 0, end: 0.75 },
      { start: 0.8, end: 1.15 },
    ]);
    expect(resolveDateDialogueCharacterRanges([
      { dialogue_input_index: 0, character_start_index: 0, character_end_index: 99 },
    ], 1, alignment)).toBeNull();
  });


  it('Forced Alignment 按纯朗读文本映射回每句，并按 Unicode 字符计数', () => {
    const transcript = buildDateDialogueAlignmentTranscript(['你好🙂', '等你啊。']);
    expect(transcript).toEqual({
      text: '你好🙂 等你啊。',
      spans: [{ from: 0, to: 3 }, { from: 4, to: 8 }],
    });
    const chars = Array.from(transcript!.text).map((text, index) => ({
      text,
      start: index * 0.2,
      end: index * 0.2 + 0.15,
    }));
    expect(resolveDateDialogueForcedAlignmentRanges(transcript!, chars)).toEqual([
      { start: 0, end: 0.55 },
      { start: 0.8, end: 1.55 },
    ]);
  });

  it('Forced Alignment 文本被供应商改写时拒绝猜切点', () => {
    const transcript = buildDateDialogueAlignmentTranscript(['你好', '晚安'])!;
    const chars = Array.from('你好 早安').map((text, index) => ({
      text, start: index * 0.2, end: index * 0.2 + 0.1,
    }));
    expect(resolveDateDialogueForcedAlignmentRanges(transcript, chars)).toBeNull();
  });

  it('原 Dialogue 粗时间只在 Forced Alignment 的安全句间空隙里决定边界', () => {
    expect(stabilizeDateDialogueForcedRanges(
      [{ start: 0.5, end: 1.5 }, { start: 2.2, end: 3.0 }, { start: 3.7, end: 4.5 }],
      [{ start: 0.1, end: 1.9 }, { start: 2.0, end: 3.5 }, { start: 3.3, end: 4.7 }],
    )).toEqual([
      { start: 0.1, end: 1.95 },
      { start: 1.95, end: 3.4 },
      { start: 3.4, end: 4.7 },
    ]);
  });

  it('供应商字符时间戳塌缩应回退逐句，正常原生时间戳照常使用', () => {
    const voiceSegments = [{ character_start_index: 0, character_end_index: 50 }];
    expect(hasCollapsedDateDialogueAlignment(voiceSegments,
      { character_start_times_seconds: Array(50).fill(23.5) })).toBe(true);
    expect(hasCollapsedDateDialogueAlignment(voiceSegments,
      { character_start_times_seconds: Array.from({ length: 50 }, (_, i) => i * 0.1) })).toBe(false);
    expect(hasCollapsedDateDialogueAlignment(voiceSegments, undefined)).toBe(false);
  });
});

describe('见面 Voice ID 路由合约', () => {
  const session = readFileSync('components/date/DateSession.tsx', 'utf8');
  const synthesis = readFileSync('utils/dateDialogueSynthesis.ts', 'utf8');

  it('普通模式的一口气 Dialogue 每条都以归属解析后的声线 ID 生成', () => {
    expect(session).toContain('const speaker = resolveDateVoiceSpeaker(item.speaker, coauthorUserEnabled);');
    expect(session).toContain('voiceId: dialogueVoiceId(speaker)');
    expect(session).toContain('return resolveDateDialogueSegmentForLine(turns, batch.segments, lineId);');
    expect(session).not.toContain('batch.segments[index] || null');
    expect(session).toContain('if (!speaker) return [];');
    expect(session).toContain('if (!speaker) continue;');
    expect(session).toContain("currentLineSpeakerRef.current !== 'npc'");
    expect(session).toContain("currentLineNpcNameRef.current = item.npcName;");
    expect(session).toContain("if (!voiceEnabled || voiceLang || resolveTtsProvider(apiConfig) !== 'elevenlabs') return null;");
    expect(session).toContain("const speaker = resolveDateVoiceSpeaker(currentLineSpeakerRef.current, coauthorUserEnabled);");
    expect(session).toContain("const favoriteSpeaker = resolveDateVoiceSpeaker(target.speaker, coauthorUserEnabled);");
  });

  it('整轮 Dialogue 只负责演绎，逐句切点改由 Forced Alignment 重建', () => {
    expect(synthesis).toContain('segment.voice_id !== turns[index!].voiceId');
    expect(synthesis).toContain('requestForcedAlignment(apiKey, data.audio_base64, transcript.text)');
    expect(synthesis).toContain("url: 'https://api.elevenlabs.io/v1/forced-alignment'");
    expect(synthesis).toContain("dataType: 'formData'");
    expect(synthesis).toContain("type: 'base64File'");
    expect(synthesis).toContain('resolveDateDialogueForcedAlignmentRanges(transcript, forced.data.characters)');
    expect(synthesis).toContain('stabilizeDateDialogueForcedRanges(anchors, coarseRanges)');
    expect(synthesis).not.toContain('resolveDateDialogueCharacterRanges(usableSegments, turns.length, alignment)');
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
