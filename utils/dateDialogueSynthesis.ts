import { Capacitor, CapacitorHttp } from '@capacitor/core';
import type { APIConfig } from '../types';
import {
  cleanTextForTtsElevenLabs,
  ELEVENLABS_OUTPUT_FORMAT,
  normalizeElevenLabsVoiceId,
  resolveElevenLabsApiKey,
  resolveElevenLabsModel,
  stripElevenLabsMarkupForDisplay,
} from './elevenLabsTts';
import { getProxyWorkerUrl } from './proxyWorker';
import { isStaticWebDeployment } from './staticWebDeployment';
import {
  buildDateDialogueBatch,
  buildDateForcedAlignmentTranscript,
  resolveDateForcedAlignmentRangesPartial,
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

type ElevenLabsForcedAlignmentCharacter = {
  text?: string;
  start?: number;
  end?: number;
};

type ElevenLabsForcedAlignmentResponse = {
  characters?: ElevenLabsForcedAlignmentCharacter[];
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
  if (Capacitor.isNativePlatform()) {
    return `${getProxyWorkerUrl()}/elevenlabs/forced-alignment`;
  }
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
  const payload = { audio_base64: audioBase64, text };
  const endpoint = forcedAlignmentEndpoint();
  if (Capacitor.isNativePlatform()) {
    const response = await CapacitorHttp.request({
      url: endpoint,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'xi-api-key': apiKey },
      data: payload,
      responseType: 'json',
    });
    let data = response.data as ElevenLabsForcedAlignmentResponse;
    if (typeof response.data === 'string') {
      try { data = JSON.parse(response.data) as ElevenLabsForcedAlignmentResponse; } catch { data = {}; }
    }
    return { status: response.status, data: data || {} };
  }

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'xi-api-key': apiKey },
    body: JSON.stringify(payload),
  });
  let data: ElevenLabsForcedAlignmentResponse = {};
  try { data = await response.json(); } catch { /* handled by status below */ }
  return { status: response.status, data };
};

const toDateSegments = (
  turns: DateDialogueTurn[],
  raw: ElevenLabsDialogueSegment[] | undefined,
  anchors: Array<{ start: number; end: number } | null>,
): DateDialogueSegment[] => {
  if (anchors.length !== turns.length) throw new Error('Forced Alignment 逐句数量与台词不一致');

  // voice_segments 只用于给已经对齐成功的句子补回前后 Audio Tag 演出。
  // 某一句 Forced Alignment 失败时保留一个 unusable 占位，后续只补这一句。
  const byInput = new Map<number, ElevenLabsDialogueSegment>();
  if (Array.isArray(raw)) {
    for (const segment of raw) {
      const index = segment.dialogue_input_index;
      if (!Number.isInteger(index) || index! < 0 || index! >= turns.length) continue;
      if (segment.voice_id && segment.voice_id !== turns[index!].voiceId) continue;
      const previous = byInput.get(index!);
      if (!previous) {
        byInput.set(index!, segment);
        continue;
      }
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
  }

  let lastValidEnd = -1;
  return anchors.map((anchor, index) => {
    const turn = turns[index];
    if (!anchor) {
      return { lineId: turn.lineId, speaker: turn.speaker, startTime: 0, endTime: 0, unusable: true };
    }

    const rough = byInput.get(index);
    let start = anchor.start;
    let end = anchor.end;
    const previousAnchor = anchors.slice(0, index).reverse().find(Boolean) as { start: number; end: number } | undefined;
    const nextAnchor = anchors.slice(index + 1).find(Boolean) as { start: number; end: number } | undefined;
    const previousAnchorEnd = previousAnchor?.end ?? 0;
    const nextAnchorStart = nextAnchor?.start ?? Number.POSITIVE_INFINITY;
    const roughStart = rough?.start_time_seconds;
    const roughEnd = rough?.end_time_seconds;

    if (Number.isFinite(roughStart)
        && roughStart! >= Math.max(previousAnchorEnd - 0.02, anchor.start - 2.5)
        && roughStart! <= anchor.start + 0.02) {
      start = Math.max(0, roughStart!);
    }
    if (Number.isFinite(roughEnd)
        && roughEnd! >= anchor.end - 0.02
        && roughEnd! <= Math.min(nextAnchorStart + 0.02, anchor.end + 2.5)) {
      end = roughEnd!;
    }

    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start
        || (lastValidEnd >= 0 && start < lastValidEnd - 0.02)) {
      return { lineId: turn.lineId, speaker: turn.speaker, startTime: 0, endTime: 0, unusable: true };
    }
    lastValidEnd = end;
    return { lineId: turn.lineId, speaker: turn.speaker, startTime: start, endTime: end };
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

  // Dialogue 自带 timestamps 在长轮次里可能“数值合法但整体漂移”。因此整轮音频生成后，
  // 再用官方 Forced Alignment 对最终音频 + 实际说出口的纯文本重新求一遍时间轴。
  const transcript = buildDateForcedAlignmentTranscript(
    normalized.map(turn => stripElevenLabsMarkupForDisplay(turn.speech)),
  );
  if (!transcript) {
    throw new DateDialogueAlignmentError('见面整轮配音包含无法对齐的纯 Audio Tag 台词，已改为逐句配音');
  }

  const forced = await requestForcedAlignment(apiKey, data.audio_base64, transcript.text);
  if (forced.status < 200 || forced.status >= 300) {
    const detail = forced.data?.detail ?? forced.data?.error ?? '';
    throw new DateDialogueAlignmentError(
      `ElevenLabs Forced Alignment 失败 (HTTP ${forced.status})${detail ? `：${JSON.stringify(detail).slice(0, 240)}` : ''}`,
    );
  }
  const anchors = resolveDateForcedAlignmentRangesPartial(transcript, forced.data.characters);
  if (!anchors || anchors.every(anchor => !anchor)) {
    throw new DateDialogueAlignmentError('ElevenLabs Forced Alignment 无法定位本轮任何一句台词');
  }

  let segments: DateDialogueSegment[];
  try {
    segments = toDateSegments(normalized, data.voice_segments, anchors);
  } catch (error) {
    throw new DateDialogueAlignmentError(error instanceof Error ? error.message : 'ElevenLabs Forced Alignment 时间戳不可用');
  }
  return { audio, url: URL.createObjectURL(audio), segments };
}
