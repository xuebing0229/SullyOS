import { describe, it, expect } from 'vitest';
import { chunkNovelText, chunkNovelTextAsync, getReadingWindow, buildNovel } from './novel';
import { parseVROutput } from './prompts';

describe('chunkNovelText', () => {
    it('splits text into segments with sequential idx', () => {
        const text = Array.from({ length: 10 }, (_, i) => `这是第${i}个自然段，` + '字'.repeat(80)).join('\n\n');
        const segs = chunkNovelText(text, 200);
        expect(segs.length).toBeGreaterThan(1);
        segs.forEach((s, i) => {
            expect(s.idx).toBe(i);
            expect(s.chars).toBe(s.text.length);
        });
    });

    it('hard-splits an over-long paragraph', () => {
        const huge = '甲'.repeat(2000);
        const segs = chunkNovelText(huge, 300);
        expect(segs.length).toBeGreaterThanOrEqual(6);
    });

    it('returns empty for blank input', () => {
        expect(chunkNovelText('   \n\n  ')).toEqual([]);
    });
});

describe('chunkNovelTextAsync', () => {
    it('matches the sync chunker output', async () => {
        const text = Array.from({ length: 50 }, (_, i) => `第${i}段` + '字'.repeat(120)).join('\n\n');
        const sync = chunkNovelText(text, 300);
        const async = await chunkNovelTextAsync(text, 300);
        expect(async.map(s => s.text)).toEqual(sync.map(s => s.text));
        expect(async.map(s => s.idx)).toEqual(sync.map(s => s.idx));
    });

    it('reports progress and finishes at 1', async () => {
        const ratios: number[] = [];
        await chunkNovelTextAsync('一'.repeat(20000), 400, r => ratios.push(r));
        expect(ratios[ratios.length - 1]).toBe(1);
    });
});

describe('getReadingWindow', () => {
    it('respects budget and advances from bookmark', () => {
        const novel = buildNovel('测试', Array.from({ length: 20 }, (_, i) => '原文段'.repeat(100) + i).join('\n\n'));
        const w1 = getReadingWindow(novel, 0, 1000);
        expect(w1.from).toBe(0);
        expect(w1.to).toBeGreaterThan(0);
        const w2 = getReadingWindow(novel, w1.to, 1000);
        expect(w2.from).toBe(w1.to);
    });

    it('always yields at least one segment and flags end', () => {
        const novel = buildNovel('短', '只有一段');
        const w = getReadingWindow(novel, 0, 1);
        expect(w.segments.length).toBe(1);
        expect(w.reachedEnd).toBe(true);
    });
});

describe('parseVROutput', () => {
    it('parses annotations with seg index and ref, plus activity', () => {
        const raw = `<彼方>
<批注 段落="3">男主也太迟钝了吧</批注>
<批注 段落="5" 回应="#ab12">才不是你说的那样</批注>
<动态>在《某书》读到了初遇，吐槽了男主</动态>
</彼方>`;
        const out = parseVROutput(raw);
        expect(out.annotations).toHaveLength(2);
        expect(out.annotations[0].segIdx).toBe(3);
        expect(out.annotations[1].refLabel).toBe('ab12');
        expect(out.activity).toContain('初遇');
    });

    it('tolerates zero annotations', () => {
        const out = parseVROutput(`<彼方><动态>安静读完</动态></彼方>`);
        expect(out.annotations).toHaveLength(0);
        expect(out.activity).toBe('安静读完');
    });

    it('ignores annotations without a paragraph number', () => {
        const out = parseVROutput(`<批注>没有段落号</批注><动态>x</动态>`);
        expect(out.annotations).toHaveLength(0);
    });
});
