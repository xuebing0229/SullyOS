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

    const requestUrl =
      diagnostics?.requestUrl ||
      'unknown';

    const finalUrl =
      diagnostics?.finalUrl ||
      'unknown';

    const redirected =
      diagnostics?.redirected
        ? 'yes'
        : 'no';

    const authorizationConstructed =
      diagnostics?.authorizationPresent
        ? 'yes'
        : 'no';

    const authorizationScheme =
      diagnostics?.authorizationScheme ||
      'unknown';

    const sentHeaderNames =
      diagnostics?.sentHeaderNames?.length
        ? diagnostics.sentHeaderNames.join('|')
        : 'unknown';

    const traceId =
      data?.trace_id ||
      'none';

    const miniMaxStatusCode =
      typeof statusCode === 'number'
        ? String(statusCode)
        : 'none';

    const rawResponse =
      JSON.stringify(data);

    /*
     * 系统调试终端会截断过长的 console.error。
     * 因此将诊断信息拆成多条短日志。
     *
     * 日志中不会输出 API Key，只会说明是否构造了
     * Authorization，以及发送了哪些请求头名称。
     */
    console.error(
      `[MM-DIAG-1] HTTP=${response.status}; MM_CODE=${miniMaxStatusCode}`,
    );

    console.error(
      `[MM-DIAG-2] URL=${requestUrl}`,
    );

    console.error(
      `[MM-DIAG-3] FINAL_URL=${finalUrl}`,
    );

    console.error(
      `[MM-DIAG-4] REDIRECTED=${redirected}`,
    );

    console.error(
      `[MM-DIAG-5] AUTH_CONSTRUCTED=${authorizationConstructed}`,
    );

    console.error(
      `[MM-DIAG-6] AUTH_SCHEME=${authorizationScheme}`,
    );

    console.error(
      `[MM-DIAG-7] HEADERS=${sentHeaderNames}`,
    );

    console.error(
      `[MM-DIAG-8] TRACE=${traceId}`,
    );

    console.error(
      `[MM-DIAG-9] MESSAGE=${statusMsg}`,
    );

    console.error(
      `[MM-DIAG-10] RAW=${rawResponse}`,
    );

    const detail = [
      'MiniMax 音色查询失败',

      `错误信息: ${statusMsg}`,

      `HTTP 状态: ${response.status}`,

      `MiniMax 状态码: ${miniMaxStatusCode}`,

      `trace_id: ${traceId}`,

      `请求地址: ${requestUrl}`,

      `最终地址: ${finalUrl}`,

      `发生重定向: ${
        redirected === 'yes'
          ? '是'
          : '否'
      }`,

      `Authorization 已构造: ${
        authorizationConstructed === 'yes'
          ? '是'
          : '否'
      }`,

      `鉴权方案: ${authorizationScheme}`,

      `发送的请求头名称: ${sentHeaderNames}`,

      `原始响应（不含你的 API Key）: ${JSON.stringify(
        data,
        null,
        2,
      )}`,
    ].join('\n');

    /*
     * 尝试显示可复制的完整诊断窗口。
     * 部分 Android WebView 可能不支持 prompt，
     * 即使窗口没出现，上面的 MM-DIAG 日志仍会保留。
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
