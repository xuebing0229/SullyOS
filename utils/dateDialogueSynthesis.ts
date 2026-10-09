import { Capacitor, CapacitorHttp } from '@capacitor/core';
import type { APIConfig } from '../types';
import { resolveElevenLabsApiKey, resolveElevenLabsModel, cleanTextForTtsElevenLabs, normalizeElevenLabsVoiceId, ELEVENLABS_OUTPUT_FORMAT } from './elevenLabsTts';
import { buildDateDialogueBatch, type DateDialogueTurn, type DateDialogueSegment } from './dateDialogueVoice';

/**
 * 见面模式专用：一次请求完成 char/user 双声线演绎。
 * 仅使用角色原始演出文本，不调用额外语音导演。
 * 返回完整音频和可用的逐句时间区间；时间戳不可用时显式失败。
 */
export async function synthesizeDateDialogue(
  turns: DateDialogueTurn[],
  config: APIConfig,
): Promise<{ audio: Blob; segments: DateDialogueSegment[] }> {
  const key = resolveElevenLabsApiKey(config);
  if (!key) throw new Error('缺少 ElevenLabs API Key');
  const normalized = turns.map(t => ({
    ...t,
    voiceId: normalizeElevenLabsVoiceId(t.voiceId),
    speech: cleanTextForTtsElevenLabs(t.speech, resolveElevenLabsModel(config)),
  }));
  if (!normalized.length || normalized.some(t => !t.voiceId || !t.speech)) {
    throw new Error('双人配音需要双方的 Voice ID 和非空台词');
  }
  const batch = buildDateDialogueBatch(normalized);
  const body = { model_id: resolveElevenLabsModel(config), inputs: batch.inputs };
  const endpoint = 'https://api.elevenlabs.io/v1/text-to-dialogue/with-timestamps';
  let status: number;
  let payload: any;
  if (Capacitor.isNativePlatform()) {
    const response = await CapacitorHttp.request({
      url: endpoint, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'xi-api-key': key },
      data: body, responseType: 'json',
    });
    status = response.status;
    payload = response.data;
  } else {
    // 浏览器不能安全直连携带私钥的跨域接口，需先部署同源代理。
    throw new Error('网页端双人配音尚需同源代理，不能直接暴露 API Key');
  }
  if (status < 200 || status >= 300) {
    throw new Error('ElevenLabs Dialogue 请求失败 (HTTP ' + status + '): ' + JSON.stringify(payload).slice(0, 200));
  }
  const audioBase64 = payload?.audio_base64;
  if (typeof audioBase64 !== 'string' || !audioBase64) throw new Error('ElevenLabs 未返回音频');
  const binary = atob(audioBase64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const audio = new Blob([bytes], { type: 'audio/mpeg' });

  // 官方返回的 alignment 是字符级而非必然逐句区间。
  // 只在可证明边界时映射，避免按停顿猜测导致截断呼吸和尾音。
  const alignment = payload?.alignment;
  const starts: number[] = alignment?.character_start_times_seconds;
  const ends: number[] = alignment?.character_end_times_seconds;
  const chars: string[] = alignment?.characters;
  if (!Array.isArray(starts) || !Array.isArray(ends) || !Array.isArray(chars) ||
      starts.length !== chars.length || ends.length !== chars.length) {
    throw new Error('ElevenLabs Dialogue 缺少可用字符时间戳');
  }
  const spoken = batch.inputs.map(input => input.text);
  const joined = chars.join('');
  let cursor = 0;
  const segments: DateDialogueSegment[] = [];
  for (let i = 0; i < spoken.length; i++) {
    const text = spoken[i];
    const start = joined.indexOf(text, cursor);
    if (start < 0 || start < cursor) throw new Error('Dialogue 字符对齐无法映射台词');
    const end = start + text.length - 1;
    if (!Number.isFinite(starts[start]) || !Number.isFinite(ends[end])) throw new Error('Dialogue 时间戳无效');
    segments.push({
      lineId: normalized[i].lineId,
      speaker: normalized[i].speaker,
      startTime: starts[start],
      endTime: ends[end],
    });
    cursor = end + 1;
  }
  return { audio, segments };
}
