/**
 * ElevenLabs TTS 适配器。
 *
 * 第一阶段沿用 SullyOS 现有的「拿到完整 Blob 后播放 + IndexedDB 缓存」契约，
 * 因而聊天、见面、电话无需引入第二套 PCM 播放器。浏览器走同源 /api 或主代理
 * Worker，Capacitor 原生端直连官方接口；三条路径的请求体完全一致。
 */
import { Capacitor, CapacitorHttp } from '@capacitor/core';
import type { APIConfig, CharacterProfile } from '../types';
import { normalizeApiKey } from './minimaxApiKey';
import { hashTtsParams, getCachedTts, saveCachedTts } from './ttsCache';
import type { TtsResult } from './minimaxTts';
import { normalizeVoiceTags } from './sanitize';
import { getProxyWorkerUrl } from './proxyWorker';
import { isStaticWebDeployment } from './staticWebDeployment';

export const DEFAULT_ELEVENLABS_MODEL = 'eleven_v4';
export const ELEVENLABS_OUTPUT_FORMAT = 'mp3_44100_128';

export const ELEVENLABS_MODEL_OPTIONS = [
  { value: 'eleven_v4', label: 'Eleven v4 —— 最高质量，角色演绎推荐' },
  { value: 'eleven_v4_turbo', label: 'Eleven v4 Turbo —— 低延迟，实时互动推荐' },
] as const;

const ELEVENLABS_V4_MODELS = new Set(['eleven_v4', 'eleven_v4_turbo']);

export const normalizeElevenLabsModel = (raw?: string | null): string => {
  const value = (raw || '').trim();
  return ELEVENLABS_V4_MODELS.has(value) ? value : DEFAULT_ELEVENLABS_MODEL;
};

export const isElevenLabsV4Model = (raw?: string | null): boolean =>
  ELEVENLABS_V4_MODELS.has(normalizeElevenLabsModel(raw));

export const isElevenLabsV4TurboModel = (raw?: string | null): boolean =>
  normalizeElevenLabsModel(raw) === 'eleven_v4_turbo';

/** 仅供兼容旧调用判断；旧 v3 配置在真正请求时会自动迁移到 v4。 */
export const isElevenLabsV3Model = (raw?: string | null): boolean =>
  (raw || '').trim() === 'eleven_v3';

export const ELEVENLABS_V4_VOICE_ACTING_GUIDE = `### ElevenLabs v4 语音表演规则

你写的是马上会被角色亲口说出来的台词，不是小说旁白。句子要口语化、有呼吸、有长短变化；不要写“她轻声说道”之类会被念出来的叙述。

Eleven v4 支持方括号 Audio Tags，而且比 v3 更擅长理解上下文和演绎。只在情绪真正变化的位置少量使用：\`[laughs]\`、\`[chuckles]\`、\`[whispers]\`、\`[sighs]\`、\`[excited]\`、\`[curious]\`、\`[sarcastic]\`、\`[crying]\`、\`[hesitates]\`、\`[softly]\`、\`[pause]\`。标签用半角英文方括号，通常一段 0–2 个；不要每句开头都塞标签，不要自造中文标签。

停顿优先靠逗号、句号、省略号、破折号和自然换行；确实需要明显沉默才用 \`[pause]\`。标签是演出指令，不要在标签外再复述动作。`;

export const getElevenLabsVoiceActingGuide = (_model?: string | null): string =>
  ELEVENLABS_V4_VOICE_ACTING_GUIDE;

const ELEVENLABS_CUE_ALIASES: Record<string, string> = {
  laugh: 'laughs', laughing: 'laughs', laughs: 'laughs', giggle: 'chuckles', giggles: 'chuckles',
  chuckle: 'chuckles', chuckling: 'chuckles', chuckles: 'chuckles',
  whisper: 'whispers', whispering: 'whispers', whispers: 'whispers',
  sigh: 'sighs', sighing: 'sighs', sighs: 'sighs', exhale: 'exhales', exhales: 'exhales',
  excited: 'excited', happy: 'excited', playful: 'mischievously', mischievous: 'mischievously',
  mischievously: 'mischievously', curious: 'curious', sarcastic: 'sarcastic',
  crying: 'crying', sobbing: 'crying', snort: 'snorts', snorts: 'snorts',
  pause: 'pause', 'short pause': 'pause', 'long pause': 'pause', break: 'pause',
  hesitate: 'hesitates', hesitates: 'hesitates', hesitant: 'hesitates',
  softly: 'softly', soft: 'softly', calm: 'softly', breathy: 'softly',
  angry: 'angry', sad: 'sad', nervous: 'nervously', nervously: 'nervously',
};

const normalizeElevenLabsCue = (raw: string): string => {
  const key = (raw || '').trim().toLowerCase().replace(/\s+/g, ' ');
  return ELEVENLABS_CUE_ALIASES[key] || '';
};

/** 支持粘贴纯 ID，也支持从常见 ElevenLabs 页面链接提取 voiceId。 */
export const normalizeElevenLabsVoiceId = (raw?: string | null): string => {
  const value = (raw || '').trim();
  if (!value) return '';
  try {
    const parsed = new URL(value);
    const queryId = parsed.searchParams.get('voiceId') || parsed.searchParams.get('voice_id');
    if (queryId) return queryId.trim();
    const voicePath = parsed.pathname.match(/\/(?:voices?|voice-library)\/([A-Za-z0-9_-]{8,64})(?:\/|$)/i);
    if (voicePath) return voicePath[1];
    return '';
  } catch {
    // 纯 ID 不是 URL，继续走下面的容错提取。
  }
  const embedded = value.match(/(?:voiceId|voice_id)[=/:]([A-Za-z0-9_-]{8,64})/i);
  if (embedded) return embedded[1];
  return value.split(/[?#\s]/)[0];
};

export const resolveElevenLabsApiKey = (apiConfig: APIConfig): string =>
  normalizeApiKey(apiConfig.elevenLabsApiKey || '');

export const resolveElevenLabsModel = (apiConfig: APIConfig): string =>
  normalizeElevenLabsModel(apiConfig.elevenLabsModel);

const extractVoiceBody = (raw: string): string => {
  const normalized = normalizeVoiceTags(raw || '');
  const voiceTag = normalized.match(/<[语語]音[^>]*>([\s\S]*?)<\/\s*[语語]音\s*>/);
  return voiceTag ? voiceTag[1] : normalized;
};

/**
 * ElevenLabs v4 专属文本清洗：保留已知 Audio Tags，隐藏 SullyOS 自己的控制词。
 */
export const cleanTextForTtsElevenLabs = (raw: string, model?: string | null): string => {
  const supportsAudioTags = isElevenLabsV4Model(model);
  let text = extractVoiceBody(raw)
    .replace(/\[\[.*?\]\]/g, '')
    .replace(/%%BILINGUAL%%[\s\S]*/i, '')
    .replace(/<字幕>[\s\S]*?<\/字幕>/g, '')
    .replace(/<#\s*[\d.]+\s*#>/g, '')
    .replace(/（[^）]{0,80}）/g, '')
    .replace(/\(([^)]{1,60})\)/g, (_match, inner: string) => {
      const cue = normalizeElevenLabsCue(inner);
      return supportsAudioTags && cue ? `[${cue}]` : '';
    })
    .replace(/\[([^\[\]]{1,60})\]/g, (_match, inner: string) => {
      const cue = normalizeElevenLabsCue(inner);
      if (!cue) return /[A-Za-z]/.test(inner) || /[\u4e00-\u9fff]/.test(inner) ? '' : _match;
      return supportsAudioTags ? `[${cue}]` : '';
    });

  text = text
    .replace(/\n{2,}/g, supportsAudioTags ? ' [pause] ' : '……')
    .replace(/\n+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\s+([，。！？、；：,.!?…])/g, '$1')
    .trim();
  return text;
};

export const stripElevenLabsMarkupForDisplay = (text?: string | null): string => {
  if (!text) return '';
  return text
    .replace(/<#\s*[\d.]+\s*#>/g, '')
    .replace(/\[([^\[\]]{1,60})\]/g, (match, inner: string) => normalizeElevenLabsCue(inner) ? '' : match)
    .replace(/\(([^)]{1,60})\)/g, (match, inner: string) => normalizeElevenLabsCue(inner) ? '' : match)
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+([，。！？、；：,.!?…])/g, '$1')
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .trim();
};

const clamp = (value: unknown, fallback: number, min: number, max: number): number => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(min, Math.min(max, numeric)) : fallback;
};

const EMOTION_TO_ELEVENLABS_CUE: Record<string, string> = {
  happy: 'excited', sad: 'sad', angry: 'angry', fearful: 'nervously',
  disgusted: 'sarcastic', surprised: 'curious', calm: 'softly', fluent: 'softly',
};

export interface ElevenLabsRequestBody {
  text: string;
  model_id: string;
  language_code?: string;
  voice_settings: {
    stability: number;
    similarity_boost: number;
  };
}

export const buildElevenLabsRequestBody = (
  text: string,
  _char: CharacterProfile,
  apiConfig: APIConfig,
  options?: { languageBoost?: string; emotion?: string },
): ElevenLabsRequestBody => {
  const model = resolveElevenLabsModel(apiConfig);
  const languageCode = (options?.languageBoost || '').trim().toLowerCase();
  let spoken = cleanTextForTtsElevenLabs(text, model);
  const emotionCue = options?.emotion ? EMOTION_TO_ELEVENLABS_CUE[options.emotion.toLowerCase()] : '';
  if (emotionCue && !/\[[^\]]+\]/.test(spoken)) {
    spoken = `[${emotionCue}] ${spoken}`;
  }
  return {
    text: spoken,
    model_id: model,
    ...(/^[a-z]{2,3}$/.test(languageCode) ? { language_code: languageCode } : {}),
    voice_settings: {
      stability: clamp(apiConfig.elevenLabsStability, 0.5, 0, 1),
      similarity_boost: clamp(apiConfig.elevenLabsSimilarityBoost, 0.8, 0, 1),
    },
  };
};

const isNative = (): boolean => {
  try { return Capacitor.isNativePlatform(); } catch { return false; }
};

const useStaticWorker = (): boolean => {
  if (typeof window === 'undefined') return false;
  return isStaticWebDeployment(window.location.protocol, window.location.hostname);
};

const base64ToBytes = (base64: string): Uint8Array => {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
};

const base64ToBlob = (base64: string, mime = 'audio/mpeg'): Blob =>
  new Blob([base64ToBytes(base64)], { type: mime });

const elevenLabsFetchTurboAudio = async (
  voiceId: string,
  apiKey: string,
  payload: ElevenLabsRequestBody,
): Promise<Blob> => {
  if (typeof WebSocket === 'undefined') throw new Error('当前环境不支持 ElevenLabs v4 Turbo WebSocket');

  const params = new URLSearchParams({
    model_id: 'eleven_v4_turbo',
    output_format: ELEVENLABS_OUTPUT_FORMAT,
  });
  if (payload.language_code) params.set('language_code', payload.language_code);

  return await new Promise<Blob>((resolve, reject) => {
    const ws = new WebSocket(`wss://api.elevenlabs.io/v1/text-to-dialogue/stream-input?${params.toString()}`);
    const chunks: Uint8Array[] = [];
    let settled = false;
    const timeoutId = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { ws.close(); } catch { /* ignore */ }
      reject(new Error('ElevenLabs v4 Turbo 合成超时'));
    }, 45_000);

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      try { ws.close(); } catch { /* ignore */ }
      if (error) return reject(error);
      const blob = new Blob(chunks, { type: 'audio/mpeg' });
      if (!blob.size) return reject(new Error('ElevenLabs v4 Turbo 返回了空音频'));
      resolve(blob);
    };

    ws.onopen = () => {
      ws.send(JSON.stringify({
        voices: [voiceId],
        xi_api_key: apiKey,
        voice_settings: payload.voice_settings,
      }));
      ws.send(JSON.stringify({
        inputs: [{ text: payload.text, voice_id: voiceId, new_turn: true }],
      }));
      ws.send(JSON.stringify({ close_socket: true }));
    };

    ws.onmessage = (event) => {
      let message: any;
      try { message = JSON.parse(String(event.data || '')); } catch { return; }
      if (message?.error) {
        const detail = typeof message.error === 'string' ? message.error : JSON.stringify(message.error);
        finish(new Error(`ElevenLabs v4 Turbo 合成失败：${detail.slice(0, 240)}`));
        return;
      }
      if (typeof message?.audio === 'string' && message.audio) chunks.push(base64ToBytes(message.audio));
      if (message?.is_final === true) finish();
    };

    ws.onerror = () => finish(new Error('ElevenLabs v4 Turbo WebSocket 连接失败'));
    ws.onclose = () => {
      if (!settled) {
        if (chunks.length) finish();
        else finish(new Error('ElevenLabs v4 Turbo 连接已关闭，但没有返回音频'));
      }
    };
  });
};

const friendlyElevenLabsError = (status: number, detail: string): string => {
  const normalized = detail.toLowerCase();
  if (status === 401 || normalized.includes('invalid api key')) return 'ElevenLabs API Key 无效或已过期';
  if (status === 402 || normalized.includes('quota') || normalized.includes('credits')) return 'ElevenLabs 额度不足';
  if (status === 403) return 'ElevenLabs 拒绝访问，请检查 Key 权限或 IP 限制';
  if (status === 404) return 'ElevenLabs Voice ID 或模型不存在';
  if (status === 429) return 'ElevenLabs 请求过于频繁，请稍后再试';
  return `ElevenLabs TTS 失败 (HTTP ${status})${detail ? `：${detail.slice(0, 240)}` : ''}`;
};

const elevenLabsFetchAudio = async (
  voiceId: string,
  apiKey: string,
  payload: ElevenLabsRequestBody,
): Promise<Blob> => {
  if (isElevenLabsV4TurboModel(payload.model_id)) {
    return elevenLabsFetchTurboAudio(voiceId, apiKey, payload);
  }
  const query = `voice_id=${encodeURIComponent(voiceId)}&output_format=${encodeURIComponent(ELEVENLABS_OUTPUT_FORMAT)}`;
  if (isNative()) {
    const response = await CapacitorHttp.request({
      url: `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}/stream?output_format=${encodeURIComponent(ELEVENLABS_OUTPUT_FORMAT)}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'xi-api-key': apiKey },
      data: payload,
      responseType: 'blob',
    });
    if (response.status < 200 || response.status >= 300) {
      throw new Error(friendlyElevenLabsError(response.status, String(response.data || '')));
    }
    const blob = base64ToBlob(String(response.data || ''));
    if (!blob.size) throw new Error('ElevenLabs 返回了空音频');
    return blob;
  }

  const url = useStaticWorker()
    ? `${getProxyWorkerUrl()}/elevenlabs/tts?${query}`
    : `/api/elevenlabs/tts?${query}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'xi-api-key': apiKey },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    let detail = '';
    try { detail = await response.text(); } catch { /* ignore */ }
    throw new Error(friendlyElevenLabsError(response.status, detail));
  }
  const blob = await response.blob();
  if (!blob.size) throw new Error('ElevenLabs 返回了空音频');
  return blob;
};

export async function synthesizeSpeechElevenLabsDetailed(
  text: string,
  char: CharacterProfile,
  apiConfig: APIConfig,
  options?: { languageBoost?: string; groupId?: string; emotion?: string },
): Promise<TtsResult> {
  const apiKey = resolveElevenLabsApiKey(apiConfig);
  if (!apiKey) throw new Error('缺少 ElevenLabs API Key');
  const voiceId = normalizeElevenLabsVoiceId(char.voiceProfile?.elevenLabsVoiceId);
  if (!voiceId) throw new Error('角色未配置 ElevenLabs Voice ID');

  const payload = buildElevenLabsRequestBody(text, char, apiConfig, options);
  if (!payload.text) throw new Error('ElevenLabs TTS 文本为空');

  const cacheKey = hashTtsParams({
    kind: 'elevenlabs-tts',
    voice_id: voiceId,
    output_format: ELEVENLABS_OUTPUT_FORMAT,
    ...payload,
  });
  const cached = await getCachedTts(cacheKey);
  if (cached) return { url: URL.createObjectURL(cached), blob: cached };

  console.log('[elevenlabs] TTS', {
    model: payload.model_id,
    voice_id_suffix: voiceId.slice(-4),
    text_length: payload.text.length,
    language_code: payload.language_code || 'auto',
  });
  const blob = await elevenLabsFetchAudio(voiceId, apiKey, payload);
  saveCachedTts(cacheKey, blob).catch(() => { /* cache failure must not block playback */ });
  return { url: URL.createObjectURL(blob), blob };
}

export async function synthesizeSpeechElevenLabs(
  text: string,
  char: CharacterProfile,
  apiConfig: APIConfig,
  options?: { languageBoost?: string; groupId?: string; emotion?: string },
): Promise<string> {
  const { url } = await synthesizeSpeechElevenLabsDetailed(text, char, apiConfig, options);
  return url;
}
