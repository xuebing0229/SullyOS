/**
 * 小屋「生活动态」涓流（ambient delta，生活三层派生链 · 阶段E，docs/life-layers-design.md）
 *
 * 思路：情绪评估（副 API）本来就在每轮聊完后跑，让它**偶尔顺便**捎带一句
 * 「角色小屋里发生的小变化」——单句、极便宜、零额外调用，替代旧的每日全量刷新，
 * 给出「你不在的时候 TA 也在过日子」的感觉。
 *
 * 管线（双路径通吃）：
 *   1. buildEmotionEvalPrompt 构建时，若 shouldRequestAmbient 双闸通过，
 *      追加 buildAmbientEvalSection 的可选输出段（instant 模式的 prompt 也是客户端
 *      构建后传给 worker 的，所以这里改一处即可覆盖在线 + instant 两条路径）。
 *   2. applyEmotionEvalRaw（双路径共用落点）解析 raw 里的可选 ambientEvent，
 *      调 landAmbientEvent 落地：feed（封顶 30）+ 聊天 room_card（进上下文 →
 *      角色记得自己干过啥 → 顺现有归档管线自然入记忆，不建新记忆通道）。
 *
 * 节流双闸（都在客户端判，判不过连 prompt 都不加、不多花一分钱）：
 *   - 时间闸：距上一条 ambient < AMBIENT_MIN_INTERVAL_MS 不生成
 *   - 概率闸：过了时间闸也只有 AMBIENT_PROBABILITY 概率真出——"偶尔"的惊喜感，不是准点打卡
 */

import { CharacterProfile, RoomAmbientEvent } from '../types';
import { DB } from './db';

export const AMBIENT_MIN_INTERVAL_MS = 90 * 60 * 1000; // 90 分钟
export const AMBIENT_PROBABILITY = 0.3;
export const AMBIENT_FEED_CAP = 30;
const AMBIENT_TEXT_MAX = 60;

/** 双闸判定。random 可注入便于测试。 */
export function shouldRequestAmbient(
    char: Pick<CharacterProfile, 'roomAmbientFeed'>,
    random: () => number = Math.random,
): boolean {
    const last = char.roomAmbientFeed?.[0]?.timestamp || 0;
    if (Date.now() - last < AMBIENT_MIN_INTERVAL_MS) return false;
    return random() < AMBIENT_PROBABILITY;
}

/**
 * 情绪评估 prompt 的可选输出段。只在双闸通过时拼进去。
 * 注意口径：明确"绝大多数时候省略此字段"，别把偶尔的惊喜变成每轮的噪音。
 */
export function buildAmbientEvalSection(char: CharacterProfile): string {
    const items = (char.roomConfig?.items || [])
        .slice(0, 15)
        .map(i => `${i.id}（${i.name}）`)
        .join('、');
    const lastText = char.roomAmbientFeed?.[0]?.text;
    return `

## [可选] 小屋生活动态 (ambientEvent)
角色有一间自己的小屋。如果你觉得 ta 这段时间里、在自己的生活里自然会发生一个**微小的变化**
（换了桌上的书、窗台多了盆花、灯还亮着、杯子挪了位置……），可以在上述 JSON 里额外加一个可选字段：
"ambientEvent": { "text": "把飘窗那本书换成了新的一本", "emoji": "📖", "targetItemId": "家具id或省略" }
- text ≤ ${AMBIENT_TEXT_MAX} 字，客观白描一句，不带心理描写（心理归 innerState）。
- 变化要贴合角色此刻的日程/情绪，且是 ta 自己生活的痕迹，与用户无关。
${items ? `- 小屋里现有的家具：${items}。若变化落在某件家具上，填它的 targetItemId；不相关就省略该字段。` : ''}
${lastText ? `- 上一条动态是「${lastText}」，不要重复或雷同。` : ''}
- **绝大多数时候不需要**——没有值得一提的变化就省略整个 ambientEvent 字段，不要硬编。`;
}

/** 解析 eval 结果里的可选 ambientEvent（宽松校验，不合法返回 null，不影响情绪主链路）。 */
export function parseAmbientEvent(
    parsed: any,
    char: CharacterProfile,
): RoomAmbientEvent | null {
    const ev = parsed?.ambientEvent;
    if (!ev || typeof ev.text !== 'string' || !ev.text.trim()) return null;
    const itemIds = new Set((char.roomConfig?.items || []).map(i => i.id));
    const out: RoomAmbientEvent = {
        id: `amb_${Date.now()}_${Math.floor(Math.random() * 1e6)}`,
        text: ev.text.trim().slice(0, AMBIENT_TEXT_MAX),
        timestamp: Date.now(),
    };
    if (typeof ev.emoji === 'string' && ev.emoji.trim()) out.emoji = ev.emoji.trim().slice(0, 4);
    if (typeof ev.targetItemId === 'string' && itemIds.has(ev.targetItemId)) out.targetItemId = ev.targetItemId;
    return out;
}

/** 把一条 ambient 并进 feed（新在前，封顶）。纯函数，落库由调用方（applyEmotionEvalRaw）统一做。 */
export function mergeAmbientIntoFeed(
    char: Pick<CharacterProfile, 'roomAmbientFeed'>,
    ev: RoomAmbientEvent,
): RoomAmbientEvent[] {
    return [ev, ...(char.roomAmbientFeed || [])].slice(0, AMBIENT_FEED_CAP);
}

/**
 * 往角色聊天里落一张轻量 room_card（复用 world_card 的注入模式）。
 * content 文本进上下文 → 角色下轮记得"自己刚干了这件事"→ 顺现有归档管线入记忆。
 */
export async function injectRoomAmbientCard(char: CharacterProfile, ev: RoomAmbientEvent): Promise<void> {
    const itemName = ev.targetItemId
        ? char.roomConfig?.items?.find(i => i.id === ev.targetItemId)?.name
        : undefined;
    await DB.saveMessage({
        charId: char.id,
        role: 'assistant',
        type: 'room_card',
        content: `[小屋动态] ${char.name}${ev.text}`,
        metadata: {
            roomAmbient: true,
            text: ev.text,
            emoji: ev.emoji,
            targetItemId: ev.targetItemId,
            targetItemName: itemName,
        },
    });
}
