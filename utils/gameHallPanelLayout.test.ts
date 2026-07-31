import { describe, expect, it } from 'vitest';
import {
  getClosestGameHallSheetSnap,
  getGameHallSheetMetrics,
  getNextGameHallSheetSnap,
} from './gameHallPanelLayout';

describe('gameHallPanelLayout', () => {
  it('keeps all snap points ordered on a small phone', () => {
    const metrics = getGameHallSheetMetrics(640);
    expect(metrics.collapsed).toBeLessThan(metrics.half);
    expect(metrics.half).toBeLessThan(metrics.expanded);
    expect(metrics.expanded).toBeLessThanOrEqual(460);
  });

  it('caps the expanded sheet on a tall display', () => {
    const metrics = getGameHallSheetMetrics(1000);
    expect(metrics.expanded).toBeLessThanOrEqual(560);
  });

  it('selects the nearest snap point', () => {
    const metrics = { collapsed: 76, half: 280, expanded: 470 };
    expect(getClosestGameHallSheetSnap(88, metrics)).toBe('collapsed');
    expect(getClosestGameHallSheetSnap(300, metrics)).toBe('half');
    expect(getClosestGameHallSheetSnap(450, metrics)).toBe('expanded');
  });

  it('moves one stop in the requested direction', () => {
    expect(getNextGameHallSheetSnap('collapsed', 'up')).toBe('half');
    expect(getNextGameHallSheetSnap('half', 'up')).toBe('expanded');
    expect(getNextGameHallSheetSnap('expanded', 'up')).toBe('expanded');
    expect(getNextGameHallSheetSnap('expanded', 'down')).toBe('half');
    expect(getNextGameHallSheetSnap('collapsed', 'down')).toBe('collapsed');
  });
});
