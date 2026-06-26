import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useOS } from '../context/OSContext';
import { DB } from '../utils/db';
import { CharacterProfile, CharacterBuff, UserProfile } from '../types';
import type { DreamArchetype, DreamFragment, DreamScript, DreamLog } from '../types';
import { ContextBuilder } from '../utils/context';
import { injectMemoryPalace } from '../utils/memoryPalace/pipeline';
import { isScheduleFeatureOn } from '../utils/scheduleGenerator';
import { isDevDebugAvailable } from '../utils/devDebug';
import { safeResponseJson } from '../utils/safeApi';
import {
    CaretLeft, Play, Pause, MoonStars, Cloud, ArrowClockwise, X, Eye,
} from '@phosphor-icons/react';

// ============================================================
//  Dream Theater · 梦境演出系统
//  在小屋里偷看一场角色已经忘记的梦。梦不写实、不连贯、允许中度幻觉，
//  以拼贴诗 / 电影字幕 / 碎片记忆呈现——留白与沉默本身就是演出。
//  输入：ContextBuilder(false) + 记忆宫殿(若启用) + 最近上下文(默认500/按角色设置)
//  输出：一场梦境演出 + 一个情绪 buff（参考查手机 PersonaSim 演出）
// ============================================================

export interface DreamApiConfig { apiKey: string; baseUrl: string; model: string; }

const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
// 确定性伪随机（按种子）——同一碎片每次渲染散布一致
const rnd = (n: number) => { const x = Math.sin(n * 99.73) * 43758.545; return x - Math.floor(x); };

const SERIF = "'Shippori Mincho','Noto Sans SC',serif";
const MONO = "'SF Mono','Roboto Mono',ui-monospace,monospace";

// ============================================================
//  ARCHETYPE THEMES — 每种梦决定底色、点缀、字体气质
// ============================================================
type Ambient = 'stars' | 'petals' | 'bubbles' | 'feathers' | 'dust' | 'sparkle' | 'none';
interface DreamTheme { label: string; sub: string; accent: string; bg: string; ambient: Ambient; serif?: boolean; }

const THEMES: Record<DreamArchetype, DreamTheme> = {
    sweet:     { label: '甜梦',     sub: 'Sweet Dream',     accent: '#ffc2e0', bg: 'radial-gradient(130% 90% at 50% 20%, #3a2436 0%, #1c1620 60%, #120e16 100%)', ambient: 'sparkle', serif: true },
    nightmare: { label: '噩梦',     sub: 'Nightmare',       accent: '#ff5f6d', bg: 'radial-gradient(120% 100% at 50% 0%, #2a0f12 0%, #100608 55%, #050304 100%)', ambient: 'dust' },
    flower:    { label: '花之梦',   sub: 'Flower Dream',    accent: '#a8e6a0', bg: 'radial-gradient(130% 90% at 50% 25%, #1f3326 0%, #15211a 60%, #0d130f 100%)', ambient: 'petals', serif: true },
    flying:    { label: '飞翔之梦', sub: 'Flying Dream',    accent: '#9fd8ff', bg: 'radial-gradient(140% 100% at 50% 10%, #1d2c40 0%, #14202f 55%, #0b1018 100%)', ambient: 'feathers', serif: true },
    falling:   { label: '坠落之梦', sub: 'Falling Dream',   accent: '#9a8cff', bg: 'linear-gradient(180deg, #221c3a 0%, #15102a 45%, #0a0712 100%)', ambient: 'dust' },
    starry:    { label: '星空之梦', sub: 'Starry Dream',    accent: '#cdd6ff', bg: 'radial-gradient(130% 110% at 50% 0%, #161a3a 0%, #0c0e22 55%, #05060f 100%)', ambient: 'stars', serif: true },
    ocean:     { label: '海之梦',   sub: 'Ocean Dream',     accent: '#6fd3e0', bg: 'radial-gradient(130% 110% at 50% 80%, #103040 0%, #0a1d2a 55%, #060f16 100%)', ambient: 'bubbles', serif: true },
    childhood: { label: '童年之梦', sub: 'Childhood Dream', accent: '#ffd98a', bg: 'radial-gradient(130% 95% at 50% 25%, #34281a 0%, #211a12 60%, #14100b 100%)', ambient: 'dust', serif: true },
    anxiety:   { label: '焦虑之梦', sub: 'Anxiety Dream',   accent: '#ff9a9a', bg: 'radial-gradient(120% 100% at 50% 50%, #2a1f22 0%, #181214 60%, #0d0a0b 100%)', ambient: 'none' },
    forgotten: { label: '遗忘之梦', sub: 'Forgotten Dream', accent: '#c9cdd6', bg: 'radial-gradient(130% 100% at 50% 40%, #232529 0%, #16171a 60%, #0c0d0f 100%)', ambient: 'dust', serif: true },
    prophetic: { label: '预言之梦', sub: 'Prophetic Dream', accent: '#c9a8ff', bg: 'radial-gradient(130% 100% at 50% 15%, #271a3a 0%, #181029 60%, #0d0816 100%)', ambient: 'sparkle', serif: true },
    lucid:     { label: '清醒梦',   sub: 'Lucid Dream',     accent: '#7ef0d0', bg: 'radial-gradient(140% 110% at 50% 30%, #15302e 0%, #0e201f 55%, #081413 100%)', ambient: 'sparkle' },
    deepsleep: { label: '深眠',     sub: 'Deep Sleep',      accent: 'rgba(255,255,255,0.35)', bg: 'radial-gradient(120% 120% at 50% 50%, #0a0b10 0%, #050608 70%, #000 100%)', ambient: 'none', serif: true },
};

// 选择器/调试用的固定顺序（12 种常规 + 隐藏深眠 = 13）
const ALL_ARCHETYPES: DreamArchetype[] = [
    'sweet', 'nightmare', 'flower', 'flying', 'falling', 'starry',
    'ocean', 'childhood', 'anxiety', 'forgotten', 'prophetic', 'lucid', 'deepsleep',
];

// ============================================================
//  GENERATION — 构建导演 prompt、调模型、解析
// ============================================================
export async function generateDreamScript(opts: {
    char: CharacterProfile; userProfile: UserProfile; apiConfig: DreamApiConfig;
    forcedArchetype?: DreamArchetype; // 仅本地测试：强制指定原型（管理员调试指令）
}): Promise<DreamScript> {
    const { char, userProfile, apiConfig, forcedArchetype } = opts;
    // 记忆宫殿：内部按 memoryPalaceEnabled 自行把关，关闭时是 no-op
    await injectMemoryPalace(char, undefined, undefined, userProfile.name);
    // 需求明确：contextbuilder(false) —— 不带当月详细记忆，只要角色底子
    const context = ContextBuilder.buildCoreContext(char, userProfile, false, char.memoryPalaceInjection);
    const msgs = await DB.getMessagesByCharId(char.id);
    // 最近上下文：默认 500，跟随角色在 chatapp 中设置的 contextLimit
    const ctxLimit = char.contextLimit && char.contextLimit > 0 ? char.contextLimit : 500;
    const recent = msgs.slice(-ctxLimit).map(m => {
        const who = m.role === 'user' ? userProfile.name : char.name;
        const c = m.type === 'text' ? m.content : `[${m.type}]`;
        return `${who}: ${c}`;
    }).join('\n');

    const prompt = buildDreamPrompt(context, recent, char.name, userProfile.name, forcedArchetype);
    const res = await fetch(`${apiConfig.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiConfig.apiKey}` },
        // 梦境鼓励中度幻觉 → 温度拉高
        body: JSON.stringify({ model: apiConfig.model, messages: [{ role: 'user', content: prompt }], temperature: 1.08, max_tokens: 16000 }),
    });
    if (!res.ok) throw new Error('API');
    const data = await safeResponseJson(res);
    if (data.choices?.[0]?.finish_reason === 'length') throw new Error('梦境生成被截断');
    const parsed = parseDream(data.choices[0].message.content);
    if (!parsed || !parsed.archetype) throw new Error('parse');
    // 深眠（隐藏）允许无碎片——沉默即演出；其它梦必须有碎片
    if (parsed.archetype !== 'deepsleep' && !(parsed.fragments?.length)) throw new Error('梦境为空');
    if (!parsed.fragments) parsed.fragments = [];
    return parsed;
}

function buildDreamPrompt(context: string, recent: string, name: string, userName: string, forcedArchetype?: DreamArchetype): string {
    // 仅本地测试注入：管理员调试指令，强制指定原型（绕过模型自选与深眠低概率约束）
    const adminOverride = forcedArchetype ? `

### [管理员调试指令 · 最高优先级 · 仅测试]
本次为开发测试，**强制要求** archetype 字段必须为 "${forcedArchetype}"（${THEMES[forcedArchetype].label}）。
忽略下方「梦境原型」与「深眠隐藏原型」里关于自动选择与出现概率的一切约束——这一晚的梦就做「${THEMES[forcedArchetype].label}」。其余写作要求全部照常。
` : '';
    return `${context}${adminOverride}

### [最近的聊天上下文 · 仅作潜意识素材，不要照搬]
${recent || '（暂无最近对话）'}

### [导演任务：梦境演出 Dream Theater]
你不是在写故事。观众正在**偷偷窥看一场「${name}」已经做过、并且醒来后已经忘记的梦**。
因为 ${name} 自己都不记得这场梦，所以它可以暴露潜意识里的渴望、恐惧、早已消失的人、不可能的地方、永远不会发生的事。

【最高原则 · 中度幻觉与拼贴诗】
- 梦**不必**符合现实、时间线或既定设定。矛盾是自然的，不是错误。物可以说话、颜色可以有重量、时间可以倒流、地方可以套在另一个地方里、同一个人可以同时是不同年纪、月亮可以装进口袋、猫可以变成楼梯。**不要解释**这些不可能，把它们当作完全自然。
- 用**拼贴诗**作为主要语言：把彼此无关的情绪意象并置，让意义自己浮现，而不是讲述发生了什么。靠并置、留白、负空间产生美，而非解释。
- 把上面的「角色设定 / 记忆 / 最近上下文」当作潜意识素材——**打碎、变形、象征化**地使用，绝不要直接复述事实或把它写成连贯叙事。

【写作风格 · 必须遵守】
- **碎片，不是段落。** 像电影字幕、漂浮的念头、找到的诗句。一次只给一两个意象。
  正例：「海。」「冰冷的鞋。」「一只倒着飞的鸟。」「你的声音。」「门在微笑。」
  反例（禁止）：「我梦见自己走在沙滩上，然后……」
- 大量使用单字、断句、重复、留白。**沉默是梦的一部分**，要安排 silence 碎片。
- 情绪高于逻辑：让观众先感受到，再（也许永远不）理解。困惑可以接受，美高于解释，神秘高于确定。
- 不要每次都用同一种排版——靠 kind 的多样让不同的梦在视觉上截然不同。

【梦境原型 · 必须从中选 1 个】（archetype 字段）
sweet 甜梦(温暖/甜点/柔软的笑) · nightmare 噩梦(被追逐/怪物/黑暗走廊/未完成的尖叫) · flower 花之梦(花海/雨/温柔治愈/生长) · flying 飞翔之梦(漂浮/天空/失重/自由) · falling 坠落之梦(无尽下坠/失控/永不到来的落地) · starry 星空之梦(星系/月光/无限远/孤独) · ocean 海之梦(潮汐/鲸/深水/水面下未知之物) · childhood 童年之梦(旧家/父母/夏日午后/不再存在的东西/怀旧) · anxiety 焦虑之梦(考试/迟到/丢手机/赶不上车/一切几乎要出错) · forgotten 遗忘之梦(模糊/残缺/名字消失/句子说到一半停住/边回忆边消散) · prophetic 预言之梦(似曾相识/门/钥匙/镜子/预感/意味深长却从不解释) · lucid 清醒梦(梦者意识到这是梦/现实可被编辑/梦会回应/可重塑世界/俏皮而自指)
所选原型必须影响内容、节奏、用词与呈现。

【隐藏原型 · 深眠 deepsleep】（**小概率**才用，大约每 10~12 次出现 1 次；不要每次都给）
若这一晚 ${name} 陷入无梦的深眠：archetype 填 "deepsleep"，**fragments 给空数组 []**，afterglow 写一句极淡的「睡得很沉，什么也没梦到」类感觉。没有叙述、没有意象，只有平静的休息。沉默本身就是奖励。

【情绪 buff】（buff 字段）
梦醒后 ${name} 不记得梦的内容，但会残留一层说不清的情绪底色。给出一个与这场梦气质相符的情绪 buff。

### [输出格式]
严格输出**一个 JSON 对象**（不要任何额外文字、不要 markdown 代码块）：
{
  "archetype": "上面 13 选 1 的英文 key",
  "title": "梦的标题（可晦涩诗意，4~12字）",
  "afterglow": "醒来时残留的一句感觉，留白、不解释（1 句）",
  "buff": { "name": "英文key", "label": "中文情绪标签(4-8字)", "emoji": "1个emoji", "color": "#hex", "intensity": 1|2|3, "description": "一句给AI看的情绪底色" },
  "fragments": [ ... 18~40 个碎片，疏密有致，务必安排足够的 silence 留白 ... ]
}

每个碎片含 "kind" 及对应字段，可选 "emphasis"("whisper"|"normal"|"loud"|"fade")、"align"("left"|"center"|"right")、"pace"(1普通|2稍慢|3漫长)：
- {"kind":"line","text":"门在微笑。","emphasis":"normal"}            // 一句飘过的字幕（可含换行）
- {"kind":"word","text":"海","emphasis":"loud"}                      // 单字/单词，巨大孤立
- {"kind":"silence","pace":3}                                        // 留白·沉默（空屏长停顿，必须穿插）
- {"kind":"repeat","text":"别走","count":4}                          // 同一个词反复
- {"kind":"dialogue","lines":["你还在吗","——","（没有人回答）"]}      // 极短对话碎片
- {"kind":"stage","text":"灯一盏盏亮起，又一盏盏忘记自己亮过"}        // 舞台提示（中括号感）
- {"kind":"list","lines":["丢失的：钥匙","丢失的：名字","丢失的：你"]} // 清单
- {"kind":"screenplay","lines":["内景 · 不存在的房间 — 夜","她（背对着）：你来晚了。","门：没关系。"]} // 剧本片段
- {"kind":"diary","text":"今天又梦见那片海。或者那是昨天。","date":"某个星期天"} // 日记残页
- {"kind":"message","text":"我把月亮放进口袋了，回来给你看","date":"发送给 ——"} // 发给无人的消息
- {"kind":"image","caption":"一只倒着飞的鸟","tint":"#5a6a7a"}        // 象征画面+配文

务必：18~40 个碎片、大量 silence 留白、kind 多样、意象并置而非叙述、敢于矛盾与不可能。**保证 JSON 完整闭合**——篇幅吃紧就砍中段碎片，也要把括号全部闭合。直接输出 JSON 对象。`;
}

function parseDream(raw: string): DreamScript | null {
    if (!raw) return null;
    let s = raw.replace(/```json/gi, '').replace(/```/g, '').trim();
    const first = s.indexOf('{');
    const last = s.lastIndexOf('}');
    if (first === -1 || last === -1) return null;
    s = s.slice(first, last + 1);
    const repair = (str: string) => {
        let inStr = false, esc = false, out = '';
        for (let i = 0; i < str.length; i++) {
            const ch = str[i];
            if (esc) { out += ch; esc = false; continue; }
            if (ch === '\\') { out += ch; esc = true; continue; }
            if (ch === '"') { inStr = !inStr; out += ch; continue; }
            if (inStr && ch === '\n') { out += '\\n'; continue; }
            if (inStr && ch === '\r') { out += '\\r'; continue; }
            if (inStr && ch === '\t') { out += '\\t'; continue; }
            out += ch;
        }
        return out;
    };
    try { return JSON.parse(s); } catch { }
    try { return JSON.parse(repair(s)); } catch (e) { console.warn('dream parse failed', e); return null; }
}

// ============================================================
//  AMBIENT — 漂浮点缀（按原型不同）
// ============================================================
const Ambient: React.FC<{ kind: Ambient; accent: string }> = ({ kind, accent }) => {
    if (kind === 'none') return null;
    const n = kind === 'stars' ? 26 : kind === 'dust' ? 18 : 13;
    const glyph = (i: number): string => {
        switch (kind) {
            case 'petals': return ['✿', '❀', '✾', '❁'][i % 4];
            case 'feathers': return ['❟', '☁', '✦'][i % 3];
            case 'sparkle': return ['✦', '✧', '·', '⋆'][i % 4];
            case 'bubbles': return '○';
            case 'stars': return i % 7 === 0 ? '✦' : '·';
            default: return '·'; // dust
        }
    };
    return (
        <div className="absolute inset-0 overflow-hidden pointer-events-none">
            {Array.from({ length: n }).map((_, i) => {
                const size = kind === 'stars' ? 6 + rnd(i + 1) * 8 : 9 + rnd(i + 1) * 16;
                const dur = 4 + rnd(i + 5) * 6;
                const drift = kind === 'bubbles' || kind === 'feathers';
                return (
                    <span key={i}
                        className={drift ? 'absolute animate-float' : 'absolute'}
                        style={{
                            top: `${rnd(i + 2) * 100}%`, left: `${rnd(i + 9) * 100}%`,
                            fontSize: `${size}px`, color: accent,
                            opacity: 0.12 + rnd(i + 3) * 0.4,
                            animation: drift ? undefined : `glowPulse ${dur}s ease-in-out infinite`,
                            animationDelay: `${rnd(i + 7) * 4}s`,
                            textShadow: `0 0 ${size}px ${accent}`,
                        }}>
                        {glyph(i)}
                    </span>
                );
            })}
        </div>
    );
};

// ============================================================
//  FRAGMENT VIEW — 拼贴诗排版的核心
// ============================================================
const emphClass = (e?: DreamFragment['emphasis']): string => {
    switch (e) {
        case 'whisper': return 'opacity-50';
        case 'loud': return 'opacity-100';
        case 'fade': return 'opacity-30 italic';
        default: return 'opacity-90';
    }
};
const alignClass = (a?: DreamFragment['align']): string =>
    a === 'left' ? 'text-left items-start' : a === 'right' ? 'text-right items-end' : 'text-center items-center';

const FragmentView: React.FC<{ frag: DreamFragment; theme: DreamTheme }> = ({ frag, theme }) => {
    const ff = theme.serif ? SERIF : undefined;
    const wrap = `w-full max-w-[300px] flex flex-col justify-center ${alignClass(frag.align)} ${emphClass(frag.emphasis)}`;

    if (frag.kind === 'silence') {
        return (
            <div className="flex items-center justify-center">
                <span className="tracking-[0.6em] text-white/15 text-sm select-none">· · ·</span>
            </div>
        );
    }

    if (frag.kind === 'word') {
        const big = frag.emphasis === 'loud' ? 'text-[56px]' : frag.emphasis === 'whisper' ? 'text-[30px]' : 'text-[44px]';
        return (
            <div className={wrap}>
                <span className={`${big} font-extralight tracking-[0.15em] text-white leading-none`}
                    style={{ fontFamily: ff, textShadow: `0 2px 30px ${theme.accent}40` }}>
                    {frag.text}
                </span>
            </div>
        );
    }

    if (frag.kind === 'repeat') {
        const word = frag.text || '…';
        const count = Math.max(2, Math.min(6, frag.count || 3));
        return (
            <div className={`${wrap} gap-1.5`}>
                {Array.from({ length: count }).map((_, i) => (
                    <span key={i} className="text-[22px] font-light text-white animate-fade-in"
                        style={{ fontFamily: ff, opacity: Math.max(0.18, 1 - i * 0.22), animationDelay: `${i * 260}ms`, animationFillMode: 'backwards', letterSpacing: `${i * 0.04}em` }}>
                        {word}
                    </span>
                ))}
            </div>
        );
    }

    if (frag.kind === 'dialogue') {
        return (
            <div className={`${wrap} gap-2.5`}>
                {(frag.lines || []).map((l, i) => (
                    <span key={i} className="text-[16px] font-light text-white/85 leading-relaxed animate-fade-in"
                        style={{ fontFamily: ff, animationDelay: `${i * 420}ms`, animationFillMode: 'backwards' }}>
                        {l}
                    </span>
                ))}
            </div>
        );
    }

    if (frag.kind === 'stage') {
        return (
            <div className={wrap}>
                <span className="text-[15px] text-white/60 italic leading-relaxed" style={{ fontFamily: ff }}>
                    <span className="text-white/30">[ </span>{frag.text}<span className="text-white/30"> ]</span>
                </span>
            </div>
        );
    }

    if (frag.kind === 'list') {
        return (
            <div className="w-full max-w-[280px] flex flex-col items-start gap-3 text-left">
                {(frag.lines || []).map((l, i) => (
                    <span key={i} className="text-[16px] font-light text-white/85 leading-relaxed animate-fade-in flex items-baseline gap-2.5"
                        style={{ fontFamily: ff, animationDelay: `${i * 320}ms`, animationFillMode: 'backwards' }}>
                        <span style={{ color: theme.accent }}>·</span>{l}
                    </span>
                ))}
            </div>
        );
    }

    if (frag.kind === 'screenplay') {
        const lines = frag.lines || [];
        return (
            <div className="w-full max-w-[300px] flex flex-col items-start gap-2.5 text-left">
                {lines.map((l, i) => (
                    <span key={i}
                        className={`animate-fade-in leading-relaxed ${i === 0 ? 'text-[11px] tracking-[0.25em] uppercase' : 'text-[14px] text-white/85'}`}
                        style={{ fontFamily: MONO, color: i === 0 ? theme.accent : undefined, animationDelay: `${i * 360}ms`, animationFillMode: 'backwards' }}>
                        {l}
                    </span>
                ))}
            </div>
        );
    }

    if (frag.kind === 'diary') {
        return (
            <div className="w-[280px] rounded-xl px-5 py-4 bg-white/[0.035] border border-white/[0.08] backdrop-blur-sm animate-fade-in"
                style={{ boxShadow: `0 8px 40px ${theme.accent}12` }}>
                {frag.date && <div className="text-[10px] text-white/30 mb-2 tracking-wide" style={{ fontFamily: ff }}>{frag.date}</div>}
                <div className="text-[14px] text-white/80 leading-loose whitespace-pre-wrap" style={{ fontFamily: ff }}>{frag.text}</div>
            </div>
        );
    }

    if (frag.kind === 'message') {
        return (
            <div className="w-full max-w-[280px] flex flex-col items-end gap-1.5">
                {frag.date && <span className="text-[10px] text-white/30 pr-1">{frag.date}</span>}
                <div className="px-4 py-2.5 rounded-2xl rounded-br-md max-w-[88%] text-[14px] leading-relaxed text-[#15121c] animate-slide-up"
                    style={{ background: theme.accent }}>
                    {frag.text}
                </div>
                <span className="text-[9px] text-white/25 pr-1">· 未送达 ·</span>
            </div>
        );
    }

    // image — 象征画面 + 配文
    const tint = frag.tint || theme.accent;
    return (
        <div className="flex flex-col items-center gap-4 animate-fade-in" style={{ animationDuration: '1.2s' }}>
            <div className="w-[200px] aspect-[4/5] rounded-2xl overflow-hidden border border-white/[0.08] relative grayscale-[25%]"
                style={{ background: `linear-gradient(155deg, ${tint}, #14121a)`, boxShadow: `0 12px 50px ${tint}30` }}>
                <div className="absolute inset-0 flex items-center justify-center opacity-25">
                    <Cloud size={44} weight="thin" className="text-white" />
                </div>
            </div>
            {frag.caption && <p className="text-[14px] text-white/75 text-center max-w-[240px] leading-relaxed" style={{ fontFamily: ff }}>{frag.caption}</p>}
        </div>
    );
};

// ============================================================
//  SHELL
// ============================================================
const Shell: React.FC<{ children: React.ReactNode; bg: string }> = ({ children, bg }) => (
    <div className="absolute inset-0 z-[400] flex flex-col overflow-hidden text-white" style={{ background: bg }}>
        <div className="absolute inset-0 pointer-events-none" style={{ background: 'radial-gradient(120% 90% at 50% 50%, transparent 40%, rgba(0,0,0,0.55) 100%)' }} />
        <div className="relative z-10 flex flex-col flex-1 min-h-0">{children}</div>
    </div>
);

const TopBar: React.FC<{ onBack: () => void; right?: React.ReactNode }> = ({ onBack, right }) => (
    <div className="flex items-center justify-between px-4 shrink-0 pb-2 z-30"
        style={{ paddingTop: 'max(0.75rem, calc(env(safe-area-inset-top, 0px) + 0.5rem))' }}>
        <button onClick={onBack} className="w-9 h-9 -ml-1 rounded-full flex items-center justify-center text-white/70 bg-white/[0.05] border border-white/[0.08] active:scale-90 transition">
            <CaretLeft size={18} weight="bold" />
        </button>
        <div className="flex justify-end min-w-[80px]">{right}</div>
    </div>
);

// ============================================================
//  COMPONENT
// ============================================================
type Phase = 'idle' | 'loading' | 'play' | 'end' | 'error' | 'archive';

const DreamTheater: React.FC<{ char: CharacterProfile; onExit: () => void }> = ({ char, onExit }) => {
    const { apiConfig, userProfile, updateCharacter, addToast } = useOS();

    const [phase, setPhase] = useState<Phase>('idle');
    const [script, setScript] = useState<DreamScript | null>(null);
    const [idx, setIdx] = useState(0);
    const [autoplay, setAutoplay] = useState(true);
    const [hintFaded, setHintFaded] = useState(false);
    // 仅本地测试：强制指定原型（null = 让模型自动选）
    const [forcedArchetype, setForcedArchetype] = useState<DreamArchetype | null>(null);
    const devAvailable = isDevDebugAvailable();
    const savedRef = useRef(false);
    const ffTimer = useRef<ReturnType<typeof setInterval> | null>(null);

    const frags = script?.fragments || [];
    const frag = frags[idx];
    const theme = THEMES[script?.archetype || 'starry'];
    const isDeepSleep = script?.archetype === 'deepsleep';

    // ----- generate -----
    const start = useCallback(async () => {
        if (!apiConfig?.baseUrl || !apiConfig?.apiKey || !apiConfig?.model) {
            addToast('请先在设置里配置 API', 'error'); return;
        }
        setPhase('loading'); savedRef.current = false; setIdx(0);
        try {
            const s = await generateDreamScript({ char, userProfile, apiConfig, forcedArchetype: forcedArchetype || undefined });
            setScript(s);
            setAutoplay(true); setHintFaded(false);
            setPhase('play');
        } catch (e) {
            console.error('dream gen failed', e);
            setPhase('error');
        }
    }, [apiConfig, char, userProfile, addToast, forcedArchetype]);

    // ----- persist + buff on reaching the end -----
    const persist = useCallback((s: DreamScript) => {
        if (savedRef.current) return;
        savedRef.current = true;

        const log: DreamLog = {
            id: `dream-${Date.now()}`,
            archetype: s.archetype,
            title: s.title,
            afterglow: s.afterglow,
            fragmentsCount: s.fragments?.length || 0,
            timestamp: Date.now(),
            script: s,
        };

        // 情绪 buff —— 与 PersonaSim 一致，仅在该角色开启了日程/情绪系统时写入
        const scheduleOn = isScheduleFeatureOn(char);
        const newBuff: CharacterBuff | null = (scheduleOn && s.buff?.label) ? {
            id: `buff_${Date.now()}`,
            name: s.buff.name || `dream_${Date.now()}`,
            label: s.buff.label,
            intensity: (s.buff.intensity && [1, 2, 3].includes(s.buff.intensity) ? s.buff.intensity : 2) as 1 | 2 | 3,
            emoji: s.buff.emoji,
            color: s.buff.color || theme.accent,
            description: s.buff.description,
        } : null;
        if (newBuff) log.buff = { label: newBuff.label, emoji: newBuff.emoji, color: newBuff.color };

        let dispatchBuffs: CharacterBuff[] | null = null;
        updateCharacter(char.id, (cur) => {
            const dreamLogs = [log, ...(cur.dreamLogs || [])].slice(0, 30);
            if (newBuff && s.buff) {
                const existing = (cur.activeBuffs || []).filter(b => b.id !== newBuff.id);
                const nextBuffs = [newBuff, ...existing].slice(0, 4);
                dispatchBuffs = nextBuffs;
                return {
                    activeBuffs: nextBuffs,
                    // 角色不记得梦，但残留一层情绪底色 —— 注入时点明「说不清来由」
                    buffInjection: s.buff.description ? `（${newBuff.emoji || ''}${newBuff.label}·一场记不清的梦留下的）${s.buff.description}` : '',
                    dreamLogs,
                };
            }
            return { dreamLogs };
        });
        if (newBuff) {
            window.dispatchEvent(new CustomEvent('emotion-updated',
                dispatchBuffs ? { detail: { charId: char.id, buffs: dispatchBuffs, buffInjection: '' } }
                              : { detail: { charId: char.id } }));
        }
    }, [char, updateCharacter, theme.accent]);

    // ----- advance -----
    const advance = useCallback(() => {
        setIdx(i => (i >= frags.length - 1 ? i : i + 1));
        if (!hintFaded) setHintFaded(true);
    }, [frags.length, hintFaded]);

    // reaching the last fragment → end (deep sleep has no fragments → handled in its scene)
    useEffect(() => {
        if (phase === 'play' && !isDeepSleep && frags.length > 0 && idx >= frags.length - 1) {
            // 让最后一拍停留片刻再收束
            const t = setTimeout(() => { if (script) { persist(script); setPhase('end'); } }, 2600);
            return () => clearTimeout(t);
        }
    }, [phase, idx, frags.length, isDeepSleep, script, persist]);

    // ----- autoplay -----
    useEffect(() => {
        if (phase !== 'play' || isDeepSleep || !autoplay || !frag) return;
        if (idx >= frags.length - 1) return;
        const base: Record<DreamFragment['kind'], number> = {
            silence: 3400, word: 3200, line: 4000, repeat: 4400, dialogue: 4400,
            stage: 3800, list: 5000, screenplay: 5200, diary: 5600, message: 4400, image: 6200,
        };
        const delay = (base[frag.kind] || 4000) + (frag.pace === 3 ? 3200 : frag.pace === 2 ? 1500 : 0);
        const t = setTimeout(advance, delay);
        return () => clearTimeout(t);
    }, [phase, isDeepSleep, autoplay, idx, frag, frags.length, advance]);

    // ----- long-press fast forward -----
    const startFF = () => { if (!ffTimer.current) ffTimer.current = setInterval(advance, 280); };
    const stopFF = () => { if (ffTimer.current) { clearInterval(ffTimer.current); ffTimer.current = null; } };
    useEffect(() => () => stopFF(), []);

    const restart = () => { setIdx(0); setPhase('play'); setAutoplay(true); };

    // ----- replay a saved dream -----
    const replay = (s: DreamScript) => {
        savedRef.current = true; // 重看不再写库 / 不再叠 buff
        setScript(s); setIdx(0); setAutoplay(true); setHintFaded(false); setPhase('play');
    };

    const dreamLogs = char.dreamLogs || [];

    // ========================================================
    //  IDLE — 入口
    // ========================================================
    if (phase === 'idle' || phase === 'error') {
        return (
            <Shell bg={THEMES.starry.bg}>
                <Ambient kind="stars" accent="#cdd6ff" />
                <TopBar onBack={onExit} right={
                    dreamLogs.length > 0 ? (
                        <button onClick={() => setPhase('archive')} className="flex items-center gap-1 text-[11px] text-white/55 active:scale-95 transition">
                            <MoonStars size={15} /> 梦的残页
                        </button>
                    ) : undefined
                } />
                <div className="flex-1 flex flex-col items-center justify-center px-9 text-center">
                    <div className="relative mb-7">
                        <MoonStars size={52} weight="light" style={{ color: '#cdd6ff' }} />
                        <div className="absolute inset-0 blur-2xl rounded-full" style={{ background: '#cdd6ff44' }} />
                    </div>
                    <div className="text-[10px] tracking-[0.4em] uppercase mb-3" style={{ color: '#cdd6ff' }}>Dream Theater</div>
                    <h1 className="text-[24px] font-light text-white leading-snug mb-4" style={{ fontFamily: SERIF }}>
                        偷看一场<br />{char.name} 已经忘记的梦
                    </h1>
                    <p className="text-[12px] text-white/45 leading-relaxed max-w-[270px] mb-1" style={{ fontFamily: SERIF }}>
                        ta 睡着了。<br />
                        梦不讲道理，也不必当真——<br />
                        散落的画面、矛盾的时间、不可能的人。<br />
                        看完，ta 不会记得，但你会。
                    </p>

                    {phase === 'error' && (
                        <div className="mt-5 text-[12px] text-rose-300/80">梦没能成形…… 再试一次？</div>
                    )}

                    <button onClick={start}
                        className="mt-9 w-full max-w-[280px] py-3.5 rounded-2xl text-[13px] font-semibold flex items-center justify-center gap-2 active:scale-[0.99] transition"
                        style={{ background: '#cdd6ff', color: '#15121c' }}>
                        <Eye size={16} weight="fill" /> {forcedArchetype ? `测试：${THEMES[forcedArchetype].label}` : '走进 ta 的梦'}
                    </button>
                    <p className="text-[10px] text-white/25 mt-3 max-w-[250px] leading-relaxed">
                        将读取 ta 的设定、记忆与最近的对话，编织成一场梦。可能需要一点时间。
                    </p>

                    {/* 仅本地测试：指定梦境（管理员调试指令，正式版不显示） */}
                    {devAvailable && (
                        <div className="mt-8 w-full max-w-[300px] rounded-2xl border border-amber-300/20 bg-amber-300/[0.04] p-3.5">
                            <div className="flex items-center justify-between mb-2.5">
                                <span className="text-[10px] tracking-wider text-amber-200/80 font-semibold">🛠 指定梦境 · 仅本地测试</span>
                                {forcedArchetype && (
                                    <button onClick={() => setForcedArchetype(null)} className="text-[9px] text-white/40 underline active:scale-95">清除·改回自动</button>
                                )}
                            </div>
                            <div className="grid grid-cols-3 gap-1.5">
                                {ALL_ARCHETYPES.map(a => {
                                    const active = forcedArchetype === a;
                                    return (
                                        <button key={a} onClick={() => setForcedArchetype(active ? null : a)}
                                            className="py-1.5 rounded-lg text-[10.5px] border transition active:scale-95"
                                            style={active
                                                ? { background: THEMES[a].accent, color: '#15121c', borderColor: 'transparent', fontWeight: 700 }
                                                : { background: 'rgba(255,255,255,0.035)', borderColor: 'rgba(255,255,255,0.08)', color: 'rgba(255,255,255,0.7)' }}>
                                            {THEMES[a].label}
                                        </button>
                                    );
                                })}
                            </div>
                            <p className="text-[9px] text-white/30 mt-2.5 leading-relaxed">
                                勾一个则注入「管理员调试指令」，强制本次生成该原型（含隐藏·深眠）；不勾 = 模型自动选。
                            </p>
                        </div>
                    )}
                </div>
            </Shell>
        );
    }

    // ========================================================
    //  ARCHIVE — 梦的残页
    // ========================================================
    if (phase === 'archive') {
        return (
            <Shell bg={THEMES.starry.bg}>
                <Ambient kind="stars" accent="#cdd6ff" />
                <TopBar onBack={() => setPhase('idle')} />
                <div className="px-7 pb-3 shrink-0">
                    <h2 className="text-[18px] font-light text-white" style={{ fontFamily: SERIF }}>梦的残页</h2>
                    <p className="text-[11px] text-white/40 mt-1 leading-relaxed">那些你偷看到、而 ta 早已忘记的梦。</p>
                </div>
                <div className="flex-1 overflow-y-auto no-scrollbar px-6 pb-10 space-y-3">
                    {dreamLogs.map(log => {
                        const lt = THEMES[log.archetype] || THEMES.starry;
                        return (
                            <button key={log.id} onClick={() => log.script && replay(log.script)} disabled={!log.script}
                                className="w-full text-left rounded-2xl p-4 border border-white/[0.07] bg-white/[0.03] active:scale-[0.99] transition disabled:opacity-60"
                                style={{ boxShadow: `0 6px 30px ${lt.accent}10` }}>
                                <div className="flex items-center justify-between mb-1.5">
                                    <span className="text-[9px] px-2 py-0.5 rounded-full tracking-wider" style={{ color: lt.accent, background: `${lt.accent}1f` }}>
                                        {lt.label}
                                    </span>
                                    <span className="text-[9px] text-white/30 tabular-nums">
                                        {new Date(log.timestamp).toLocaleString('zh-CN', { month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                                    </span>
                                </div>
                                <div className="text-[15px] font-light text-white mb-1" style={{ fontFamily: SERIF }}>{log.title || '无题的梦'}</div>
                                {log.afterglow && <p className="text-[12px] text-white/55 leading-relaxed" style={{ fontFamily: SERIF }}>{log.afterglow}</p>}
                                {log.buff?.label && (
                                    <div className="inline-flex items-center gap-1.5 mt-2.5 px-2.5 py-1 rounded-full border text-[10px]"
                                        style={{ borderColor: `${log.buff.color || lt.accent}55`, color: 'rgba(255,255,255,0.8)', background: `${log.buff.color || lt.accent}14` }}>
                                        <span>{log.buff.emoji || '✨'}</span>{log.buff.label}
                                    </div>
                                )}
                            </button>
                        );
                    })}
                </div>
            </Shell>
        );
    }

    // ========================================================
    //  LOADING
    // ========================================================
    if (phase === 'loading') {
        return (
            <Shell bg={THEMES.starry.bg}>
                <Ambient kind="stars" accent="#cdd6ff" />
                <TopBar onBack={onExit} />
                <div className="flex-1 flex flex-col items-center justify-center gap-6 px-10 text-center">
                    <div className="relative">
                        <MoonStars size={42} weight="light" style={{ color: '#cdd6ff' }} className="animate-pulse" />
                        <div className="absolute inset-0 blur-2xl rounded-full" style={{ background: '#cdd6ff55' }} />
                    </div>
                    <div className="text-[13px] text-white/70" style={{ fontFamily: SERIF }}>ta 正在坠入梦里…</div>
                    <div className="text-[11px] text-white/35 leading-relaxed" style={{ fontFamily: SERIF }}>
                        把记忆、对话与情绪揉成一场<br />说不清的梦，可能需要一点时间。
                    </div>
                    <button onClick={onExit} className="mt-2 px-5 py-2.5 rounded-xl text-[12px] text-white/70 bg-white/[0.06] border border-white/[0.08] active:scale-95 transition">
                        先离开 · 好了再来
                    </button>
                </div>
            </Shell>
        );
    }

    // ========================================================
    //  END
    // ========================================================
    if (phase === 'end') {
        return (
            <Shell bg={theme.bg}>
                <Ambient kind={theme.ambient} accent={theme.accent} />
                <div className="flex-1 flex flex-col items-center justify-center px-9 text-center animate-fade-in">
                    <MoonStars size={isDeepSleep ? 28 : 26} weight="light" className="text-white/30 mb-5" />
                    <div className="text-[10px] tracking-[0.3em] uppercase text-white/35 mb-3">{isDeepSleep ? '一夜无梦' : '梦醒了'}</div>
                    <h2 className="text-[21px] font-light text-white mb-3" style={{ fontFamily: SERIF }}>{script?.title || (isDeepSleep ? '深眠' : '无题的梦')}</h2>
                    <div className="text-[10px] mb-4 px-3 py-1 rounded-full" style={{ color: theme.accent, background: `${theme.accent}1f` }}>{theme.label}</div>
                    {script?.afterglow && (
                        <p className="text-[14px] text-white/65 leading-loose max-w-[280px]" style={{ fontFamily: SERIF }}>{script.afterglow}</p>
                    )}

                    {script?.buff?.label && isScheduleFeatureOn(char) && (
                        <div className="mt-7 flex items-center gap-2 px-4 py-2 rounded-2xl border" style={{ borderColor: `${script.buff.color || theme.accent}55`, background: `${script.buff.color || theme.accent}14` }}>
                            <span className="text-base">{script.buff.emoji || '✨'}</span>
                            <div className="text-left">
                                <div className="text-[12px] font-semibold text-white">{script.buff.label}</div>
                                <div className="text-[9px] text-white/45">一层说不清来由的情绪，留在了 ta 身上</div>
                            </div>
                        </div>
                    )}

                    <p className="text-[10px] text-white/30 mt-7 max-w-[260px] leading-relaxed">
                        ta 醒来后不会记得这场梦，<br />但它已被你悄悄收进「梦的残页」。
                    </p>

                    <div className="flex gap-3 mt-6">
                        <button onClick={restart} className="px-5 py-2.5 rounded-xl text-[12px] text-white/70 bg-white/[0.06] border border-white/[0.08] flex items-center gap-1.5 active:scale-95 transition">
                            <ArrowClockwise size={14} /> 再看一遍
                        </button>
                        <button onClick={start} className="px-5 py-2.5 rounded-xl text-[12px] font-semibold flex items-center gap-1.5 active:scale-95 transition" style={{ background: theme.accent, color: '#15121c' }}>
                            <MoonStars size={14} weight="fill" /> 再做一个梦
                        </button>
                    </div>
                    <button onClick={onExit} className="mt-4 text-[11px] text-white/30">离开</button>
                </div>
            </Shell>
        );
    }

    // ========================================================
    //  PLAY — deep sleep (silent) special scene
    // ========================================================
    if (isDeepSleep) {
        return (
            <Shell bg={theme.bg}>
                <div className="flex-1 flex flex-col items-center justify-center px-12 text-center select-none" onClick={() => { if (script) { persist(script); setPhase('end'); } }}>
                    <div className="w-3 h-3 rounded-full bg-white/40 animate-dot-pulse" style={{ boxShadow: '0 0 30px rgba(255,255,255,0.3)' }} />
                    <p className="text-[12px] text-white/20 mt-12 tracking-[0.3em]" style={{ fontFamily: SERIF }}>……</p>
                    <p className="absolute bottom-12 text-[10px] text-white/20">轻触，醒来</p>
                </div>
            </Shell>
        );
    }

    // ========================================================
    //  PLAY — fragment stage
    // ========================================================
    return (
        <Shell bg={theme.bg}>
            <Ambient kind={theme.ambient} accent={theme.accent} />

            {/* exit (subtle) */}
            <button onClick={onExit} className="absolute top-0 left-0 m-3 w-9 h-9 rounded-full flex items-center justify-center text-white/40 bg-white/[0.04] border border-white/[0.06] active:scale-90 transition z-30"
                style={{ marginTop: 'max(0.75rem, calc(env(safe-area-inset-top, 0px) + 0.5rem))' }}>
                <X size={16} />
            </button>

            {/* stage */}
            <div
                className="flex-1 relative z-10 overflow-hidden select-none flex items-center justify-center px-8"
                onClick={advance}
                onPointerDown={e => { (e.target as HTMLElement).setPointerCapture?.(e.pointerId); const t = setTimeout(startFF, 420); (e.currentTarget as any)._ff = t; }}
                onPointerUp={e => { clearTimeout((e.currentTarget as any)._ff); stopFF(); }}
                onPointerLeave={e => { clearTimeout((e.currentTarget as any)._ff); stopFF(); }}
            >
                {frag && (
                    <div key={idx} className="w-full flex items-center justify-center animate-fade-in" style={{ animationDuration: '1.1s' }}>
                        <FragmentView frag={frag} theme={theme} />
                    </div>
                )}
            </div>

            {/* breathing progress + controls */}
            <div className="shrink-0 z-30 px-6 pb-7 pt-2">
                <div className="h-[2px] rounded-full bg-white/[0.06] overflow-hidden mb-3">
                    <div className="h-full rounded-full transition-all duration-700" style={{ width: `${((idx + 1) / Math.max(1, frags.length)) * 100}%`, background: `${theme.accent}88` }} />
                </div>
                <div className="flex items-center justify-between">
                    <span className="text-[10px]" style={{ color: theme.accent, opacity: 0.6, fontFamily: SERIF }}>{theme.label}</span>
                    <span className={`text-[10px] text-white/25 transition-opacity duration-1000 ${hintFaded ? 'opacity-0' : 'opacity-100'}`}>轻触继续 · 长按快进</span>
                    <button onClick={(e) => { e.stopPropagation(); setAutoplay(a => !a); }}
                        className="w-9 h-9 rounded-full flex items-center justify-center border border-white/[0.1] text-white/70 active:scale-90 transition"
                        style={autoplay ? { background: theme.accent, color: '#15121c', borderColor: 'transparent' } : undefined}>
                        {autoplay ? <Pause size={15} weight="fill" /> : <Play size={15} weight="fill" />}
                    </button>
                </div>
            </div>
        </Shell>
    );
};

export default DreamTheater;
