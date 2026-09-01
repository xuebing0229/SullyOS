import { DB } from './db';
import type { CharacterProfile, CharacterBuff } from '../types';
import { landAmbientEventFromEval } from './roomAmbient';
import { CHAT_GEN_EVENTS } from './chatGenEvents';

// 情绪评估失败的用户可见信号（OSContext 监听弹 toast）。本函数是本地 / instant(worker)
// 两条路径的共用落点，在这里派发能覆盖「worker 推回的 raw 解析全灭」这类云端失败。
const announceEmotionFailed = (charData: CharacterProfile, reason: string): void => {
    try {
        if (typeof window !== 'undefined') {
            window.dispatchEvent(new CustomEvent(CHAT_GEN_EVENTS.emotionFailed, {
                detail: { charId: charData.id, charName: charData.name, reason },
            }));
        }
    } catch { /* SSR / 测试环境无 window */ }
};

// 角色「最后一次内心独白(InnerState)」的轻量缓存（localStorage）。
// innerState 是瞬时产物，这里在情绪评估落地的共用点顺手缓存一份，供别处（如查手机首页）读取，
// 不额外动 CharacterProfile / DB schema。
export const lastInnerStateKey = (charId: string) => `sully_last_innerstate_${charId}`;
export function getLastInnerState(charId: string): string {
    try {
        return (typeof localStorage !== 'undefined' && localStorage.getItem(lastInnerStateKey(charId))) || '';
    } catch { return ''; }
}

const INTERNAL_USER_LABEL_FALLBACK = '对方';
const USER_NARRATIVE_FOLLOWERS = '(?:说|表示|告诉|问|回答|回复|觉得|认为|想|希望|担心|喜欢|讨厌|看|听|做|给|让|叫|称|提到|沉默|离开|回来|正在|已经|没有|还|又|会|要|能|可以|应该|可能|似乎|仿佛|的|对|与|和|向|把|被|在|从|为|令|使)';
const USER_NARRATIVE_PRECEDERS = '(问|看着|等待|想起|回应|回复|告诉|靠近|面对|在意|寻找|安慰|拥抱|注视)';

/**
 * 清理情绪 JSON 叙事字段中的内部身份标签。
 * 仅对传入的字符串值工作，不扫描原始 JSON，因此不会修改字段名。
 * 中文没有天然单词边界：通过叙事动词/介词和标点边界识别人物称呼，避免误伤
 * 「用户体验」「用户协议」「用户设置」「用户档案」等普通产品词组。
 */
export function replaceInternalUserLabel(text: string, userName?: string): string {
    if (typeof text !== 'string' || !text) return text;
    const replacement = userName?.trim() || INTERNAL_USER_LABEL_FALLBACK;
    return text
        .replace(new RegExp(`用户(?=${USER_NARRATIVE_FOLLOWERS})`, 'g'), replacement)
        .replace(new RegExp(`${USER_NARRATIVE_PRECEDERS}用户`, 'g'), `$1${replacement}`)
        .replace(/用户(?=$|[\s，。！？；：、）】”’])/g, replacement)
        .replace(new RegExp('\\bthe\\s+user\\b\\s*(?=[\\u3400-\\u9fff，。！？；：、）】”’]|$)', 'gi'), replacement)
        .replace(new RegExp('\\bthe\\s+user\\b', 'gi'), replacement)
        .replace(new RegExp('\\bUser\\b\\s*(?=[\\u3400-\\u9fff，。！？；：、）】”’]|$)', 'g'), replacement)
        .replace(new RegExp('\\bUser\\b', 'g'), replacement);
}

// 情绪评估结果「解析 + 落 buff」的共用实现.
//
// 原本内联在 hooks/useChatAI.ts 的 evaluateEmotionBackground 里. 提取出来是为了让两条路径共用:
//   1. 本地模式: 客户端跑 eval LLM 拿到 raw, 调本函数落地.
//   2. instant 模式: worker 跑 eval LLM, 把 raw 作为 emotion_update push 推回, 客户端 flush 时调本函数落地.
//
// 入参 rawText = LLM 返回的原始文本 (可能含 ```json 包裹). 返回 innerState (意识流) 字符串或 null,
// 调用方负责把它喂回下一轮 prompt (evolvedNarrative). buff 的应用 (写 DB + 广播 emotion-updated)
// 在本函数内完成.

const sanitizeBuffs = (buffs?: CharacterBuff[]): CharacterBuff[] => {
    if (!Array.isArray(buffs)) return [];
    return buffs
        .map((buff, index) => {
            let label = typeof buff?.label === 'string' ? buff.label.trim() : '';
            let name = typeof buff?.name === 'string' ? buff.name.trim() : '';
            // 模型偶尔漏 name (内部英文 id) 或漏 label (中文标签) — 缺一半不该整条丢弃,
            // 用另一半兜底: name 缺就从 id/序号派生, label 缺就用 name 顶上.
            if (!label && !name) return null;
            if (!name) name = (typeof buff?.id === 'string' && buff.id.trim()) ? buff.id.trim() : `emotion_${index}`;
            if (!label) label = name;

            const rawIntensity = Number((buff as any)?.intensity);
            const intensity: CharacterBuff['intensity'] = !Number.isFinite(rawIntensity)
                ? 2
                : rawIntensity <= 1
                    ? 1
                    : rawIntensity >= 5
                        ? 5
                        : Math.round(rawIntensity) as CharacterBuff['intensity'];

            const out: CharacterBuff = {
                id: typeof buff?.id === 'string' && buff.id.trim() ? buff.id.trim() : `buff_${Date.now()}_${index}`,
                name,
                label,
                intensity,
            };
            if (typeof buff?.emoji === 'string') out.emoji = buff.emoji;
            if (typeof buff?.color === 'string') out.color = buff.color;
            if (typeof buff?.description === 'string') out.description = buff.description;
            return out;
        })
        .filter((buff): buff is CharacterBuff => !!buff);
};

/**
 * 新情绪置顶，旧情绪顺延。
 *
 * 模型维护 buffs 时通常会先复述旧数组，再把刚出现的情绪 append 到末尾；UI 如果原样渲染，
 * 新情绪就永远躲在「+N」后面。这里用上一轮持久化快照判定新旧：
 * - id 相同 = 同一条
 * - name 相同 = 同一语义（兼容模型偶尔改 id）
 * - label 相同 = 同一展示情绪（兼容 name 轻微漂移）
 *
 * 只把“本轮真正新增”的条目提到前面；已有情绪之间仍保持模型本轮给出的相对顺序，
 * 因此强度变化不会让整排标签反复跳来跳去。
 */
export const prioritizeNewBuffs = (
    nextBuffs: CharacterBuff[],
    previousBuffs: CharacterBuff[],
): CharacterBuff[] => {
    if (nextBuffs.length <= 1 || previousBuffs.length === 0) return nextBuffs;

    const previousIds = new Set(previousBuffs.map(buff => buff.id?.trim()).filter(Boolean));
    const previousNames = new Set(previousBuffs.map(buff => buff.name?.trim().toLowerCase()).filter(Boolean));
    const previousLabels = new Set(previousBuffs.map(buff => buff.label?.trim()).filter(Boolean));

    const isExisting = (buff: CharacterBuff): boolean => {
        const id = buff.id?.trim();
        const name = buff.name?.trim().toLowerCase();
        const label = buff.label?.trim();
        return (id ? previousIds.has(id) : false)
            || (name ? previousNames.has(name) : false)
            || (label ? previousLabels.has(label) : false);
    };

    const newlyAdded: CharacterBuff[] = [];
    const existing: CharacterBuff[] = [];
    for (const buff of nextBuffs) {
        (isExisting(buff) ? existing : newlyAdded).push(buff);
    }
    return newlyAdded.length > 0 ? [...newlyAdded, ...existing] : nextBuffs;
};

export const EMOTION_BUFF_MAX_COUNT = 5;
export const EMOTION_BUFF_MISS_GRACE_ROUNDS = 1;

const buffTrackingKey = (buff: CharacterBuff): string =>
    buff.id?.trim()
    || buff.name?.trim().toLowerCase()
    || buff.label?.trim()
    || '';

/**
 * Hybrid lifecycle:
 * - model confirms/updates a buff -> keep, missed counter resets
 * - model omits a buff once -> keep for one grace round
 * - model omits it twice in a row -> expire automatically
 * - removedBuffIds -> remove immediately
 * - hard cap at 5, with genuinely new/confirmed emotions ahead of grace-kept history
 *
 * missCounts is intentionally external so callers can keep one small counter map per character
 * without polluting persisted CharacterBuff objects or the evaluator prompt.
 */
export const reconcileEmotionBuffs = (
    previousBuffs: CharacterBuff[],
    incomingBuffs: CharacterBuff[],
    removedBuffIds: string[] = [],
    missCounts: Map<string, number> = new Map(),
): CharacterBuff[] => {
    const removed = new Set(
        removedBuffIds.map(id => String(id || '').trim()).filter(Boolean),
    );

    for (const previous of previousBuffs) {
        if (removed.has(previous.id)) {
            const key = buffTrackingKey(previous);
            if (key) missCounts.delete(key);
        }
    }

    const effectiveIncoming = incomingBuffs.filter(
        buff => !buff.id || !removed.has(buff.id),
    );

    const incomingById = new Map<string, CharacterBuff>();
    const incomingByName = new Map<string, CharacterBuff>();
    const incomingByLabel = new Map<string, CharacterBuff>();
    for (const buff of effectiveIncoming) {
        if (buff.id) incomingById.set(buff.id.trim(), buff);
        if (buff.name) incomingByName.set(buff.name.trim().toLowerCase(), buff);
        if (buff.label) incomingByLabel.set(buff.label.trim(), buff);
    }

    const consumed = new Set<CharacterBuff>();
    const confirmedExisting: CharacterBuff[] = [];
    const gracePreserved: CharacterBuff[] = [];

    for (const previous of previousBuffs) {
        if (removed.has(previous.id)) continue;

        const replacement =
            (previous.id ? incomingById.get(previous.id.trim()) : undefined)
            || (previous.name ? incomingByName.get(previous.name.trim().toLowerCase()) : undefined)
            || (previous.label ? incomingByLabel.get(previous.label.trim()) : undefined);

        const previousKey = buffTrackingKey(previous);
        if (replacement) {
            consumed.add(replacement);
            if (previousKey) missCounts.delete(previousKey);
            const replacementKey = buffTrackingKey(replacement);
            if (replacementKey) missCounts.delete(replacementKey);
            confirmedExisting.push(replacement);
            continue;
        }

        const missed = (previousKey ? missCounts.get(previousKey) : 0) || 0;
        const nextMissed = missed + 1;
        if (nextMissed <= EMOTION_BUFF_MISS_GRACE_ROUNDS) {
            if (previousKey) missCounts.set(previousKey, nextMissed);
            gracePreserved.push(previous);
        } else if (previousKey) {
            missCounts.delete(previousKey);
        }
    }

    const genuinelyNew = effectiveIncoming.filter(buff => !consumed.has(buff));
    for (const buff of genuinelyNew) {
        const key = buffTrackingKey(buff);
        if (key) missCounts.delete(key);
    }

    const result = [
        ...genuinelyNew,
        ...confirmedExisting,
        ...gracePreserved,
    ].slice(0, EMOTION_BUFF_MAX_COUNT);

    const keptKeys = new Set(result.map(buffTrackingKey).filter(Boolean));
    for (const key of Array.from(missCounts.keys())) {
        if (!keptKeys.has(key)) missCounts.delete(key);
    }

    return result;
};

// Per-character omission counters live only in memory. A restart simply grants old buffs
// another single grace round; it never makes them immortal and avoids leaking internal
// lifecycle metadata into backups, prompts, or UI.
const emotionBuffMissCountsByChar = new Map<string, Map<string, number>>();

const getEmotionBuffMissCounts = (charId: string): Map<string, number> => {
    let map = emotionBuffMissCountsByChar.get(charId);
    if (!map) {
        map = new Map<string, number>();
        emotionBuffMissCountsByChar.set(charId, map);
    }
    return map;
};

// ─── JSON 修复链 (全部 string-aware 逐字符扫描, 不用正则盲扫以免误伤字符串内容) ───

// 修复 1: 把 JSON 字符串值里的裸换行/制表符转义, 兼容 LLM 偶尔吐未转义控制字符的情况.
const repairControlChars = (s: string): string => {
    let inStr = false, esc = false, out = '';
    for (let i = 0; i < s.length; i++) {
        const ch = s[i];
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

// 修复 2: 转义字符串值内部的裸英文双引号 (模型写中文引语时常直接用 " 不转义).
// 判定规则: 处于字符串内时遇到 ", 向后看第一个非空白字符 — 是 , : } ] 或到结尾才算真正的
// 闭合引号, 否则视为内容里的裸引号, 转成 \". 启发式并不完美, 但只在直接 parse 失败后才启用.
const repairInnerQuotes = (s: string): string => {
    let inStr = false, esc = false, out = '';
    for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        if (esc) { out += ch; esc = false; continue; }
        if (ch === '\\') { out += ch; esc = true; continue; }
        if (ch === '"') {
            if (!inStr) { inStr = true; out += ch; continue; }
            let j = i + 1;
            while (j < s.length && /\s/.test(s[j])) j++;
            const next = j < s.length ? s[j] : '';
            if (next === '' || next === ',' || next === ':' || next === '}' || next === ']') {
                inStr = false; out += ch;
            } else {
                out += '\\"';
            }
            continue;
        }
        out += ch;
    }
    return out;
};

// 修复 3: 去掉 } / ] 前的尾逗号.
const stripTrailingCommas = (s: string): string => {
    let inStr = false, esc = false, out = '';
    for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        if (esc) { out += ch; esc = false; continue; }
        if (inStr) {
            if (ch === '\\') esc = true;
            else if (ch === '"') inStr = false;
            out += ch;
            continue;
        }
        if (ch === '"') { inStr = true; out += ch; continue; }
        if (ch === ',') {
            let j = i + 1;
            while (j < s.length && /\s/.test(s[j])) j++;
            if (s[j] === '}' || s[j] === ']') continue; // 丢弃尾逗号
        }
        out += ch;
    }
    return out;
};

// 修复 4: 补全被截断的 JSON (max_tokens 截断 / 响应中断).
// 扫描记录括号栈, 结尾时: 关掉未闭合字符串 → 去掉悬空的 , / 给悬空的 : 补 null → 逆序补闭合括号.
const closeTruncatedJson = (s: string): string => {
    let inStr = false, esc = false;
    const stack: string[] = [];
    for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        if (esc) { esc = false; continue; }
        if (inStr) {
            if (ch === '\\') esc = true;
            else if (ch === '"') inStr = false;
            continue;
        }
        if (ch === '"') inStr = true;
        else if (ch === '{') stack.push('}');
        else if (ch === '[') stack.push(']');
        else if (ch === '}' || ch === ']') {
            if (stack[stack.length - 1] === ch) stack.pop();
        }
    }
    let out = s;
    if (esc) out = out.slice(0, -1); // 截断在反斜杠上, 丢掉半个转义序列
    if (inStr) out += '"';
    out = out.replace(/[\s]+$/, '');
    if (out.endsWith(',')) out = out.slice(0, -1);
    if (out.endsWith(':')) out += ' null';
    while (stack.length) out += stack.pop();
    return out;
};

// 从原文里定位第一个 { 并按括号平衡截取完整对象 (容忍前后夹杂闲聊文字, 后缀里有 } 也不误吞).
const extractBalancedObject = (raw: string): string | undefined => {
    const start = raw.indexOf('{');
    if (start < 0) return undefined;
    let inStr = false, esc = false, depth = 0;
    for (let i = start; i < raw.length; i++) {
        const ch = raw[i];
        if (esc) { esc = false; continue; }
        if (inStr) {
            if (ch === '\\') esc = true;
            else if (ch === '"') inStr = false;
            continue;
        }
        if (ch === '"') inStr = true;
        else if (ch === '{') depth++;
        else if (ch === '}') {
            depth--;
            if (depth === 0) return raw.slice(start, i + 1);
        }
    }
    return undefined;
};

export interface EmotionEvalResult {
    changed: boolean;
    buffs?: CharacterBuff[];
    /** Explicit removals. Omitting an old buff from buffs no longer deletes it. */
    removedBuffIds?: string[];
    injection?: string;
    innerState?: string;
    /** true = 整体 JSON.parse 全失败, 靠字段级正则抢救出来的部分结果 */
    salvaged?: boolean;
}

const looksLikeEvalResult = (v: any): boolean =>
    !!v && typeof v === 'object' && !Array.isArray(v)
    && ('changed' in v || 'buffs' in v || 'removedBuffIds' in v || 'injection' in v || 'innerState' in v);

const tryParseObject = (s: string): any | null => {
    try {
        const v = JSON.parse(s);
        return (v && typeof v === 'object' && !Array.isArray(v)) ? v : null;
    } catch { return null; }
};

// 字段级抢救: 整体 parse 全灭时, 用带转义感知的正则把 innerState / injection / changed / buffs
// 单独抠出来 — 宁可拿到部分结果, 也不要整轮情绪评估静默蒸发.
const salvageFields = (repairedRaw: string): EmotionEvalResult | null => {
    const pickString = (key: string): string | undefined => {
        const m = repairedRaw.match(new RegExp(`"${key}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)`));
        if (!m || !m[1]) return undefined;
        let v: string;
        try { v = JSON.parse(`"${m[1]}"`); }
        catch {
            v = m[1].replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
        }
        v = v.trim();
        return v || undefined;
    };

    let buffs: CharacterBuff[] | undefined;
    const buffsIdx = repairedRaw.search(/"buffs"\s*:\s*\[/);
    if (buffsIdx >= 0) {
        const arrStart = repairedRaw.indexOf('[', buffsIdx);
        let inStr = false, esc = false, depth = 0;
        for (let i = arrStart; i < repairedRaw.length; i++) {
            const ch = repairedRaw[i];
            if (esc) { esc = false; continue; }
            if (inStr) {
                if (ch === '\\') esc = true;
                else if (ch === '"') inStr = false;
                continue;
            }
            if (ch === '"') inStr = true;
            else if (ch === '[') depth++;
            else if (ch === ']') {
                depth--;
                if (depth === 0) {
                    try {
                        const arr = JSON.parse(stripTrailingCommas(repairedRaw.slice(arrStart, i + 1)));
                        if (Array.isArray(arr)) buffs = arr;
                    } catch { /* 数组本身也烂, 放弃 buffs */ }
                    break;
                }
            }
        }
    }

    const pickStringArray = (key: string): string[] | undefined => {
        const idx = repairedRaw.search(new RegExp(`"${key}"\\s*:\\s*\\[`));
        if (idx < 0) return undefined;
        const arrStart = repairedRaw.indexOf('[', idx);
        if (arrStart < 0) return undefined;
        let inStr = false, esc = false, depth = 0;
        for (let i = arrStart; i < repairedRaw.length; i++) {
            const ch = repairedRaw[i];
            if (esc) { esc = false; continue; }
            if (inStr) {
                if (ch === '\\') esc = true;
                else if (ch === '"') inStr = false;
                continue;
            }
            if (ch === '"') inStr = true;
            else if (ch === '[') depth++;
            else if (ch === ']') {
                depth--;
                if (depth === 0) {
                    try {
                        const arr = JSON.parse(stripTrailingCommas(repairedRaw.slice(arrStart, i + 1)));
                        if (Array.isArray(arr)) {
                            return arr.map(value => String(value || '').trim()).filter(Boolean);
                        }
                    } catch { /* ignore */ }
                    return undefined;
                }
            }
        }
        return undefined;
    };

    const removedBuffIds = pickStringArray('removedBuffIds');
    const injection = pickString('injection');
    const innerState = pickString('innerState');
    const changedMatch = repairedRaw.match(/"changed"\s*:\s*"?(true|false)"?/i);

    if (!injection && !innerState && !buffs && !removedBuffIds) return null;
    const changed = changedMatch
        ? changedMatch[1].toLowerCase() === 'true'
        : !!(injection || buffs); // 抢救出了 injection/buffs 就当有变化, 只有 innerState 则不动 buff
    return { changed, buffs, removedBuffIds, injection, innerState, salvaged: true };
};

/**
 * 纯解析层 (无副作用, 导出供测试): 从 LLM 原始输出里尽量抠出情绪评估结果.
 *
 * 候选片段 (依次尝试): ```json 围栏 → 裸 ``` 围栏 → 未闭合围栏 → 括号平衡对象 →
 * 贪婪首 { 尾 } → 首 { 到文末 (截断). 每个候选跑修复链: 原样 → 转义裸控制字符 →
 * 转义字符串内裸引号 → 去尾逗号 → 补全截断. 全灭后走字段级正则抢救. 实在没有 → null.
 */
export function parseEmotionEvalOutput(rawText: string): EmotionEvalResult | null {
    const raw = (rawText || '').trim();
    if (!raw) return null;

    const candidates: string[] = [];
    const pushCand = (s?: string) => {
        const t = (s || '').trim();
        if (t && t.includes('{') && !candidates.includes(t)) candidates.push(t);
    };
    const fenceRe = /```(?:json)?\s*([\s\S]*?)```/gi;
    let fm: RegExpExecArray | null;
    while ((fm = fenceRe.exec(raw)) !== null) pushCand(fm[1]);
    const openFence = raw.match(/```(?:json)?\s*([\s\S]*)$/i);
    if (openFence) pushCand(openFence[1]); // 围栏没闭合 (输出被截断)
    pushCand(extractBalancedObject(raw));
    // 「首 { 到文末」要排在贪婪匹配之前: 截断场景下贪婪会停在 buffs 里最后一个 } 上,
    // 补全后只剩 changed+buffs, 把后面的 injection/innerState 全丢了; 而这个候选对
    // 完整 JSON + 尾巴闲聊的输入必然 parse 失败 (尾部有非 JSON 文本), 不会误伤.
    const firstBrace = raw.indexOf('{');
    if (firstBrace >= 0) pushCand(raw.slice(firstBrace));
    const greedy = raw.match(/\{[\s\S]*\}/);
    if (greedy) pushCand(greedy[0]);

    let repairedForSalvage = '';
    for (const cand of candidates) {
        const c1 = repairControlChars(cand);
        const c2 = repairInnerQuotes(c1);
        const c3 = stripTrailingCommas(c2);
        const c4 = closeTruncatedJson(c3);
        if (!repairedForSalvage) repairedForSalvage = c3;
        for (const attempt of [cand, c1, c2, c3, c4]) {
            const v = tryParseObject(attempt);
            if (v && looksLikeEvalResult(v)) {
                // 模型偶尔把布尔写成字符串 "true"/"false"
                // changed 偶尔会整字段漏掉。只要完整结果里已经有 buffs / injection，
                // 就和字段级抢救分支一样视为有变化；否则明明生成了新情绪也会在落库前
                // 被 changed=false 短路，用户侧只看到 API 调用成功、情绪却没有更新。
                const explicitChanged = v.changed === true
                    || (typeof v.changed === 'string' && v.changed.toLowerCase() === 'true');
                const explicitUnchanged = v.changed === false
                    || (typeof v.changed === 'string' && v.changed.toLowerCase() === 'false');
                const changed = explicitChanged
                    ? true
                    : explicitUnchanged
                        ? false
                        : Array.isArray(v.buffs) || (typeof v.injection === 'string' && !!v.injection.trim());
                return {
                    changed,
                    buffs: Array.isArray(v.buffs) ? v.buffs : undefined,
                    removedBuffIds: Array.isArray(v.removedBuffIds)
                        ? v.removedBuffIds.map((value: unknown) => String(value || '').trim()).filter(Boolean)
                        : undefined,
                    injection: typeof v.injection === 'string' ? v.injection : undefined,
                    innerState: typeof v.innerState === 'string' ? v.innerState : undefined,
                };
            }
        }
    }

    return salvageFields(repairedForSalvage || repairInnerQuotes(repairControlChars(raw)));
}

/**
 * 从 chat-completion 响应的 message 对象里尽量抠出文本.
 * content 可能是字符串, 也可能是分块数组 (部分 Claude 兼容代理); content 为空时回退
 * reasoning_content (个别代理开思考后把全部输出塞进 reasoning, content 留空 —— 后续
 * parseEmotionEvalOutput 会从里面正则定位 JSON, 喂进去无害).
 */
export function extractAssistantText(message: any): string {
    if (!message) return '';
    const c = message.content;
    if (typeof c === 'string' && c.trim()) return c;
    if (Array.isArray(c)) {
        const joined = c
            .map((p: any) => (typeof p === 'string' ? p : (p?.text || '')))
            .filter(Boolean)
            .join('\n');
        if (joined.trim()) return joined;
    }
    const r = message.reasoning_content;
    if (typeof r === 'string' && r.trim()) return r;
    return '';
}

/**
 * 解析情绪评估 raw 文本并落地 buff. 返回 innerState (意识流) 或 null.
 * - 解析失败 → 返回 null, 不动 buff.
 * - changed=false → 不动 buff, 返回 innerState (若有).
 * - changed=true → sanitize buffs → DB.saveCharacter → 广播 'emotion-updated' → 返回 innerState.
 * - changed=true 但 buffs / injection 双缺失 (格式烂到只抢救出 innerState) → 不清空已有
 *   buff 状态, 只返回 innerState —— 解析半残不该把角色现有情绪底色抹掉.
 */
export interface ApplyEmotionEvalOptions {
    /**
     * 异步评估可能前后轮重叠。返回 false 时说明这份结果已经过期，必须放弃所有角色状态落地。
     */
    shouldApply?: () => boolean;
}

export async function applyEmotionEvalRaw(
    rawText: string,
    charData: CharacterProfile,
    userName?: string,
    options?: ApplyEmotionEvalOptions,
): Promise<string | null> {
    try {
        const result = parseEmotionEvalOutput(rawText || '');
        if (!result) {
            console.warn('🎭 [Emotion] Could not parse eval output (all repairs + salvage failed):', (rawText || '').slice(0, 300));
            announceEmotionFailed(charData, '评估模型的输出不是可解析的 JSON（模型掉格式，可换个评估模型试试）');
            return null;
        }
        if (result.salvaged) {
            console.warn('🎭 [Emotion] Full JSON parse failed, salvaged fields:', {
                buffs: result.buffs?.length ?? 0,
                injection: !!result.injection,
                innerState: !!result.innerState,
            });
        }

        const innerStateOut = (typeof result.innerState === 'string' && result.innerState.trim())
            ? replaceInternalUserLabel(result.innerState.trim(), userName)
            : null;

        if (options?.shouldApply && !options.shouldApply()) {
            console.log('🎭 [Emotion] Dropped stale eval result before side effects:', charData.id);
            return null;
        }

        if (innerStateOut) {
            try { localStorage.setItem(lastInnerStateKey(charData.id), innerStateOut); } catch { /* ignore */ }
        }

        // 小屋生活动态（可选顺风车产出，见 utils/roomAmbient.ts）：落 room_card 进私聊。
        // 本函数是在线 / instant(worker) 两条路径的共用落点，所以在这里接。
        // 与情绪主链路完全解耦——失败只丢这条动态，不影响 buff。
        await landAmbientEventFromEval(result, charData);

        const hasBuffArray = Array.isArray(result.buffs);
        const hasRemovedBuffIds = Array.isArray(result.removedBuffIds);
        const hasInjection = typeof result.injection === 'string' && !!result.injection.trim();

        // changed 只能表示模型自己的判断，不能覆盖它同时返回的权威快照。
        // 一些模型会输出 changed:false，却仍然给出已演化的 buffs（尤其是 []，
        // 表示旧情绪已消退）。旧逻辑在这里直接 return，导致旧情绪卡永远清不掉。
        if (!result.changed && !hasBuffArray && !hasRemovedBuffIds && !hasInjection) {
            console.log('🎭 [Emotion] No change detected, skipping buff update');
            if (innerStateOut) console.log(`🌊 [InnerState] ${charData.name}: ${innerStateOut}`);
            return innerStateOut;
        }

        if (!hasBuffArray && !hasRemovedBuffIds && !hasInjection) {
            // changed=true 但两个载荷都没拿到 — 保留现状比清空安全
            console.warn('🎭 [Emotion] changed=true but no buffs/injection parsed, keeping existing state');
            if (innerStateOut) console.log(`🌊 [InnerState] ${charData.name}: ${innerStateOut}`);
            return innerStateOut;
        }

        // 评估请求可能跑几十秒，期间角色的其他设置也可能已保存。
        // 落情绪时以 DB 里最新角色为底，避免被请求启动时捕获的旧 charData 整体盖回。
        const latestChar = (await DB.getAllCharacters()).find(character => character.id === charData.id) || charData;

        const previousBuffs = latestChar.activeBuffs || [];
        const sanitizedIncoming = (hasBuffArray ? sanitizeBuffs(result.buffs) : [])
            .map(buff => typeof buff.description === 'string'
                ? { ...buff, description: replaceInternalUserLabel(buff.description, userName) }
                : buff);
        const removedBuffIds = hasRemovedBuffIds
            ? result.removedBuffIds!.map(id => String(id || '').trim()).filter(Boolean)
            : [];
        const sanitizedBuffs = (hasBuffArray || hasRemovedBuffIds)
            ? reconcileEmotionBuffs(
                previousBuffs,
                sanitizedIncoming,
                removedBuffIds,
                getEmotionBuffMissCounts(charData.id),
            )
            : previousBuffs.slice(0, EMOTION_BUFF_MAX_COUNT);
        const buffInjection = hasInjection
            ? replaceInternalUserLabel(result.injection!, userName)
            : (latestChar.buffInjection || '');
        const updated: CharacterProfile = {
            ...latestChar,
            activeBuffs: sanitizedBuffs,
            buffInjection,
        };

        // DB 读取/环境动态落地本身也会 await；期间如果更新一轮评估已经启动，
        // 再检查一次，禁止旧轮在最后一刻把新轮的角色状态倒灌回去。
        if (options?.shouldApply && !options.shouldApply()) {
            console.log('🎭 [Emotion] Dropped stale eval result before save:', charData.id);
            return null;
        }
        await DB.saveCharacter(updated);

        // detail 直接带上 buffs + buffInjection: 监听方 (Chat) 可直接落 OSContext, 不必重读 DB
        // —— 避开 saveCharacter 未等事务提交 / instant flush 下 DB 重读偶发拿旧值的竞态.
        if (typeof window !== 'undefined') {
            window.dispatchEvent(new CustomEvent('emotion-updated', {
                detail: { charId: charData.id, buffs: sanitizedBuffs, buffInjection },
            }));
        }
        console.log('🎭 [Emotion] Updated buffs:', sanitizedBuffs.map((b) => b.label).join(', ') || 'none');
        if (innerStateOut) console.log(`🌊 [InnerState] ${charData.name}: ${innerStateOut}`);
        return innerStateOut;
    } catch (e: any) {
        console.warn('🎭 [Emotion] applyEmotionEvalRaw failed:', e?.message);
        announceEmotionFailed(charData, `评估结果落库失败：${e?.message || '未知错误'}`);
        return null;
    }
}
