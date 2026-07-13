import { minimaxFetch } from './minimaxEndpoint';

export type MiniMaxVoiceType =
  | 'all'
  | 'system'
  | 'voice_cloning'
  | 'voice_generation';

export interface MiniMaxVoiceItem {
  voice_id: string;
  voice_name?: string;
  [key: string]: any;
}

export interface MiniMaxVoiceListResult {
  system_voice: MiniMaxVoiceItem[];
  voice_cloning: MiniMaxVoiceItem[];
  voice_generation: MiniMaxVoiceItem[];
  trace_id?: string;
}

const MINIMAX_VOICE_ENDPOINT =
  '/api/minimax/get-voice';

const normalizeApiKey = (
  raw: string,
): string =>
  raw
    .trim()
    .replace(/^Bearer\s+/i, '')
    .trim();

export async function fetchMiniMaxVoices(
  apiKey: string,
  voiceType: MiniMaxVoiceType = 'all',
): Promise<MiniMaxVoiceListResult> {
  const key = normalizeApiKey(apiKey || '');

  if (!key) {
    throw new Error('缺少 MiniMax API Key');
  }

  const response = await minimaxFetch(
    MINIMAX_VOICE_ENDPOINT,
    {
      method: 'POST',

      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
        'X-MiniMax-API-Key': key,
      },

      body: JSON.stringify({
        voice_type: voiceType,
      }),
    },
  );

  const data = await response.json();

  const statusCode =
    data?.base_resp?.status_code;

  if (
    !response.ok ||
    (
      typeof statusCode === 'number' &&
      statusCode !== 0
    )
  ) {
    const statusMsg =
      data?.base_resp?.status_msg ||
      data?.error ||
      data?.message ||
      `HTTP ${response.status}`;

    const diagnostics =
      response.diagnostics;

    const detail = [
      'MiniMax 音色查询失败',

      `错误信息: ${statusMsg}`,

      `HTTP 状态: ${response.status}`,

      `MiniMax 状态码: ${
        typeof statusCode === 'number'
          ? statusCode
          : '未提供'
      }`,

      `trace_id: ${
        data?.trace_id || '未提供'
      }`,

      diagnostics
        ? `请求地址: ${diagnostics.requestUrl}`
        : '',

      diagnostics
        ? `最终地址: ${diagnostics.finalUrl}`
        : '',

      diagnostics
        ? `发生重定向: ${
            diagnostics.redirected
              ? '是'
              : '否'
          }`
        : '',

      diagnostics
        ? `Authorization 已构造: ${
            diagnostics.authorizationPresent
              ? '是'
              : '否'
          }`
        : '',

      diagnostics
        ? `鉴权方案: ${
            diagnostics.authorizationScheme
          }`
        : '',

      diagnostics
        ? `发送的请求头名称: ${
            diagnostics.sentHeaderNames.join(
              ', ',
            )
          }`
        : '',

      `原始响应（不含你的 API Key）: ${
        JSON.stringify(data, null, 2)
      }`,
    ]
      .filter(Boolean)
      .join('\n');

    console.error(
      '[MiniMax Voice] full diagnostics',
      detail,
    );

    /*
     * 手机 Toast 会截断长错误。
     * prompt 窗口中的内容可以长按、全选并复制。
     * 诊断内容不会包含 API Key。
     */
    if (
      typeof window !== 'undefined' &&
      typeof window.prompt === 'function'
    ) {
      window.prompt(
        'MiniMax 完整诊断（可长按复制）',
        detail,
      );
    }

    throw new Error(
      `MiniMax 音色查询失败: ${statusMsg}`,
    );
  }

  return {
    system_voice: Array.isArray(
      data?.system_voice,
    )
      ? data.system_voice
      : [],

    voice_cloning: Array.isArray(
      data?.voice_cloning,
    )
      ? data.voice_cloning
      : [],

    voice_generation: Array.isArray(
      data?.voice_generation,
    )
      ? data.voice_generation
      : [],

    trace_id: data?.trace_id,
  };
}
