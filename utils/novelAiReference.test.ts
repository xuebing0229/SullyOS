import { describe, expect, it } from 'vitest';
import type { NovelAiPreciseReferenceConfig } from '../types';
import {
    applyManagedNovelAiReferenceArguments,
    clampReferenceUnit,
    createNovelAiReferenceSlotId,
    chooseReferenceCanvas,
    isNovelAiReferenceType,
    prepareBuiltinImageToolArguments,
    sanitizeNovelAiReferenceToolArguments,
    stripNovelAiReferenceForTextOnlyBackup,
} from './novelAiReference';

const reference: NovelAiPreciseReferenceConfig = {
    enabled: true,
    imageRef: 'blobref:test',
    imageSha256: 'b'.repeat(64),
    slotId: 'a'.repeat(64),
    type: 'character',
    strength: 0.75,
    fidelity: 0.85,
    updatedAt: 1,
};

describe('NovelAI 精密参照工具参数', () => {
    it('删除模型伪造的 reference 字段', () => {
        expect(sanitizeNovelAiReferenceToolArguments({
            prompt: 'hello',
            reference_id: 'forged',
            reference_type: 'style',
            reference_strength: 1,
            reference_fidelity: 0,
        })).toEqual({ prompt: 'hello' });
    });

    it('由客户端配置覆盖并注入受管字段', () => {
        expect(applyManagedNovelAiReferenceArguments({
            prompt: 'hello',
            reference_id: 'forged',
        }, reference)).toEqual({
            prompt: 'hello',
            reference_id: 'a'.repeat(64),
            reference_type: 'character',
            reference_strength: 0.75,
            reference_fidelity: 0.85,
        });
    });

    it('关闭时只保留普通参数', () => {
        expect(applyManagedNovelAiReferenceArguments(
            { prompt: 'hello', reference_id: 'forged' },
            { ...reference, enabled: false },
        )).toEqual({ prompt: 'hello' });
    });

    it('生成随机私有槽位并约束数值与类型', () => {
        expect(createNovelAiReferenceSlotId()).toMatch(/^[a-f0-9]{64}$/);
        expect(clampReferenceUnit(1.2)).toBe(1);
        expect(clampReferenceUnit(-1)).toBe(0);
        expect(isNovelAiReferenceType('character&style')).toBe(true);
        expect(isNovelAiReferenceType('oops')).toBe(false);
    });

    it('非 NovelAI 工具参数原样透传', async () => {
        const args = { prompt: 'hello', reference_id: 'belongs-to-another-tool' };
        await expect(prepareBuiltinImageToolArguments({
            server: { id: 'other', name: 'Other', url: 'https://example.test/mcp', enabled: true } as any,
            toolName: 'other_tool',
            args,
            character: null,
        })).resolves.toBe(args);
    });

    it('纯文字备份会删除整项锁脸配置且不修改原角色', () => {
        const character = { id: 'char-a', name: 'A', novelAiReference: reference } as any;
        const clean = stripNovelAiReferenceForTextOnlyBackup(character);
        expect(clean.novelAiReference).toBeUndefined();
        expect(character.novelAiReference).toBe(reference);
    });


    it('纯文字备份删除整个锁脸配置', () => {
        const character = { id: 'c1', name: 'A', novelAiReference: reference } as any;
        const clean = stripNovelAiReferenceForTextOnlyBackup(character);
        expect(clean.novelAiReference).toBeUndefined();
        expect(character.novelAiReference).toBe(reference);
    });


    it('按原图方向选择官方三种参考画布', () => {
        expect(chooseReferenceCanvas(800, 1200)).toEqual({ width: 1024, height: 1536 });
        expect(chooseReferenceCanvas(1000, 1000)).toEqual({ width: 1472, height: 1472 });
        expect(chooseReferenceCanvas(1600, 900)).toEqual({ width: 1536, height: 1024 });
    });

});
