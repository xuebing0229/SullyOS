import type { GameHallMessage } from './gameHallTypes';

export interface GameHallContextSelection {
  /** 用户明确选择后，真正交给模型的消息。 */
  messages: GameHallMessage[];
  totalCount: number;
  includedCount: number;
  excludedCount: number;
  /** null = 全部；正整数 = 最近 N 条。 */
  limit: number | null;
}

/** 0、负数、空值都表示“全部”，不设置任何隐藏上限。 */
export const normalizeGameHallContextLimit = (
  value: number | null | undefined,
): number | null => {
  if (value == null || !Number.isFinite(value) || value <= 0) return null;
  return Math.max(1, Math.floor(value));
};

/**
 * 唯一的游戏厅上下文选取函数。
 * 只决定模型本轮看哪些消息；未选中的消息仍完整保存在 IndexedDB，绝不删除。
 */
export const selectGameHallContext = (
  messages: GameHallMessage[] | undefined,
  requestedLimit: number | null | undefined,
): GameHallContextSelection => {
  const source = [...(messages || [])].sort((a, b) => a.createdAt - b.createdAt);
  const limit = normalizeGameHallContextLimit(requestedLimit);
  const selected = limit == null ? source : source.slice(-limit);
  return {
    messages: selected,
    totalCount: source.length,
    includedCount: selected.length,
    excludedCount: source.length - selected.length,
    limit,
  };
};

export const gameHallContextLabel = (
  selection: GameHallContextSelection,
): string => selection.limit == null
  ? `上下文：全部 ${selection.includedCount}/${selection.totalCount}`
  : `上下文：最近 ${selection.limit} 条 · ${selection.includedCount}/${selection.totalCount}`;
