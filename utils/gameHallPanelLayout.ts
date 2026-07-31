export type GameHallSheetSnap = 'collapsed' | 'half' | 'expanded';

export interface GameHallSheetMetrics {
  collapsed: number;
  half: number;
  expanded: number;
}

export const GAME_HALL_SHEET_SNAPS: GameHallSheetSnap[] = [
  'collapsed',
  'half',
  'expanded',
];

export const GAME_HALL_SHEET_COLLAPSED_HEIGHT = 76;

const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max);

/**
 * Builds pixel heights for the three sheet positions.
 *
 * The expanded position deliberately leaves room for the app header and a
 * usable slice of Cedar Toy. The native WebView host is observed by
 * ResizeObserver, so changing these heights automatically updates its frame.
 */
export const getGameHallSheetMetrics = (
  viewportHeight: number,
): GameHallSheetMetrics => {
  const safeViewportHeight = Math.max(320, Math.round(viewportHeight || 0));
  const collapsed = Math.min(
    GAME_HALL_SHEET_COLLAPSED_HEIGHT,
    Math.max(64, safeViewportHeight - 180),
  );

  // Keep at least roughly 180 px outside the sheet on very small displays.
  const expandedMax = Math.max(
    collapsed + 100,
    Math.min(560, safeViewportHeight - 180),
  );
  const expandedMin = Math.min(collapsed + 160, expandedMax);
  const expanded = Math.round(
    clamp(safeViewportHeight * 0.62, expandedMin, expandedMax),
  );

  const halfMax = Math.max(collapsed + 48, expanded - 64);
  const halfMin = Math.min(collapsed + 108, halfMax);
  const half = Math.round(
    clamp(safeViewportHeight * 0.38, halfMin, halfMax),
  );

  return { collapsed, half, expanded };
};

export const getGameHallSheetHeight = (
  snap: GameHallSheetSnap,
  metrics: GameHallSheetMetrics,
): number => metrics[snap];

export const getClosestGameHallSheetSnap = (
  height: number,
  metrics: GameHallSheetMetrics,
): GameHallSheetSnap => {
  return GAME_HALL_SHEET_SNAPS.reduce<GameHallSheetSnap>((closest, snap) => {
    const closestDistance = Math.abs(height - metrics[closest]);
    const nextDistance = Math.abs(height - metrics[snap]);
    return nextDistance < closestDistance ? snap : closest;
  }, 'collapsed');
};

export const getNextGameHallSheetSnap = (
  snap: GameHallSheetSnap,
  direction: 'up' | 'down',
): GameHallSheetSnap => {
  const index = GAME_HALL_SHEET_SNAPS.indexOf(snap);
  if (direction === 'up') {
    return GAME_HALL_SHEET_SNAPS[Math.min(index + 1, GAME_HALL_SHEET_SNAPS.length - 1)];
  }
  return GAME_HALL_SHEET_SNAPS[Math.max(index - 1, 0)];
};
