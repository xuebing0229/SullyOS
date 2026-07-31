import { Capacitor, CapacitorHttp } from '@capacitor/core';
import type { APIConfig, CharacterProfile } from '../types';
import type { TtsResult } from './minimaxTts';
import { hashTtsParams, getCachedTts, saveCachedTts } from './ttsCache';
import { getProxyWorkerUrl } from './proxyWorker';

export const ELEVENLABS_VOICE_ACTING_GUIDE = `### ElevenLabs 语音表演规则
你正在写一段会被真实朗读的对白，不是在写书面文章。句子要像人嘴里自然说出来，有长短变化、犹豫、换气和情绪转折。
当前使用 Eleven v3 时，可以在情绪真正发生的位置加入少量半角英文方括号音频标签，例如：[sad] [angry] [happily] [whispers] [shouts] [laughs] [clears throat] [sighs]
规则：标签贴着情绪发生的位置；小短句不必硬塞；一处通常只放一个；不使用 MiniMax 的 <#0.5#>；不写中文舞台说明；用标点控制自然停顿；内容必须口语化。`;

export const ELEVENLABS_V2_VOICE_ACTING_GUIDE = `### ElevenLabs 语音表演规则
你正在写一段会被真实朗读的自然对白。不要加入方括号音频标签，也不要使用 MiniMax 的 <#秒#> 标记。用口语化措辞、短句、标点、省略号和破折号表达停顿与情绪，避免客服腔、播报腔和长书面句。`;

const MODELS = new Set(['eleven_v3', 'eleven_multilingual_v2', 'eleven_flash_v2_5']);
const EMOTION_TAG: Record<string, string> = {
  happy: '[happily]', sad: '[sad]', angry: '[angry]', fearful: '[nervous]',
  disgusted: '[disgusted]', surprised: '[surprised]', calm: '[calmly]', fluent: '',
};
const clamp = (v: unknown, min: number, max: number, fallback: number) =>
  typeof v === 'number' && Number.isFinite(v) ? Math.max(min, Math.min(max, v)) : fallback;

export function prepareElevenText(raw: string, modelId: string, emotion?: string): string {
  let text = String(raw || '').replace(/<#\s*[\d.]+\s*#>/g, '').replace(/\s+/g, ' ').trim();
  if (modelId !== 'eleven_v3') {
    return text.replace(/\[[^\[\]\n<>]{1,50}\]/g, '').replace(/\s+/g, ' ').trim();
  }
  text = text.replace(/\[([^\[\]]{1,100})\]/g, (whole, inner: string) =>
    /https?:|[<>\r\n\x00-\x1f]/i.test(inner) || inner.length > 50 ? '' : whole);
  const limit = Math.max(6, Math.ceil(text.length / 100) * 6);
  let seen = 0;
  text = text.replace(/\[[^\[\]]{1,50}\]/g, tag => ++seen <= limit ? tag : '').replace(/\s+/g, ' ').trim();
  const tag = emotion ? EMOTION_TAG[emotion.toLowerCase()] : '';
  return !/\[[^\[\]]{1,50}\]/.test(text) && tag ? `${tag} ${text}` : text;
}

const base64ToBlob = (b64: string, mime = 'audio/mpeg'): Blob => {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
};

function readError(status: number, raw: string): string {
  let detail = raw.slice(0, 300);
  try {
    const data = JSON.parse(raw);
    detail = data?.detail?.message || data?.detail || data?.message || detail;
  } catch { /* text response */ }
  if (status === 401 || status === 403) return 'ElevenLabs API Key 无效或权限不足';
  if (status === 422) return `ElevenLabs Voice ID、模型或请求参数不合法${detail ? `：${detail}` : ''}`;
  if (status === 429) return 'ElevenLabs 额度不足或请求过快';
  if (status >= 500) return 'ElevenLabs 服务暂时异常';
  return detail || `ElevenLabs TTS 失败 (HTTP ${status})`;
}

async function fetchAudio(voiceId: string, apiKey: string, body: any): Promise<Blob> {
  const upstream = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`;
  if (Capacitor.isNativePlatform()) {
    const response = await CapacitorHttp.request({
      url: upstream, method: 'POST',
      headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
      data: body, responseType: 'blob',
    });
    if (response.status < 200 || response.status >= 300) {
      throw new Error(readError(response.status, typeof response.data === 'string' ? response.data : JSON.stringify(response.data || {})));
    }
    const blob = base64ToBlob(String(response.data || ''));
    if (!blob.size) throw new Error('ElevenLabs 返回空音频');
    return blob;
  }
  const response = await fetch(`${getProxyWorkerUrl()}/api/elevenlabs/tts`, {
    method: 'POST',
    headers: { 'X-ElevenLabs-API-Key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      voiceId, modelId: body.model_id, text: body.text,
      outputFormat: 'mp3_44100_128', voiceSettings: body.voice_settings,
    }),
  });
  if (!response.ok) throw new Error(readError(response.status, await response.text()));
  const blob = await response.blob();
  if (!blob.size) throw new Error('ElevenLabs 返回空音频');
  return blob;
}

export async function synthesizeSpeechElevenLabsDetailed(
  text: string,
  char: CharacterProfile,
  apiConfig: APIConfig,
  options?: { languageBoost?: string; groupId?: string; emotion?: string },
): Promise<TtsResult> {
  const apiKey = apiConfig.elevenLabsApiKey?.trim();
  if (!apiKey) throw new Error('缺少 ElevenLabs API Key');
  const vp = char.voiceProfile;
  const voiceId = vp?.elevenLabsVoiceId?.trim();
  if (!voiceId) throw new Error('角色未配置 ElevenLabs Voice ID');
  const candidate = vp?.elevenLabsModel || apiConfig.elevenLabsModel || 'eleven_v3';
  const modelId = MODELS.has(candidate) ? candidate : 'eleven_v3';
  const processedText = prepareElevenText(text, modelId, options?.emotion);
  if (!processedText) throw new Error('ElevenLabs TTS 文本为空');
  const voiceSettings = {
    stability: clamp(vp?.elevenLabsStability, 0, 1, 0.5),
    similarity_boost: clamp(vp?.elevenLabsSimilarityBoost, 0, 1, 0.75),
    style: clamp(vp?.elevenLabsStyle, 0, 1, 0),
    use_speaker_boost: vp?.elevenLabsUseSpeakerBoost !== false,
    speed: clamp(vp?.elevenLabsSpeed, 0.7, 1.2, 1),
  };
  const cacheKey = hashTtsParams({
    kind: 'elevenlabs-tts', text: processedText, voiceId, modelId,
    outputFormat: 'mp3_44100_128', voiceSettings,
  });
  const cached = await getCachedTts(cacheKey);
  if (cached) return { url: URL.createObjectURL(cached), blob: cached };
  const blob = await fetchAudio(voiceId, apiKey, {
    text: processedText, model_id: modelId, voice_settings: voiceSettings,
  });
  saveCachedTts(cacheKey, blob).catch(() => {});
  return { url: URL.createObjectURL(blob), blob };
}

export async function synthesizeSpeechElevenLabs(
  text: string,
  char: CharacterProfile,
  apiConfig: APIConfig,
  options?: { languageBoost?: string; groupId?: string; emotion?: string },
): Promise<string> {
  return (await synthesizeSpeechElevenLabsDetailed(text, char, apiConfig, options)).url;
}
