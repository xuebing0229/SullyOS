import { Capacitor, CapacitorHttp } from '@capacitor/core';
import type { APIConfig } from '../types';
import {
  cleanTextForTtsElevenLabs,
  stripElevenLabsMarkupForDisplay,
  ELEVENLABS_OUTPUT_FORMAT,
  normalizeElevenLabsVoiceId,
  resolveElevenLabsApiKey,
  resolveElevenLabsModel,
} from './elevenLabsTts';
import { getProxyWorkerUrl } from './proxyWorker';
import { isStaticWebDeployment } from './staticWebDeployment';
import {
  alignDateDialogueSegments,
  buildDateDialogueAlignmentTranscript,
  buildDateDialogueBatch,
  resolveDateDialogueForcedAlignmentRanges,
  stabilizeDateDialogueForcedRanges,
  type DateDialogueSegment,
  type DateDialogueTurn,
} from './dateDialogueVoice';

type ElevenLabsDialogueSegment = {
  voice_id?: string;
  start_time_seconds?: number;
  end_time_seconds?: number;
  dialogue_input_index?: number;
  character_start_index?: number;
  character_end_index?: number;
};

type ElevenLabsDialogueResponse = {
  audio_base64?: string;
  voice_segments?: ElevenLabsDialogueSegment[];
  detail?: unknown;
  error?: unknown;
};

type ElevenLabsForcedAlignmentResponse = {
  characters?: Array<{ text?: string; start?: number; end?: number }>;
  words?: Array<{ text?: string; start?: number; end?: number; loss?: number }>;
  loss?: number;
  detail?: unknown;
  error?: unknown;
};


/** 时间戳不可用时，标记整轮调用无需再试，以免每句都重复计费生成整轮音频。 */
export class DateDialogueAlignmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DateDialogueAlignmentError';
  }
}

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

const forcedAlignmentEndpoint = (): string => {
  if (typeof window !== 'undefined' && isStaticWebDeployment(window.location.protocol, window.location.hostname)) {
    return `${getProxyWorkerUrl()}/elevenlabs/forced-alignment`;
  }
  return '/api/elevenlabs/forced-alignment';
};

const requestForcedAlignment = async (
  apiKey: string,
  audioBase64: string,
  text: string,
): Promise<{ status: number; data: ElevenLabsForcedAlignmentResponse }> => {
  if (Capacitor.isNativePlatform()) {
    // Capacitor 6 的 Android HTTP 原生支持序列化 formData。手机直接请求 ElevenLabs，
    // 不依赖作者公共 Worker 是否已经同步新路由。
    const boundary = '----SullyOSForcedAlignmentBoundary';
    const response = await CapacitorHttp.request({
      url: 'https://api.elevenlabs.io/v1/forced-alignment',
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'xi-api-key': apiKey,
        Accept: 'application/json',
      },
      data: [
        {
          key: 'file',
          value: audioBase64,
          type: 'base64File',
          contentType: 'audio/mpeg',
          fileName: 'dialogue.mp3',
        },
        { key: 'text', value: text, type: 'string' },
      ],
      dataType: 'formData',
      responseType: 'json',
    } as any);
    return { status: response.status, data: (response.data || {}) as ElevenLabsForcedAlignmentResponse };
  }

  const body = { audio_base64: audioBase64, mime_type: 'audio/mpeg', text };
  const response = await fetch(forcedAlignmentEndpoint(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'xi-api-key': apiKey },
    body: JSON.stringify(body),
  });
  let data: ElevenLabsForcedAlignmentResponse = {};
  try { data = await response.json(); } catch { /* handled below */ }
  return { status: response.status, data };
};

const collectDialogueInputRanges = (
  turns: DateDialogueTurn[],
  raw: ElevenLabsDialogueSegment[] | undefined,
): Array<{ start?: number; end?: number }> => {
  if (!Array.isArray(raw) || !raw.length) throw new Error('ElevenLabs Dialogue 未返回逐句分段');

  const byInput = new Map<number, ElevenLabsDialogueSegment>();
  for (const segment of raw) {
    const index = segment.dialogue_input_index;
    if (!Number.isInteger(index) || index! < 0 || index! >= turns.length) continue;
    if (segment.voice_id !== turns[index!].voiceId) {
      throw new Error(`ElevenLabs Dialogue 第 ${index! + 1} 句的声线 ID 缺失或与请求不一致`);
    }
    const previous = byInput.get(index!);
    if (!previous) {
      byInput.set(index!, segment);
      continue;
    }
    const previousStart = Number(previous.start_time_seconds);
    const currentStart = Number(segment.start_time_seconds);
    const previousEnd = Number(previous.end_time_seconds);
    const currentEnd = Number(segment.end_time_seconds);
    byInput.set(index!, {
      ...previous,
      start_time_seconds: Number.isFinite(previousStart) && Number.isFinite(currentStart)
        ? Math.min(previousStart, currentStart)
        : (Number.isFinite(previousStart) ? previousStart : currentStart),
      end_time_seconds: Number.isFinite(previousEnd) && Number.isFinite(currentEnd)
        ? Math.max(previousEnd, currentEnd)
        : (Number.isFinite(previousEnd) ? previousEnd : currentEnd),
    });
  }

  return turns.map((_turn, index) => {
    const segment = byInput.get(index);
    if (!segment) throw new Error(`ElevenLabs Dialogue 第 ${index + 1} 句缺少 voice segment`);
    const start = Number(segment.start_time_seconds);
    const end = Number(segment.end_time_seconds);
    return {
      ...(Number.isFinite(start) ? { start } : {}),
      ...(Number.isFinite(end) ? { end } : {}),
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

  let coarseRanges: Array<{ start?: number; end?: number }>;
  try {
    coarseRanges = collectDialogueInputRanges(normalized, data.voice_segments);
  } catch (error) {
    throw new DateDialogueAlignmentError(error instanceof Error ? error.message : 'ElevenLabs Dialogue 分段不可用');
  }

  const transcript = buildDateDialogueAlignmentTranscript(
    normalized.map(turn => stripElevenLabsMarkupForDisplay(turn.speech)),
  );
  if (!transcript) {
    throw new DateDialogueAlignmentError('见面对白无法生成 Forced Alignment 文本，已回退逐句配音');
  }

  const forced = await requestForcedAlignment(apiKey, data.audio_base64, transcript.text);
  if (forced.status < 200 || forced.status >= 300) {
    const detail = forced.data?.detail ?? forced.data?.error ?? '';
    throw new DateDialogueAlignmentError(
      `ElevenLabs Forced Alignment 失败 (HTTP ${forced.status})${detail ? `：${JSON.stringify(detail).slice(0, 240)}` : ''}`,
    );
  }

  const anchors = resolveDateDialogueForcedAlignmentRanges(transcript, forced.data.characters);
  if (!anchors) {
    throw new DateDialogueAlignmentError('ElevenLabs Forced Alignment 字符结果与本轮对白不一致，已回退逐句配音');
  }
  const stabilized = stabilizeDateDialogueForcedRanges(anchors, coarseRanges);
  if (!stabilized) {
    throw new DateDialogueAlignmentError('ElevenLabs Forced Alignment 句间边界无效，已回退逐句配音');
  }

  let segments: DateDialogueSegment[];
  try {
    segments = alignDateDialogueSegments(normalized, stabilized);
  } catch (error) {
    throw new DateDialogueAlignmentError(error instanceof Error ? error.message : 'Forced Alignment 时间戳不可用');
  }
  return { audio, url: URL.createObjectURL(audio), segments };
}
