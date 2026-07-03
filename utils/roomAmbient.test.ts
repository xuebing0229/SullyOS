import { describe, it, expect, vi } from 'vitest';
import {
    shouldRequestAmbient,
    parseAmbientEvent,
    mergeAmbientIntoFeed,
    AMBIENT_MIN_INTERVAL_MS,
    AMBIENT_FEED_CAP,
} from './roomAmbient';
import type { CharacterProfile, RoomAmbientEvent } from '../types';

vi.mock('./db', () => ({ DB: { saveMessage: vi.fn() } }));

const charWith = (over: Partial<CharacterProfile> = {}): CharacterProfile =>
    ({ id: 'c1', name: '阿澄', ...over } as CharacterProfile);

const ev = (over: Partial<RoomAmbientEvent> = {}): RoomAmbientEvent =>
    ({ id: 'e1', text: 'x', timestamp: 1, ...over });

describe('shouldRequestAmbient 双闸', () => {
    it('时间闸：距上条不足间隔 → false（概率闸不掷）', () => {
        const c = charWith({ roomAmbientFeed: [ev({ timestamp: Date.now() })] });
        expect(shouldRequestAmbient(c, () => 0)).toBe(false);
    });

    it('过了时间闸 + 概率命中 → true', () => {
        const c = charWith({ roomAmbientFeed: [ev({ timestamp: Date.now() - AMBIENT_MIN_INTERVAL_MS - 1 })] });
        expect(shouldRequestAmbient(c, () => 0)).toBe(true);
    });

    it('过了时间闸 + 概率未中 → false', () => {
        const c = charWith({ roomAmbientFeed: [] });
        expect(shouldRequestAmbient(c, () => 0.99)).toBe(false);
    });

    it('从无动态的角色只受概率闸约束', () => {
        expect(shouldRequestAmbient(charWith(), () => 0)).toBe(true);
    });
});

describe('parseAmbientEvent 宽松校验', () => {
    it('无 ambientEvent / 空 text → null', () => {
        expect(parseAmbientEvent({}, charWith())).toBeNull();
        expect(parseAmbientEvent({ ambientEvent: { text: '  ' } }, charWith())).toBeNull();
    });

    it('合法事件：截断 60 字，emoji 限长', () => {
        const out = parseAmbientEvent(
            { ambientEvent: { text: '长'.repeat(100), emoji: '📖✨🌙🏠🎈' } },
            charWith(),
        )!;
        expect(out.text.length).toBe(60);
        expect(out.emoji!.length).toBeLessThanOrEqual(4);
        expect(out.timestamp).toBeGreaterThan(0);
    });

    it('targetItemId 必须命中现有家具，否则丢弃该字段', () => {
        const c = charWith({ roomConfig: { items: [{ id: 'item_a', name: '飘窗', type: 'furniture', image: '', x: 0, y: 0, scale: 1, rotation: 0, isInteractive: true }] } as any });
        const hit = parseAmbientEvent({ ambientEvent: { text: 'x', targetItemId: 'item_a' } }, c)!;
        expect(hit.targetItemId).toBe('item_a');
        const miss = parseAmbientEvent({ ambientEvent: { text: 'x', targetItemId: 'ghost' } }, c)!;
        expect(miss.targetItemId).toBeUndefined();
    });
});

describe('mergeAmbientIntoFeed', () => {
    it('新在前，封顶', () => {
        const old = Array.from({ length: AMBIENT_FEED_CAP }, (_, i) => ev({ id: `old_${i}` }));
        const merged = mergeAmbientIntoFeed(charWith({ roomAmbientFeed: old }), ev({ id: 'new' }));
        expect(merged[0].id).toBe('new');
        expect(merged.length).toBe(AMBIENT_FEED_CAP);
        expect(merged.some(e => e.id === `old_${AMBIENT_FEED_CAP - 1}`)).toBe(false);
    });
});
