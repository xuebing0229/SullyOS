import { describe, expect, it } from 'vitest';
import {
    buildMeetingCgPrompt,
    getMeetingCgButtonLabel,
    makeMeetingCgBackground,
    normalizeMcpImageResult,
    prepareMeetingCgArguments,
    resolveMeetingCgEngine,
} from './meetingCg';

describe('meeting cg engine resolution', () => {
    it('uses explicit engine when enabled', () => {
        const resolved = resolveMeetingCgEngine(
            { gptEnabled: true, novelaiEnabled: true, preferred: 'novelai' },
            'gpt',
        );
        expect(resolved).toEqual({ engine: 'gpt', reason: 'explicit' });
    });

    it('falls back to preferred or available engine', () => {
        expect(resolveMeetingCgEngine(
            { gptEnabled: true, novelaiEnabled: false, preferred: 'novelai' },
        ).engine).toBe('gpt');

        expect(resolveMeetingCgEngine(
            { gptEnabled: false, novelaiEnabled: true, preferred: 'gpt' },
        ).engine).toBe('novelai');
    });

    it('throws when no engines are enabled', () => {
        expect(() => resolveMeetingCgEngine(
            { gptEnabled: false, novelaiEnabled: false },
        )).toThrow();
    });
});

describe('meeting cg prompt building', () => {
    it('builds a stable prompt and summary', () => {
        const built = buildMeetingCgPrompt(
            'gpt',
            {
                id: 'char1',
                name: '祁连云',
                appearance: 'black hair, pale skin, elegant coat',
            },
            {
                scene: 'rainy cafe by the window',
                mood: 'gentle reunion',
                timeLabel: 'night',
                weather: 'rain',
                lastMessages: ['你今天辛苦了。', '终于见到你了。'],
            },
            true,
        );

        expect(built.summary).toContain('祁连云');
        expect(built.prompt).toContain('meeting mode');
        expect(built.prompt).toContain('fresh new variation');
        expect(built.prompt).toContain('Recent chat context');
    });

    it('throws if character is missing', () => {
        expect(() => buildMeetingCgPrompt('gpt', null, {})).toThrow();
    });
});

describe('meeting cg helpers', () => {
    it('only applies NovelAI argument preparation to NovelAI', async () => {
        const prepare = async (args: Record<string, any>) => ({
            ...args,
            reference_id: 'ref-slot',
            reference_type: 'character',
            reference_strength: 0.75,
            reference_fidelity: 0.85,
        });
        await expect(prepareMeetingCgArguments('novelai', { prompt: 'cg' }, prepare)).resolves.toMatchObject({
            reference_id: 'ref-slot',
            reference_type: 'character',
            reference_strength: 0.75,
            reference_fidelity: 0.85,
        });
        await expect(prepareMeetingCgArguments('gpt', { prompt: 'cg' }, prepare)).resolves.toEqual({ prompt: 'cg' });
    });
    it('produces button label', () => {
        expect(getMeetingCgButtonLabel(false, false)).toBe('生成CG');
        expect(getMeetingCgButtonLabel(true, false)).toBe('重刷');
        expect(getMeetingCgButtonLabel(true, true)).toBe('生成中…');
    });

    it('normalizes common MCP image results', () => {
        expect(normalizeMcpImageResult({
            structuredContent: { imageUrl: 'blobref:test' },
        }).imageUrl).toBe('blobref:test');

        expect(normalizeMcpImageResult({
            content: [{ type: 'text', text: '{"url":"https://a.b/c.png"}' }],
        }).imageUrl).toBe('https://a.b/c.png');
    });

    it('builds background record', () => {
        const bg = makeMeetingCgBackground({
            imageUrl: 'blobref:abc',
            engine: 'gpt',
            promptSummary: 'summary',
            createdAt: 123,
        });
        expect(bg.imageUrl).toBe('blobref:abc');
        expect(bg.engine).toBe('gpt');
        expect(bg.createdAt).toBe(123);
    });
});
