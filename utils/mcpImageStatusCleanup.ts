import type { Message } from '../types';
import { DB } from './db';

/**
 * 旧版 single-shot 生图流程会把纯状态说明当成角色回复写入聊天。
 * 这些文本既不是角色内容，也不是图片本身；新版仅保留顶部轻提示和最终图片。
 */
export const LEGACY_MCP_IMAGE_STATUS_TEXTS = new Set([
    '图片已经开始在后台生成，完成后会自动出现在聊天和相册里。',
    '图片已经开始生成，完成后会自动出现在聊天里。',
    '图片已经生成，并保存到聊天和相册里了。',
    '后台任务已接收，图片完成后会自动出现在聊天和相册中。',
]);

const normalize = (value: unknown): string =>
    String(value ?? '').replace(/\s+/g, ' ').trim();

export const isLegacyMcpImageStatusMessage = (
    message: Pick<Message, 'role' | 'type' | 'content'>,
): boolean =>
    message.role === 'assistant'
    && message.type === 'text'
    && LEGACY_MCP_IMAGE_STATUS_TEXTS.has(normalize(message.content));

/**
 * 精确删除当前角色旧版遗留的“图片正在/已经生成”占位回复。
 * 只匹配 assistant + text + 白名单全文，不碰角色真实聊天、图片、失败提示或相册数据。
 */
export async function cleanupLegacyMcpImageStatusMessages(
    charId: string,
): Promise<number> {
    if (!charId) return 0;

    const messages = await DB.getMessagesByCharId(charId, true);
    const ids = messages
        .filter(isLegacyMcpImageStatusMessage)
        .map(message => message.id)
        .filter((id): id is number => Number.isFinite(id));

    if (!ids.length) return 0;
    await DB.deleteMessages(ids);
    return ids.length;
}
