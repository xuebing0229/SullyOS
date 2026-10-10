import { Capacitor, CapacitorHttp } from '@capacitor/core';
import type { APIConfig } from '../types';
import {
  cleanTextForTtsElevenLabs,
  ELEVENLABS_OUTPUT_FORMAT,
  normalizeElevenLabsVoiceId,
  resolveElevenLabsApiKey,
  resolveElevenLabsModel,
} from './elevenLabsTts';
import { getProxyWorkerUrl } from './proxyWorker';
import { isStaticWebDeployment } from './staticWebDeployment';
import {
  buildDateDialogueBatch,
  type DateDialogueSegment,
  type DateDialogueTurn,
} from './dateDialogueVoice';

type ElevenLabsDialogueSegment = {
  voice_id?: string;
  start_time_seconds?: number;
  end_time_seconds?: number;
  dialogue_input_index?: number;
};

type ElevenLabsDialogueResponse = {
  audio_base64?: string;
  voice_segments?: ElevenLabsDialogueSegment[];
  detail?: unknown;
  error?: unknown;
};


const clamp01 = (value: unknown, fallback: number): number => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(0, Math.min(1, numeric)) : fallback;
};

const base64ToBlob = (base64: string, mime = 'audio/mpeg'): Blob => {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
};

const dialogueEndpoint = (): string => {
  const query = `output_format=${encodeURIComponent(ELEVENLABS_OUTPUT_FORMAT)}`;
  if (typeof window !== 'undefined' && isStaticWebDeployment(window.location.protocol, window.location.hostname)) {
    return `${getProxyWorkerUrl()}/elevenlabs/dialogue?${query}`;
  }
  return `/api/elevenlabs/dialogue?${query}`;
};

const requestDialogue = async (
  apiKey: string,
  body: Record<string, unknown>,
): Promise<{ status: number; data: ElevenLabsDialogueResponse }> => {
  const upstream = `https://api.elevenlabs.io/v1/text-to-dialogue/with-timestamps?output_format=${encodeURIComponent(ELEVENLABS_OUTPUT_FORMAT)}`;
  if (Capacitor.isNativePlatform()) {
    const response = await CapacitorHttp.request({
      url: upstream,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'xi-api-key': apiKey },
      data: body,
      responseType: 'json',
    });
    return { status: response.status, data: (response.data || {}) as ElevenLabsDialogueResponse };
  }

  const response = await fetch(dialogueEndpoint(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'xi-api-key': apiKey },
    body: JSON.stringify(body),
  });
  let data: ElevenLabsDialogueResponse = {};
  try { data = await response.json(); } catch { /* handled by status/error below */ }
  return { status: response.status, data };
};

const toDateSegments = (
  turns: DateDialogueTurn[],
  raw: ElevenLabsDialogueSegment[] | undefined,
): DateDialogueSegment[] => {
  if (!Array.isArray(raw) || !raw.length) throw new Error('ElevenLabs Dialogue 未返回逐句时间戳');

  const byInput = new Map<number, ElevenLabsDialogueSegment>();
  for (const segment of raw) {
    const index = segment.dialogue_input_index;
    if (!Number.isInteger(index) || index! < 0 || index! >= turns.length) continue;
    const previous = byInput.get(index!);
    if (!previous) {
      byInput.set(index!, segment);
      continue;
    }
    // 某些返回会把同一 input 拆成多个 voice segment；合并首尾而不是丢掉尾音。
    byInput.set(index!, {
      ...previous,
      start_time_seconds: Math.min(
        previous.start_time_seconds ?? Number.POSITIVE_INFINITY,
        segment.start_time_seconds ?? Number.POSITIVE_INFINITY,
      ),
      end_time_seconds: Math.max(
        previous.end_time_seconds ?? Number.NEGATIVE_INFINITY,
        segment.end_time_seconds ?? Number.NEGATIVE_INFINITY,
      ),
    });
  }

  return turns.map((turn, index) => {
    const segment = byInput.get(index);
    const startTime = segment?.start_time_seconds;
    const endTime = segment?.end_time_seconds;
    if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || endTime! <= startTime!) {
      throw new Error(`ElevenLabs Dialogue 第 ${index + 1} 句缺少有效时间戳`);
    }
    return {
      lineId: turn.lineId,
      speaker: turn.speaker,
      startTime: startTime!,
      endTime: endTime!,
    };
  });
};

/**
 * 见面模式专用的整轮双 OC 配音。
 * - 直接使用剧情模型写出的 Audio Tags，不经过第二个「语音导演」LLM。
 * - 一轮所有 char/user 台词按原顺序一次性送 Text-to-Dialogue。
 * - 使用官方 voice_segments.dialogue_input_index 做逐句对齐，不靠停顿/文本搜索猜切点。
 */
export async function synthesizeDateDialogue(
  turns: DateDialogueTurn[],
  config: APIConfig,
): Promise<{ audio: Blob; url: string; segments: DateDialogueSegment[] }> {
  const apiKey = resolveElevenLabsApiKey(config);
  if (!apiKey) throw new Error('缺少 ElevenLabs API Key');

  const model = resolveElevenLabsModel(config);
  // v4 Turbo 官方定位是 Dialogue WebSocket；当前逐句回放依赖 REST timestamps。
  if (model === 'eleven_v4_turbo') {
    throw new Error('Eleven v4 Turbo 暂不走整轮时间戳配音，已回退逐句合成');
  }

  const normalized = turns.map(turn => ({
    ...turn,
    voiceId: normalizeElevenLabsVoiceId(turn.voiceId),
    speech: cleanTextForTtsElevenLabs(turn.speech, model),
  }));
  if (!normalized.length || normalized.some(turn => !turn.voiceId || !turn.speech)) {
    throw new Error('双人配音需要有效 Voice ID 与非空台词');
  }

  const batch = buildDateDialogueBatch(normalized);
  const charCount = batch.inputs.reduce((sum, input) => sum + input.text.length, 0);
  if (charCount > 2000) {
    // 官方建议 Text-to-Dialogue 单请求控制在 2000 字符以内；不偷偷拆批破坏上下文。
    throw new Error('本轮对白超过 ElevenLabs Dialogue 建议上限，已回退逐句合成');
  }

  const { status, data } = await requestDialogue(apiKey, {
    model_id: model,
    inputs: batch.inputs,
    settings: {
      stability: clamp01(config.elevenLabsStability, 0.5),
      similarity_boost: clamp01(config.elevenLabsSimilarityBoost, 0.8),
    },
  });
  if (status < 200 || status >= 300) {
    const detail = data?.detail ?? data?.error ?? '';
    throw new Error(`ElevenLabs Dialogue 请求失败 (HTTP ${status})${detail ? `：${JSON.stringify(detail).slice(0, 240)}` : ''}`);
  }

  if (typeof data.audio_base64 !== 'string' || !data.audio_base64) {
    throw new Error('ElevenLabs Dialogue 未返回音频');
  }
  const audio = base64ToBlob(data.audio_base64);
  if (!audio.size) throw new Error('ElevenLabs Dialogue 返回了空音频');
  const segments = toDateSegments(normalized, data.voice_segments);
  return { audio, url: URL.createObjectURL(audio), segments };
}
