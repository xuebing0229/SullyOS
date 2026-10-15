/**
 * 见面模式双 OC 连续配音的纯数据层。
 * 不修改剧情生成规则：强化模式生成的 user 台词与 char 台词地位相同。
 * 一轮剧情共享一个音频，GAL/小说视图按 lineId 引用同一时间区间。
 */
export type DateDialogueSpeaker = 'char' | 'user';
/** NPC 会显示台词，但没有专属声线时绝不能借用主角色声线。 */
export type DateLineSpeaker = DateDialogueSpeaker | 'npc';

/**
 * 见面原版只有当前角色拥有发言权；不能因模型偶发输出 [speaker:user]
 * 就把这句发送给用户声线（姓名牌依旧显示角色会造成明显串戏）。
 * 只有用户明确启用双 OC 强化演绎后才允许 user 声线。
 */
export const resolveDateVoiceSpeaker = (
  claimedSpeaker: DateLineSpeaker | undefined,
  coauthorUserEnabled: boolean,
): DateDialogueSpeaker | null => claimedSpeaker === 'npc'
  ? null
  : (coauthorUserEnabled && claimedSpeaker === 'user' ? 'user' : 'char');

export interface DateDialogueTurn {
  lineId: string;
  speaker: DateDialogueSpeaker;
  /** 包含 ElevenLabs [...] Audio Tags 的原始台词，禁止从显示文本反推。 */
  speech: string;
  voiceId: string;
}

export interface DateDialogueSegment {
  lineId: string;
  speaker: DateDialogueSpeaker;
  startTime: number;
  endTime: number;
}

export interface DateDialogueBatch {
  inputs: Array<{ text: string; voice_id: string }>;
  lineIds: string[];
}

/** 整轮台词原顺序送入 Dialogue API；不按说话人重新排序，不擅自切批。 */
export const buildDateDialogueBatch = (turns: DateDialogueTurn[]): DateDialogueBatch => {
  const usable = turns.filter(turn => turn.speech.trim() && turn.voiceId.trim());
  return {
    inputs: usable.map(turn => ({ text: turn.speech.trim(), voice_id: turn.voiceId.trim() })),
    lineIds: usable.map(turn => turn.lineId),
  };
};

/**
 * 将 API 返回的逐输入时间区间映射回剧情行。
 * 对齐信息不完整时抛错，调用方应回退现有逐句 TTS，绝不能猜切点。
 */
export const alignDateDialogueSegments = (
  turns: DateDialogueTurn[],
  ranges: Array<{ start: number; end: number }>,
): DateDialogueSegment[] => {
  if (turns.length !== ranges.length) throw new Error('见面双人配音时间戳数量与台词不一致');
  return turns.map((turn, index) => {
    const range = ranges[index];
    if (!Number.isFinite(range.start) || !Number.isFinite(range.end) ||
        range.start < 0 || range.end <= range.start ||
        (index > 0 && (range.start < ranges[index - 1].start || range.start < ranges[index - 1].end - 0.02))) {
      throw new Error('见面双人配音时间戳无效');
    }
    return { lineId: turn.lineId, speaker: turn.speaker, startTime: range.start, endTime: range.end };
  });
};

/**
 * 用实际送进 ElevenLabs 的台词顺序定位，而不是用屏幕气泡序号。
 * 叙述与 NPC 不参与配音：把它们计进索引会使后续台词全部错位。
 * 缓存可跨实时 GAL / 历史阅读复用，缓存中的 lineId 可能不同，
 * 所以只按同一个批次的输入顺序匹配，再还原本次请求的 lineId。
 */
export const resolveDateDialogueSegmentForLine = (
  voicedTurns: DateDialogueTurn[],
  segments: DateDialogueSegment[],
  lineId: string,
): DateDialogueSegment | null => {
  if (voicedTurns.length !== segments.length) return null;
  const index = voicedTurns.findIndex(turn => turn.lineId === lineId);
  if (index < 0) return null;
  const segment = segments[index];
  const turn = voicedTurns[index];
  if (!segment || segment.speaker !== turn.speaker
      || !Number.isFinite(segment.startTime) || !Number.isFinite(segment.endTime)
      || segment.endTime <= segment.startTime) return null;
  return { ...segment, lineId: turn.lineId };
};

export type DateDialogueCharacterAlignment = {
  character_start_times_seconds?: number[];
  character_end_times_seconds?: number[];
};

/**
 * 官方 voice_segments 负责告诉我们“这段属于第几个 dialogue input”，
 * 真正的裁剪边界优先取字符级 alignment。这样即使 voice segment 的粗粒度
 * start/end 带了前后缓冲，也不会把相邻一句的尾音/开头切进来。
 *
 * character_end_index 是官方定义的 exclusive index。
 */
export const resolveDateDialogueCharacterRanges = (
  segments: Array<{
    dialogue_input_index?: number;
    character_start_index?: number;
    character_end_index?: number;
  }>,
  inputCount: number,
  alignment?: DateDialogueCharacterAlignment | null,
): Array<{ start: number; end: number }> | null => {
  const starts = alignment?.character_start_times_seconds;
  const ends = alignment?.character_end_times_seconds;
  if (!Array.isArray(starts) || !Array.isArray(ends) || !starts.length || starts.length !== ends.length) return null;
  if (!Number.isInteger(inputCount) || inputCount <= 0) return null;

  const spans = Array.from({ length: inputCount }, () => ({ from: Number.POSITIVE_INFINITY, to: -1, seen: false }));
  for (const segment of segments) {
    const inputIndex = segment.dialogue_input_index;
    if (!Number.isInteger(inputIndex) || inputIndex! < 0 || inputIndex! >= inputCount) continue;
    const from = segment.character_start_index;
    const to = segment.character_end_index;
    if (!Number.isInteger(from) || !Number.isInteger(to)
        || from! < 0 || to! > starts.length || to! <= from!) return null;
    const span = spans[inputIndex!];
    span.from = Math.min(span.from, from!);
    span.to = Math.max(span.to, to!);
    span.seen = true;
  }

  if (spans.some(span => !span.seen)) return null;
  const ranges = spans.map(span => {
    const start = starts[span.from];
    const end = ends[span.to - 1];
    if (!Number.isFinite(start) || !Number.isFinite(end) || start! < 0 || end! <= start!) return null;
    return { start: start!, end: end! };
  });
  return ranges.some(range => !range) ? null : ranges as Array<{ start: number; end: number }>;
};


export type DateForcedAlignmentCharacter = {
  text?: string;
  start?: number;
  end?: number;
};

export type DateForcedAlignmentTranscript = {
  text: string;
  spans: Array<{ from: number; to: number }>;
};

/**
 * Forced Alignment 对的是最终实际说出口的纯文本，而不是带 Audio Tags 的 Dialogue 输入。
 * 用单个空格连接每条台词，并用 Unicode code point 索引记录每句范围，避免 emoji / 扩展字符
 * 把 JS UTF-16 length 搞偏。
 */
export const buildDateForcedAlignmentTranscript = (
  spokenTexts: string[],
): DateForcedAlignmentTranscript | null => {
  if (!spokenTexts.length) return null;
  const chars: string[] = [];
  const spans: Array<{ from: number; to: number }> = [];
  for (let index = 0; index < spokenTexts.length; index += 1) {
    const text = (spokenTexts[index] || '').trim();
    if (!text) return null;
    if (index > 0) chars.push(' ');
    const from = chars.length;
    chars.push(...Array.from(text));
    spans.push({ from, to: chars.length });
  }
  return { text: chars.join(''), spans };
};

/**
 * ElevenLabs Forced Alignment 返回逐字符时间。只有返回字符序列与我们提交的 transcript
 * 一一对应时才使用；任何正规化/缺字符都直接判失败，宁可回退单句 TTS 也不猜切点。
 */
export const resolveDateForcedAlignmentRanges = (
  transcript: DateForcedAlignmentTranscript,
  characters: DateForcedAlignmentCharacter[] | undefined,
): Array<{ start: number; end: number }> | null => {
  if (!Array.isArray(characters) || !characters.length || !transcript.spans.length) return null;
  const submitted = Array.from(transcript.text);
  if (characters.length !== submitted.length) return null;

  for (let index = 0; index < characters.length; index += 1) {
    const value = characters[index]?.text;
    if (typeof value !== 'string' || Array.from(value).length !== 1) return null;
    const expected = submitted[index];
    // Forced Alignment 偶尔会把换行/制表正规化；这里 transcript 只主动插入普通空格，
    // 但用户正文自身可能含空白，所以允许“空白仍为空白”，其他字符必须完全一致。
    if (value !== expected && !(value.trim() === '' && expected.trim() === '')) return null;
  }

  const ranges = transcript.spans.map(span => {
    const slice = characters.slice(span.from, span.to);
    const spoken = slice.filter(item =>
      typeof item.text === 'string' && item.text.trim() !== ''
      && Number.isFinite(item.start) && Number.isFinite(item.end));
    const timed = spoken.length
      ? spoken
      : slice.filter(item => Number.isFinite(item.start) && Number.isFinite(item.end));
    if (!timed.length) return null;
    const start = Math.min(...timed.map(item => Number(item.start)));
    const end = Math.max(...timed.map(item => Number(item.end)));
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) return null;
    return { start, end };
  });

  if (ranges.some(range => !range)) return null;
  const typed = ranges as Array<{ start: number; end: number }>;
  for (let index = 1; index < typed.length; index += 1) {
    if (typed[index].start < typed[index - 1].end - 0.02) return null;
  }
  return typed;
};

/**
 * ElevenLabs 偶尔返回时间戳塌缩：音频正常，很多字却标成同一时刻。
 * 官方 voice_segments 的先后顺序仍可能合法，单靠相邻区间检查发现不了。
 * 只在响应提供字符对齐且出现显著塌缩时拒绝整轮切片。
 */
export const hasCollapsedDateDialogueAlignment = (
  segments: Array<{ character_start_index?: number; character_end_index?: number }>,
  alignment?: DateDialogueCharacterAlignment | null,
): boolean => {
  const times = alignment?.character_start_times_seconds;
  if (!Array.isArray(times) || !times.length) return false;
  return segments.some(segment => {
    const from = segment.character_start_index;
    const to = segment.character_end_index;
    if (!Number.isInteger(from) || !Number.isInteger(to)
        || from! < 0 || to! > times.length || to! <= from!) return false;
    const count = to! - from!;
    if (count < 8) return false;
    const span = times.slice(from!, to!);
    if (span.some(value => !Number.isFinite(value))) return true;
    const distinct = new Set(span.map(value => Math.round(value * 1000))).size;
    return distinct <= Math.max(1, Math.floor(count / 5));
  });
};
