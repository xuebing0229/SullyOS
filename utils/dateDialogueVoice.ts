/**
 * 见面模式双 OC 连续配音的纯数据层。
 * 不修改剧情生成规则：强化模式生成的 user 台词与 char 台词地位相同。
 * 一轮剧情共享一个音频，GAL/小说视图按 lineId 引用同一时间区间。
 */
export type DateDialogueSpeaker = 'char' | 'user';

/**
 * 见面原版只有当前角色拥有发言权；不能因模型偶发输出 [speaker:user]
 * 就把这句发送给用户声线（姓名牌依旧显示角色会造成明显串戏）。
 * 只有用户明确启用双 OC 强化演绎后才允许 user 声线。
 */
export const resolveDateVoiceSpeaker = (
  claimedSpeaker: DateDialogueSpeaker | undefined,
  coauthorUserEnabled: boolean,
): DateDialogueSpeaker => coauthorUserEnabled && claimedSpeaker === 'user' ? 'user' : 'char';

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
