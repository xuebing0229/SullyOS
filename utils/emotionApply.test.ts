/**
 * 情绪评估输出解析容错 — parseEmotionEvalOutput / applyEmotionEvalRaw / extractAssistantText.
 *
 * 背景: 情绪 buff 依赖副 API 返回一段 JSON, 模型 (尤其 Claude 系) 偶发输出:
 * 围栏包裹 / 前后夹闲聊 / 字符串里裸引号裸换行 / 尾逗号 / max_tokens 截断半截 JSON。
 * 旧实现任一环节失败就整体返回 null → buff/意识流静默蒸发 (「情绪 buff 不输出内容」)。
 * 这里锁住修复链 + 字段级抢救的行为。
 */
import { readFileSync } from 'node:fs';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const useChatAISource = readFileSync(
    new URL('../hooks/useChatAI.ts', import.meta.url),
    'utf8',
);

const saveCharacter = vi.fn(async (_char: any) => {});
const getAllCharacters = vi.fn(async () => [] as any[]);
vi.mock('./db', () => ({ DB: {
    saveCharacter: (c: any) => saveCharacter(c),
    getAllCharacters: () => getAllCharacters(),
} }));

import {
    parseEmotionEvalOutput,
    applyEmotionEvalRaw,
    extractAssistantText,
    prioritizeNewBuffs,
    reconcileEmotionBuffs,
    EMOTION_BUFF_MAX_COUNT,
} from './emotionApply';

const makeChar = (extra: any = {}): any => ({
    id: 'char-1',
    name: '测试角色',
    activeBuffs: [{ id: 'buff_old', name: 'old_feeling', label: '旧情绪', intensity: 2 }],
    buffInjection: '### 旧注入',
    ...extra,
});

const VALID = {
    changed: true,
    buffs: [
        { id: 'buff_a', name: 'anxiety', label: '焦虑', intensity: 4, emoji: '⚠️', color: '#ef4444', description: 'desc' },
    ],
    injection: '### [当前情绪底色]\n焦虑 强度: ●●●●',
    innerState: '她还没回消息……',
};

beforeEach(() => {
    saveCharacter.mockClear();
    getAllCharacters.mockReset();
    getAllCharacters.mockResolvedValue([]);
});

describe('情绪评估提示词 — 新情绪不被旧快照锚死', () => {
    it('要求先独立判断当前情绪，再与旧 buff 对照，并允许不同情绪轴自然新增', () => {
        expect(useChatAISource).toContain('先判断此刻，再对照旧状态');
        expect(useChatAISource).toContain('它不需要是“重大事件”或“高冲击事件”');
        expect(useChatAISource).toContain('不要因为当前已有 3～4 个 buff 就默认不再新增');
        expect(useChatAISource).toContain('旧情绪仍然存在，而另一种不同核心的情绪同时新出现');
        expect(useChatAISource).toContain('removedBuffIds');
        expect(useChatAISource).toContain('禁止用遗漏 buffs 的方式表达删除');
        expect(useChatAISource).not.toContain('只有对话中出现了明确的、足够冲击力的情绪触发事件，才值得新增一个buff');
    });
});

describe('情绪评估提示词 — buff 标题随语义演化', () => {
    it('明确要求核心情绪质变时同步改 name / label / description，而不是只改内容', () => {
        expect(useChatAISource).toContain('标题不是固定标识符');
        expect(useChatAISource).toContain('这个 label 现在还能准确概括 description 吗？不能就改标题。');
        expect(useChatAISource).toContain('核心情绪变了就必须改');
    });
});

describe('parseEmotionEvalOutput — 正常形态', () => {
    it('裸 JSON', () => {
        const r = parseEmotionEvalOutput(JSON.stringify(VALID));
        expect(r?.changed).toBe(true);
        expect(r?.buffs?.[0]?.label).toBe('焦虑');
        expect(r?.innerState).toBe('她还没回消息……');
        expect(r?.salvaged).toBeUndefined();
    });

    it('```json 围栏包裹', () => {
        const r = parseEmotionEvalOutput('```json\n' + JSON.stringify(VALID) + '\n```');
        expect(r?.injection).toContain('当前情绪底色');
    });

    it('裸 ``` 围栏 (没写 json 标签)', () => {
        const r = parseEmotionEvalOutput('```\n' + JSON.stringify(VALID) + '\n```');
        expect(r?.buffs?.length).toBe(1);
    });

    it('前后夹闲聊文字 (后缀含 } 也不误吞)', () => {
        const raw = `好的，我来分析角色的情绪状态：\n${JSON.stringify(VALID)}\n以上就是分析结果 {希望有帮助}`;
        const r = parseEmotionEvalOutput(raw);
        expect(r?.changed).toBe(true);
        expect(r?.innerState).toBe('她还没回消息……');
    });

    it('解析显式 removedBuffIds', () => {
        const r = parseEmotionEvalOutput(JSON.stringify({
            changed: true,
            buffs: [],
            removedBuffIds: ['buff_old_a', 'buff_old_b'],
            injection: 'x',
            innerState: 'y',
        }));
        expect(r?.removedBuffIds).toEqual(['buff_old_a', 'buff_old_b']);
    });

    it('changed 为字符串 "true" 也认', () => {
        const r = parseEmotionEvalOutput(JSON.stringify({ ...VALID, changed: 'true' }));
        expect(r?.changed).toBe(true);
    });

    it('模型漏写 changed 但生成了 buffs/injection 时仍判定需要更新', () => {
        const { changed: _changed, ...withoutChanged } = VALID;
        const r = parseEmotionEvalOutput(JSON.stringify(withoutChanged));
        expect(r?.changed).toBe(true);
        expect(r?.buffs?.[0]?.label).toBe('焦虑');
        expect(r?.injection).toContain('当前情绪底色');
    });

    it('显式 changed=false 时即使附带旧状态快照也不更新', () => {
        const r = parseEmotionEvalOutput(JSON.stringify({ ...VALID, changed: false }));
        expect(r?.changed).toBe(false);
    });
});

describe('parseEmotionEvalOutput — 格式劣化修复', () => {
    it('字符串值里的裸英文双引号 (prompt 示例学坏的经典 case)', () => {
        const raw = `{
  "changed": true,
  "buffs": [{"id": "b1", "name": "waiting", "label": "患得患失", "intensity": 3}],
  "injection": "现在这个沉默不是"没事了"，是"还在疼"。",
  "innerState": "但我想要的是一个字，一个"嗯"都好。"
}`;
        const r = parseEmotionEvalOutput(raw);
        expect(r?.changed).toBe(true);
        expect(r?.innerState).toContain('嗯');
        expect(r?.injection).toContain('没事了');
    });

    it('字符串值里的真实换行 / 制表符', () => {
        const raw = `{"changed": true, "buffs": [], "injection": "第一行\n第二行\t缩进", "innerState": "内心\n独白"}`;
        const r = parseEmotionEvalOutput(raw);
        expect(r?.injection).toBe('第一行\n第二行\t缩进');
        expect(r?.innerState).toBe('内心\n独白');
    });

    it('尾逗号', () => {
        const raw = `{"changed": true, "buffs": [{"name": "a", "label": "甲", "intensity": 2},], "injection": "x", "innerState": "y",}`;
        const r = parseEmotionEvalOutput(raw);
        expect(r?.buffs?.length).toBe(1);
    });

    it('max_tokens 截断: innerState 字符串写到一半戛然而止', () => {
        const full = JSON.stringify({ changed: true, buffs: VALID.buffs, injection: VALID.injection, innerState: '她到底是睡着了还是在疼' });
        const truncated = full.slice(0, full.lastIndexOf('在疼') + 2); // 引号和大括号全丢
        const r = parseEmotionEvalOutput(truncated);
        expect(r?.changed).toBe(true);
        expect(r?.buffs?.length).toBe(1);
        expect(r?.injection).toContain('当前情绪底色');
        expect(r?.innerState).toContain('睡着');
    });

    it('围栏也被截断 (```json 开了没闭合)', () => {
        const full = '```json\n' + JSON.stringify(VALID);
        const r = parseEmotionEvalOutput(full.slice(0, full.length - 8));
        expect(r?.changed).toBe(true);
        expect(r?.buffs?.length).toBe(1);
    });

    it('字段级抢救: JSON 烂到修不好, 仍抠出 innerState / injection', () => {
        // buffs 数组中间烂掉 (裸引号+截断+错括号), 整体 parse 必然失败
        const raw = `{"changed": true, "buffs": [{"name": : broken!!], "injection": "### 注入内容", "innerState": "抢救出来的独白"`;
        const r = parseEmotionEvalOutput(raw);
        expect(r?.salvaged).toBe(true);
        expect(r?.injection).toBe('### 注入内容');
        expect(r?.innerState).toBe('抢救出来的独白');
    });

    it('彻底没有 JSON → null', () => {
        expect(parseEmotionEvalOutput('抱歉，我无法完成这个分析。')).toBeNull();
        expect(parseEmotionEvalOutput('')).toBeNull();
    });
});

describe('prioritizeNewBuffs — 新情绪置顶', () => {
    const oldA = { id: 'a', name: 'old_a', label: '旧A', intensity: 2 } as any;
    const oldB = { id: 'b', name: 'old_b', label: '旧B', intensity: 3 } as any;

    it('模型把新情绪 append 到末尾时，落地前自动顶到最前', () => {
        const fresh = { id: 'c', name: 'fresh_c', label: '新C', intensity: 4 } as any;
        expect(prioritizeNewBuffs([oldA, oldB, fresh], [oldA, oldB]).map(buff => buff.id))
            .toEqual(['c', 'a', 'b']);
    });

    it('已有情绪只改强度，不视为新条目，不改变顺序', () => {
        const changedA = { ...oldA, intensity: 5 };
        const changedB = { ...oldB, intensity: 1 };
        expect(prioritizeNewBuffs([changedB, changedA], [oldA, oldB]).map(buff => buff.id))
            .toEqual(['b', 'a']);
    });

    it('模型偶尔换 id 但 name/label 相同，仍认作旧情绪', () => {
        const sameFeelingNewId = { id: 'new-id', name: 'old_a', label: '旧A', intensity: 4 } as any;
        const fresh = { id: 'fresh', name: 'fresh', label: '全新', intensity: 3 } as any;
        expect(prioritizeNewBuffs([sameFeelingNewId, fresh], [oldA]).map(buff => buff.id))
            .toEqual(['fresh', 'new-id']);
    });
});

describe('reconcileEmotionBuffs — 有限生命周期', () => {
    const a = { id: 'a', name: 'a', label: '旧A', intensity: 2 } as any;
    const b = { id: 'b', name: 'b', label: '旧B', intensity: 3 } as any;
    const c = { id: 'c', name: 'c', label: '旧C', intensity: 2 } as any;

    it('本轮只吐一个新情绪时，旧情绪先保留一轮且新情绪置顶', () => {
        const fresh = { id: 'd', name: 'd', label: '新D', intensity: 4 } as any;
        const misses = new Map<string, number>();
        expect(reconcileEmotionBuffs([a, b, c], [fresh], [], misses).map(x => x.id))
            .toEqual(['d', 'a', 'b', 'c']);
    });

    it('旧情绪连续漏两轮自动淘汰，重新出现会把漏记清零', () => {
        const misses = new Map<string, number>();
        const first = reconcileEmotionBuffs([a, b], [], [], misses);
        expect(first.map(x => x.id)).toEqual(['a', 'b']);

        const second = reconcileEmotionBuffs(first, [], [], misses);
        expect(second).toEqual([]);

        const revivedMisses = new Map<string, number>();
        const onceMissing = reconcileEmotionBuffs([a], [], [], revivedMisses);
        const confirmed = reconcileEmotionBuffs(onceMissing, [{ ...a, intensity: 5 }], [], revivedMisses);
        expect(confirmed.map(x => x.id)).toEqual(['a']);
        expect(confirmed[0].intensity).toBe(5);
        expect(revivedMisses.size).toBe(0);
    });

    it('removedBuffIds 明确删除时立即移除，不等宽限期', () => {
        const misses = new Map<string, number>();
        expect(reconcileEmotionBuffs([a, b, c], [], ['a', 'c'], misses).map(x => x.id))
            .toEqual(['b']);
    });

    it('总数硬上限 5，新情绪和本轮确认情绪优先于只靠宽限保留的历史', () => {
        const old = Array.from({ length: 6 }, (_, i) => ({
            id: `old-${i}`,
            name: `old_${i}`,
            label: `旧${i}`,
            intensity: 2,
        })) as any[];
        const fresh = { id: 'fresh', name: 'fresh', label: '全新', intensity: 4 } as any;
        const result = reconcileEmotionBuffs(old, [fresh, old[4]], [], new Map());
        expect(result).toHaveLength(EMOTION_BUFF_MAX_COUNT);
        expect(result[0].id).toBe('fresh');
        expect(result.some(x => x.id === 'old-4')).toBe(true);
    });

    it('同 id 返回新版时更新旧条目，不生成重复 buff', () => {
        const changedB = { ...b, label: '旧B变了', intensity: 5 };
        const result = reconcileEmotionBuffs([a, b, c], [changedB], [], new Map());
        expect(result.map(x => x.id)).toEqual(['b', 'a', 'c']);
        expect(result[0].intensity).toBe(5);
        expect(result[0].label).toBe('旧B变了');
    });
});

describe('applyEmotionEvalRaw — 落库语义', () => {
    it('过期评估被 latest-write guard 拦截，不得落库覆盖新一轮', async () => {
        const dispatched: any[] = [];
        (globalThis as any).window = {
            dispatchEvent: (e: any) => { dispatched.push(e); return true; },
        };
        try {
            const inner = await applyEmotionEvalRaw(
                JSON.stringify(VALID),
                makeChar(),
                undefined,
                { shouldApply: () => false },
            );
            expect(inner).toBeNull();
            expect(saveCharacter).not.toHaveBeenCalled();
            expect(dispatched.some((e) => e.type === 'emotion-updated')).toBe(false);
        } finally {
            delete (globalThis as any).window;
        }
    });

    it('changed=true 完整结果 → 保存 + 返回 innerState', async () => {
        const char = makeChar();
        const inner = await applyEmotionEvalRaw(JSON.stringify(VALID), char);
        expect(inner).toBe('她还没回消息……');
        expect(saveCharacter).toHaveBeenCalledTimes(1);
        const saved = saveCharacter.mock.calls[0][0];
        expect(saved.activeBuffs[0].label).toBe('焦虑');
        expect(saved.activeBuffs[0].intensity).toBe(4); // 评估提示词使用的 1–5 级强度原样保留
        expect(saved.buffInjection).toContain('当前情绪底色');
    });

    it('漏写 changed 的完整结果仍保存新情绪', async () => {
        const { changed: _changed, ...withoutChanged } = VALID;
        await applyEmotionEvalRaw(JSON.stringify(withoutChanged), makeChar());
        expect(saveCharacter).toHaveBeenCalledTimes(1);
        expect(saveCharacter.mock.calls[0][0].activeBuffs[0].label).toBe('焦虑');
    });

    it('changed=false → 不动 buff, 只返回 innerState', async () => {
        const inner = await applyEmotionEvalRaw(
            JSON.stringify({ changed: false, innerState: '平稳的独白' }),
            makeChar(),
        );
        expect(inner).toBe('平稳的独白');
        expect(saveCharacter).not.toHaveBeenCalled();
    });

    it('空 buffs 不再误清旧情绪；只有 removedBuffIds 明确列出的才删除', async () => {
        const current = makeChar({
            activeBuffs: [
                { id: 'keep', name: 'keep', label: '保留', intensity: 2 },
                { id: 'gone', name: 'gone', label: '消退', intensity: 1 },
            ],
            buffInjection: '旧注入',
        });
        getAllCharacters.mockResolvedValue([current]);
        await applyEmotionEvalRaw(
            JSON.stringify({
                changed: true,
                buffs: [],
                removedBuffIds: ['gone'],
                injection: '',
                innerState: '已经平静一些',
            }),
            current,
        );
        expect(saveCharacter).toHaveBeenCalledTimes(1);
        const saved = saveCharacter.mock.calls[0][0];
        expect(saved.activeBuffs.map((buff: any) => buff.id)).toEqual(['keep']);
        expect(saved.buffInjection).toBe('旧注入');
    });

    it('落情绪时保留 DB 中请求期间新保存的其他角色字段', async () => {
        getAllCharacters.mockResolvedValue([{ ...makeChar(), description: '请求期间修改的新设定' }]);
        await applyEmotionEvalRaw(JSON.stringify(VALID), makeChar({ description: '旧设定' }));
        expect(saveCharacter.mock.calls[0][0].description).toBe('请求期间修改的新设定');
    });

    it('changed=true 但 buffs/injection 全缺 → 不清空已有情绪状态', async () => {
        const inner = await applyEmotionEvalRaw(
            JSON.stringify({ changed: true, innerState: '只有独白' }),
            makeChar(),
        );
        expect(inner).toBe('只有独白');
        expect(saveCharacter).not.toHaveBeenCalled();
    });

    it('抢救场景: 只抠出 injection → 保留旧 buffs, 换新 injection', async () => {
        const raw = `{"changed": true, "buffs": [{"name": : broken!!], "injection": "### 新注入", "innerState": "独白"`;
        const inner = await applyEmotionEvalRaw(raw, makeChar());
        expect(inner).toBe('独白');
        expect(saveCharacter).toHaveBeenCalledTimes(1);
        const saved = saveCharacter.mock.calls[0][0];
        expect(saved.activeBuffs[0].id).toBe('buff_old'); // 旧 buff 保住
        expect(saved.buffInjection).toBe('### 新注入');
    });

    it('buff 缺 name 用 id 兜底、缺 label 用 name 兜底, 不再整条丢弃', async () => {
        const raw = JSON.stringify({
            changed: true,
            buffs: [
                { id: 'buff_x', label: '只有中文标签', intensity: 2 },
                { name: 'only_name', intensity: 2 },
                { intensity: 2 }, // 两者全缺才丢
            ],
            injection: 'x',
        });
        await applyEmotionEvalRaw(raw, makeChar());
        const saved = saveCharacter.mock.calls[0][0];
        expect(saved.activeBuffs.length).toBe(3);
        expect(saved.activeBuffs[0].name).toBe('buff_x');
        expect(saved.activeBuffs[1].label).toBe('only_name');
        expect(saved.activeBuffs[2].id).toBe('buff_old');
    });

    it('解析彻底失败 → null 且不动 DB', async () => {
        const inner = await applyEmotionEvalRaw('模型拒绝了输出', makeChar());
        expect(inner).toBeNull();
        expect(saveCharacter).not.toHaveBeenCalled();
    });
});

describe('extractAssistantText — 响应形态兜底', () => {
    it('普通字符串 content', () => {
        expect(extractAssistantText({ content: 'hello' })).toBe('hello');
    });

    it('分块数组 content', () => {
        expect(extractAssistantText({ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] })).toBe('a\nb');
    });

    it('content 为空时回退 reasoning_content', () => {
        expect(extractAssistantText({ content: '', reasoning_content: '{"changed":false}' })).toBe('{"changed":false}');
    });

    it('全空 → 空字符串', () => {
        expect(extractAssistantText({ content: '' })).toBe('');
        expect(extractAssistantText(null)).toBe('');
    });
});

describe('applyEmotionEvalRaw — 失败可见性 (chat-gen-emotion-failed)', () => {
    // 评估失败过去只写 console.warn，用户侧「情绪不更新但没报错」没法自查（真实反馈）。
    // 锁住：解析全灭时必须派发失败事件（OSContext 监听弹 toast）。
    it('解析全灭 → 派发 chat-gen-emotion-failed，detail 带 charId/reason', async () => {
        const dispatched: any[] = [];
        (globalThis as any).window = {
            dispatchEvent: (e: any) => { dispatched.push(e); return true; },
        };
        try {
            const inner = await applyEmotionEvalRaw('完全不是 JSON 的输出', makeChar());
            expect(inner).toBeNull();
            const failed = dispatched.find((e) => e.type === 'chat-gen-emotion-failed');
            expect(failed).toBeTruthy();
            expect(failed.detail.charId).toBe('char-1');
            expect(failed.detail.charName).toBe('测试角色');
            expect(typeof failed.detail.reason).toBe('string');
        } finally {
            delete (globalThis as any).window;
        }
    });

    it('解析成功（即使 salvage）不派发失败事件', async () => {
        const dispatched: any[] = [];
        (globalThis as any).window = {
            dispatchEvent: (e: any) => { dispatched.push(e); return true; },
        };
        try {
            await applyEmotionEvalRaw(JSON.stringify(VALID), makeChar());
            expect(dispatched.some((e) => e.type === 'chat-gen-emotion-failed')).toBe(false);
            // 正常路径照旧广播 emotion-updated
            expect(dispatched.some((e) => e.type === 'emotion-updated')).toBe(true);
        } finally {
            delete (globalThis as any).window;
        }
    });
});
