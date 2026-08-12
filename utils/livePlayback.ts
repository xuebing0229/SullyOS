import type { LiveEvent } from './liveTypes';

export const indexLiveEvents = (events: LiveEvent[]): Map<number, LiveEvent[]> => {
  const map = new Map<number, LiveEvent[]>();
  for (const event of events) {
    const second = Math.max(0, Math.floor(event.time));
    const bucket = map.get(second) || [];
    bucket.push(event);
    map.set(second, bucket);
  }
  return map;
};

export const branchLiveTimeline = (
  events: LiveEvent[],
  at: number,
  trigger: LiveEvent,
  future: LiveEvent[],
): LiveEvent[] => [
  ...events.filter(event => event.time <= at),
  trigger,
  ...future.filter(event => event.time > at),
].sort((a, b) => a.time - b.time || a.createdAt - b.createdAt);

export const visibleLiveEvents = (events: LiveEvent[], currentTime: number) => {
  const happened = events.filter(event => event.time <= currentTime);
  return {
    visuals: happened.filter(event => event.type === 'visual' || event.type === 'system' || event.type === 'mic').slice(-20),
    danmu: happened.filter(event => event.type === 'danmu' || event.type === 'gift').slice(-50),
  };
};
