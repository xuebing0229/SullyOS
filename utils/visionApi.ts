import type { ApiPreset, Message, VisionApiConfig } from '../types';
import { DB } from './db';
import { extractContent, safeFetchJson } from './safeApi';
import { normalizeApiBaseUrl, normalizeApiCredential, normalizeApiModel } from './apiConfigNormalize';
import { isBlobRef } from './blobRef';

export const VISION_DESCRIPTION_METADATA_KEY = 'visionDescription';

/** 设置页测试识图能力时发送的 48×48 白底紫色圆点 PNG。 */
export const VISION_API_TEST_IMAGE_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAYAAABXAvmHAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAADKSURBVGhD7Y+5DQMxDASvLtfmll2DDQYHHDYwfxGCdoBJFGg513dzLnzYDQZMw4BpGDANA568Xx+zVZQE4HEes6QC8JiMUcIBeECFEUIBOFypF3cADnbowRWAQ51aOScAB1Zo4YwA/HilGgzoVoMB3WqoAfjhajXUAAE/XakGA7rVYEC3GqYAAT9eoYVzAgQc6NTKWQECDnXowR0g4GClXkIBAg5XGCEcIOABGaOkAm7wGI9ZSgJu8Lh/VlEaMAEDpmHANAyYZvuAH2hIrK7auxVfAAAAAElFTkSuQmCC';

const VISION_PROMPT = `请准确、具体地描述图片中实际可见的内容，供另一个无法看图的对话模型理解。
请覆盖主体、动作、场景、重要物品、画面中的文字或界面信息；不要猜测画面外的信息，不要寒暄，只输出描述正文。`;

/**
 * 这个值还能拿去识图吗。三种形态都算数：内嵌的 data URL、网络地址，以及本机存的
 * 图片令牌（`blobref:`，二进制在 blob_assets 里，见 utils/blobRef.ts）——令牌发出去
 * 之前会由网络出口统一还原成 data URL（utils/apiBlobRefs.ts），这里只负责别把它
 * 误判成「图没了」。
 *
 * 判漏的后果是静默的：图明明在，识图这步却直接跳过或报「图片数据不可用」，
 * 界面上一点征兆都没有。
 */
const canDescribeImage = (value: unknown): value is string =>
  typeof value === 'string' && (/^(data:image\/|https?:\/\/)/i.test(value) || isBlobRef(value));

const inFlightDescriptions = new Map<string, Promise<string>>();
const VISION_REQUEST_TIMEOUT_MS = 12_000;
const VISION_FAILURE_COOLDOWN_MS = 3 * 60_000;
let visionFailureCooldownUntil = 0;

/** 把一份通用模型预设填入独立识图配置，不改变主 API 当前选择。 */
export const visionApiConfigFromPreset = (preset: ApiPreset, enabled = true): VisionApiConfig => ({
  enabled,
  baseUrl: normalizeApiBaseUrl(preset.config.baseUrl),
  apiKey: normalizeApiCredential(preset.config.apiKey),
  model: normalizeApiModel(preset.config.model),
});

export const isVisionApiReady = (config?: VisionApiConfig | null): config is VisionApiConfig =>
  config?.enabled === true
  && !!config.baseUrl?.trim()
  && !!config.apiKey?.trim()
  && !!config.model?.trim();

export const readVisionDescription = (message: Message): string => {
  const value = message.metadata?.[VISION_DESCRIPTION_METADATA_KEY];
  return typeof value === 'string' ? value.trim() : '';
};

const cleanDescription = (value: string): string => value
  .replace(/^\s*\[?图片\s*[：:]\s*/i, '')
  .replace(/\]\s*$/i, '')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, 4000);

/** 调用 OpenAI 兼容视觉端点，把一张图片变成可交给纯文本模型的描述。 */
export async function describeImageWithVisionApi(
  imageUrl: string,
  config: VisionApiConfig,
): Promise<string> {
  if (!isVisionApiReady(config)) {
    throw new Error('识图 API 已开启，但 URL、Key 或 Model 尚未填写完整');
  }
  if (!canDescribeImage(imageUrl)) {
    throw new Error('图片数据不可用，无法调用识图 API');
  }

  const existing = inFlightDescriptions.get(imageUrl);
  if (existing) return existing;

  const request = (async () => {
    const baseUrl = config.baseUrl.trim().replace(/\/+$/, '');
    const data = await safeFetchJson(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey.trim()}`,
      },
      body: JSON.stringify({
        model: config.model.trim(),
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: VISION_PROMPT },
            { type: 'image_url', image_url: { url: imageUrl } },
          ],
        }],
        temperature: 0,
        max_tokens: 1200,
        stream: false,
      }),
    }, 1, VISION_REQUEST_TIMEOUT_MS, { appName: '消息', purpose: '识图' });

    const description = cleanDescription(extractContent(data));
    if (!description) throw new Error('识图 API 没有返回图片描述');
    return description;
  })();

  inFlightDescriptions.set(imageUrl, request);
  try {
    return await request;
  } finally {
    inFlightDescriptions.delete(imageUrl);
  }
}

/**
 * 为聊天历史里的图片补齐识图描述。
 *
 * 描述写回消息 metadata，因此同一条图片消息后续聊天、重 roll、主动消息都只识别一次；
 * 同一批里内容完全相同的图片也会复用第一次结果。
 */
export async function materializeVisionDescriptions(
  messages: Message[],
  config?: VisionApiConfig | null,
): Promise<Message[]> {
  if (config?.enabled !== true) return messages;
  if (!isVisionApiReady(config)) {
    throw new Error('识图 API 已开启，但 URL、Key 或 Model 尚未填写完整');
  }

  // 只让“这一轮刚发来的图片”阻塞主聊天：从最后一条 assistant 之后开始算当前用户轮。
  // 旧历史如果尚未缓存描述，只给本轮主模型一个纯文字占位，不在这里补扫历史债。
  // 否则用户刚开启识图时，几十张旧图会一张张排队识别，主 API 明明 8 秒却要等几分钟。
  let lastAssistantIndex = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === 'assistant') {
      lastAssistantIndex = i;
      break;
    }
  }
  const currentTurnImageIds = new Set(
    messages
      .slice(lastAssistantIndex + 1)
      .filter(message => message.role === 'user' && message.type === 'image')
      .map(message => message.id),
  );

  const cachedByImage = new Map<string, string>();
  for (const message of messages) {
    if (message.type !== 'image') continue;
    const cached = readVisionDescription(message);
    if (cached && typeof message.content === 'string') cachedByImage.set(message.content, cached);
  }

  const recognitionByImage = new Map<string, Promise<string | null>>();
  const coolingDown = Date.now() < visionFailureCooldownUntil;

  // 当前轮若一次发了多张图，并发识别，延迟取最慢那张，而不是 N 张耗时相加。
  if (!coolingDown) {
    for (const message of messages) {
      if (!currentTurnImageIds.has(message.id)) continue;
      const imageUrl = typeof message.content === 'string' ? message.content : '';
      if (!canDescribeImage(imageUrl) || cachedByImage.has(imageUrl) || recognitionByImage.has(imageUrl)) continue;
      recognitionByImage.set(
        imageUrl,
        describeImageWithVisionApi(imageUrl, config).catch(error => {
          visionFailureCooldownUntil = Date.now() + VISION_FAILURE_COOLDOWN_MS;
          console.warn('[VisionAPI] 识图失败，进入 3 分钟冷却；本轮降级为文字占位，主聊天继续', error);
          return null;
        }),
      );
    }
  }

  const recognizedByImage = new Map<string, string | null>();
  await Promise.all(
    [...recognitionByImage.entries()].map(async ([imageUrl, promise]) => {
      recognizedByImage.set(imageUrl, await promise);
    }),
  );

  const prepared: Message[] = [];
  for (const message of messages) {
    if (message.type !== 'image') {
      prepared.push(message);
      continue;
    }

    const cached = readVisionDescription(message);
    if (cached) {
      prepared.push(message);
      continue;
    }

    // 生成图当前仍由 chatPrompts 的 mcpGeneratedImage 专用分支提供“生成引擎/提示词摘要”。
    // 那条分支不会消费 visionDescription，因此这里不要白白花一次识图费。
    if (message.role === 'assistant' && message.metadata?.mcpGeneratedImage) {
      prepared.push(message);
      continue;
    }

    const imageUrl = typeof message.content === 'string' ? message.content : '';
    if (!canDescribeImage(imageUrl)) {
      prepared.push(message);
      continue;
    }

    const reused = cachedByImage.get(imageUrl);
    const recognized = reused ?? recognizedByImage.get(imageUrl);

    if (typeof recognized === 'string' && recognized.trim()) {
      const metadata = {
        ...(message.metadata || {}),
        [VISION_DESCRIPTION_METADATA_KEY]: recognized,
        visionRecognizedAt: Date.now(),
        visionModel: config.model.trim(),
      };
      // 成功才落库；下一轮与刷新页面后直接命中，不重复扣识图额度。
      await DB.updateMessageMetadata(message.id, prev => ({ ...(prev || {}), ...metadata }));
      prepared.push({ ...message, metadata });
      continue;
    }

    const isCurrentTurn = currentTurnImageIds.has(message.id);
    prepared.push({
      ...message,
      metadata: {
        ...(message.metadata || {}),
        [VISION_DESCRIPTION_METADATA_KEY]: isCurrentTurn
          ? '图片识别暂时失败，本轮无法读取图片内容。'
          : '此前图片尚未识别，本轮先不读取图片内容。',
        ...(isCurrentTurn
          ? { visionRecognitionTransientFailure: true }
          : { visionRecognitionDeferred: true }),
      },
    });
  }

  return prepared;
}
