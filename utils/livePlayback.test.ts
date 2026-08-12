import { describe, expect, it } from 'vitest';
import { branchLiveTimeline, indexLiveEvents, visibleLiveEvents } from './livePlayback';
import type { LiveEvent } from './liveTypes';

const event = (id: string, time: number, type: LiveEvent['type'], content = id): LiveEvent => ({
  id, roomId: 'room', time, type, content, origin: 'ai', createdAt: time,
});

describe('live playback', () => {
  it('indexes events by second', () => {
    const map = indexLiveEvents([event('a', 1, 'visual'), event('b', 1.8, 'danmu'), event('c', 2, 'danmu')]);
    expect(map.get(1)?.map(item => item.id)).toEqual(['a', 'b']);
    expect(map.get(2)?.map(item => item.id)).toEqual(['c']);
  });

  it('branches at the interaction and removes the old future', () => {
    const old = [event('past', 3, 'visual'), event('old-future', 8, 'danmu')];
    const trigger = { ...event('user', 5, 'danmu'), origin: 'user' as const };
    const next = branchLiveTimeline(old, 5, trigger, [event('new-future', 6, 'visual')]);
    expect(next.map(item => item.id)).toEqual(['past', 'user', 'new-future']);
  });

  it('keeps the UI windows bounded without deleting stored history', () => {
    const events = [
      ...Array.from({ length: 25 }, (_, i) => event(`v${i}`, i, 'visual')),
      ...Array.from({ length: 60 }, (_, i) => event(`d${i}`, i, 'danmu')),
    ];
    const visible = visibleLiveEvents(events, 100);
    expect(visible.visuals).toHaveLength(20);
    expect(visible.danmu).toHaveLength(50);
    expect(events).toHaveLength(85);
  });
});
