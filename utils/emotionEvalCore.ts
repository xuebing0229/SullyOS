/**
 * 云端情绪评估的共用内核：占位符还原 + 副 API 请求 + 失败文案（先打码后截断）。
 *
 * 两个 worker（amsg 的即时对话路径、instant-push 的 Instant 路径）吃的是前端同一个
 * `buildEmotionEvalPrompt(..., includeContext=false, ...)` 模板，还原与请求逻辑必须
 * **逐字同款**——过去是两份手工同步的副本，d92231a 给报错加 apiKey 打码时只落了一份，
 * 另一份就把副 API key 随 push 带出去了。收敛到这一份叶子后，改哪条规则两边一起动。
 *
 * 零浏览器 / 零 worker 运行时依赖（两个 worker bundle 都会把这份代码打进去）。
 */

/** 副 API 凭据（没单独配就是主 API 那一份）。 */
export interface EmotionEvalApi { baseUrl: string; apiKey: string; model: string }

export type EmotionEvalRequestMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string;
};

export const EMOTION_EVAL_SYSTEM_SLOT = '__EMOTION_EVAL_SYSTEM_PROMPT__';
export const EMOTION_EVAL_HISTORY_SLOT = '__EMOTION_EVAL_HISTORY__';

/**
 * 情绪评估只看最近 6 条真实对话消息；上一轮结构化 buffs 已单独放在评估规则里，
 * 没必要把整段聊天再塞一遍。更重要的是：user / assistant 必须保留成真正的 API role，
 * 不能再拍平成一坨 `[用户]: ... / [角色]: ...` 文本让小模型自己猜说话人。
 */
export const EMOTION_EVAL_DIALOGUE_WINDOW = 6;

/** 单次评估请求的上限；副 API 卡住的话，主流程不该跟着一起被扣在这儿。 */
export const EMOTION_EVAL_TIMEOUT_MS = 120_000;

/**
 * 消息 content → 一行文本。结构化分段（带图片的消息）拍平成「文字 [图片]」。
 * 与本地 buildEmotionEvalPrompt 的 recentLines 同款：用空格连接、空段丢掉。
 */
export const flattenEvalContent = (content: unknown): string => {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part: any) => (part?.type === 'text'
        ? (part.text || '')
        : (part?.type === 'image_url' ? '[图片]' : '')))
      .filter(Boolean)
      .join(' ');
  }
  return '';
};


/**
 * 把评估规则 + 主聊天上下文组装成真正的 Chat Completions role 消息。
 *
 * - system：评估规则 + 角色这轮真正看到的所有 system 上下文。
 * - user：用户说的话。
 * - assistant：目标角色说的话。
 *
 * 这样“谁说了哪句”由 API 协议本身钉死，而不是靠模型读文本标签猜。
 * systemPromptOverride 给浏览器本地路径用：本地已经拿到了 stable+volatile 合并后的
 * mainSystemPrompt；worker 路径则直接从 chatMessages 里的 system 消息收集。
 */
export const buildEmotionEvalRequestMessages = (
  promptTemplate: string,
  chatMessages: Array<{ role: string; content: unknown }>,
  charName: string,
  systemPromptOverride?: string,
  dialogueWindow: number = EMOTION_EVAL_DIALOGUE_WINDOW,
): EmotionEvalRequestMessage[] => {
  const source = Array.isArray(chatMessages) ? chatMessages : [];
  const systemParts: string[] = [];

  const override = typeof systemPromptOverride === 'string' ? systemPromptOverride.trim() : '';
  if (override) systemParts.push(override);

  // worker 路径的主请求可能有不止一条 system（稳定前缀 / 时效尾段 / MCP reminder 等）。
  // 本地路径传了 override 也仍保留 apiMessages 里额外的 system 深度注入，避免丢世界书时效块。
  for (const message of source) {
    if (message?.role !== 'system') continue;
    const text = flattenEvalContent(message.content).trim();
    if (text && !systemParts.includes(text)) systemParts.push(text);
  }

  const systemContext = systemParts.join('\n\n---\n\n');
  const structuredHistoryNote = [
    '（对话历史没有拍平成文本；紧随本 system 消息之后的 API role 就是真实说话人：',
    'role=user 永远是用户本人，role=assistant 永远是目标角色「' + (charName || '角色') + '」。',
    '不得因为引用、复述、第一人称或最后一条消息的位置而交换说话人。）',
  ].join('');

  const templateText = String(promptTemplate);
  let evaluatorSystem = templateText
    .replace(EMOTION_EVAL_SYSTEM_SLOT, () => systemContext)
    .replace(EMOTION_EVAL_HISTORY_SLOT, () => structuredHistoryNote);
  // 本地路径的模板已经内嵌 mainSystemPrompt，不含 SYSTEM_SLOT；若历史里还有额外 system
  // （例如世界书深度注入），也不能因为改成结构化对话就丢掉。
  if (!templateText.includes(EMOTION_EVAL_SYSTEM_SLOT) && systemContext) {
    evaluatorSystem += '\n\n## 对话历史中的附加 system 上下文\n' + systemContext;
  }
  evaluatorSystem += '\n\n## 说话人边界（硬规则）'
    + '\n- role=user：只代表用户说的话。'
    + `\n- role=assistant：只代表目标角色「${charName || '角色'}」说的话。`
    + '\n- 引号、转述、引用回复只属于所在消息的说话人，不得据内容猜测后改 role。'
    + '\n- 你的任务是分析这段对话，不是继续扮演聊天。';

  const dialogue = source
    .filter((message) => message?.role === 'user' || message?.role === 'assistant')
    .map((message) => ({
      role: message.role as 'user' | 'assistant',
      content: flattenEvalContent(message.content).trim(),
    }))
    .filter((message) => !!message.content)
    .slice(-Math.max(1, Math.floor(dialogueWindow || EMOTION_EVAL_DIALOGUE_WINDOW)));

  return [
    { role: 'system', content: evaluatorSystem },
    ...dialogue,
  ];
};

/**
 * 把模板里的两个占位符用本次请求的消息还原掉。
 *
 * - `messages[0]`（role=system）= 本地的 mainSystemPrompt
 * - `messages[1..]` = 本地的 cleanedApiMessages，拼成 `[用户]: …` / `[角色名]: …` / `[系统]: …`
 *
 * 用函数式 replacer：system prompt 和对话里出现 `$&`、`$1` 这类字符时，
 * String.replace 会把它们当成替换模式解析，评估看到的就不是原话了。
 */
export const restoreEvalPrompt = (
  template: string,
  chatMessages: Array<{ role: string; content: unknown }>,
  charName: string,
): string => {
  const messages = Array.isArray(chatMessages) ? chatMessages : [];
  let systemPromptText = '';
  let conversation = messages;
  if (messages.length > 0 && messages[0]?.role === 'system') {
    systemPromptText = flattenEvalContent(messages[0].content);
    conversation = messages.slice(1);
  }
  const recentLines = conversation
    .map((m) => {
      const role = m.role === 'user' ? '用户' : (m.role === 'assistant' ? charName : '系统');
      return `[${role}]: ${flattenEvalContent(m.content)}`;
    })
    .join('\n');
  return String(template)
    .replace(EMOTION_EVAL_SYSTEM_SLOT, () => systemPromptText)
    .replace(EMOTION_EVAL_HISTORY_SLOT, () => recentLines);
};

/** 报错正文最多带回这么长——够定位是限流还是鉴权就行，不是日志转发通道。 */
export const ERROR_SNIPPET_MAX = 120;

/**
 * 「先打码、后截断」的唯一出口：所有会随 push 出门的失败文案（HTTP 分支、catch 分支）
 * 都要过这里。打码在截断之前——先截的话，切口正好落在 key 中间时整串就查不到 key，
 * 半截凭据原样带出去。个别中转会把整个请求（含 Authorization 头）回显在错误页里。
 */
export const maskAndSnip = (text: string, apiKey: string): string => {
  let snippet = text.replace(/\s+/g, ' ').trim();
  if (apiKey && snippet.includes(apiKey)) snippet = snippet.split(apiKey).join('***');
  return snippet.slice(0, ERROR_SNIPPET_MAX);
};

/** 一次评估的结局：拿到原文，或者一句能给用户看的短失败原因。 */
export interface EmotionEvalOutcome {
  /** 评估模型的输出原文；没跑出来时为 null。 */
  raw: string | null;
  /** 没跑出来的原因（人话、一句话）；成功时为 null。 */
  error: string | null;
  /** HTTP 失败时的状态码；网络/超时等没有。 */
  status?: number;
  /** 这类失败是否应该换下一条线路。 */
  failoverEligible?: boolean;
}

/**
 * 发一次评估请求并解析输出。promptContent 传 restoreEvalPrompt 还原好的整段。
 * 失败绝不抛：给一句已打码的短原因（它最终要走 push 出门，凭据绝不进 push 是红线）。
 */
export const requestEmotionEval = async (
  api: EmotionEvalApi,
  promptContent: string | EmotionEvalRequestMessage[],
  timeoutMs: number = EMOTION_EVAL_TIMEOUT_MS,
): Promise<EmotionEvalOutcome> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const baseUrl = String(api.baseUrl).replace(/\/+$/, '');
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${api.apiKey || 'sk-none'}`,
      },
      body: JSON.stringify({
        model: api.model,
        messages: Array.isArray(promptContent)
          ? promptContent
          : [{ role: 'user', content: promptContent }],
        temperature: 0.85,
        // 显式给足输出额度：部分中转不传 max_tokens 时默认很小，评估输出很长，
        // 会被截成半截 JSON。
        max_tokens: 8000,
        stream: false,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      // 正文可能是 HTML 错误页，截一小段够定位即可。
      let body = '';
      try { body = await res.text(); } catch { /* 读不出正文就只报状态码 */ }
      console.warn('[emotion-eval] 副 API 拒了这次评估（主流程不受影响）', res.status);
      const snippet = maskAndSnip(body, api.apiKey);
      const failoverEligible = res.status === 401
        || res.status === 403
        || res.status === 404
        || res.status === 408
        || res.status === 425
        || res.status === 429
        || res.status >= 500;
      return {
        raw: null,
        error: `副 API HTTP ${res.status}${snippet ? `：${snippet}` : ''}`,
        status: res.status,
        failoverEligible,
      };
    }
    const data = await res.json() as any;
    // 个别中转把全部输出塞进 reasoning_content 而 content 留空——与客户端
    // utils/emotionApply.ts 的 extractAssistantText 同一套兜底。
    const message = data?.choices?.[0]?.message;
    const raw = flattenEvalContent(message?.content)
      || (typeof message?.reasoning_content === 'string' ? message.reasoning_content : '');
    if (!raw.trim()) {
      return {
        raw: null,
        error: `评估模型没有输出内容（finish_reason: ${data?.choices?.[0]?.finish_reason ?? '?'}）`,
        failoverEligible: false,
      };
    }
    return { raw, error: null, failoverEligible: false };
  } catch (error) {
    console.warn('[emotion-eval] 评估失败（主流程不受影响）', error);
    // 只带异常名/消息，不带栈：这句要走 push 出门，短一点、也别把内部路径抖出去。
    // 异常消息同样过打码：fetch 异常一般不含请求头，但 URL 解析类错误会回显传入的
    // 地址，用户把 key 拼在 baseUrl 里时不打码就漏了。
    const reason = controller.signal.aborted
      ? `评估超时（${Math.round(timeoutMs / 1000)} 秒没回来）`
      : `评估请求没发出去：${maskAndSnip(error instanceof Error ? error.message : String(error), api.apiKey)}`;
    return { raw: null, error: reason, failoverEligible: true };
  } finally {
    clearTimeout(timer);
  }
};


/**
 * Worker 侧的情绪故障转移：按客户端已经解析好的顺序逐条尝试。
 * 400/422、空输出这类「换线路也大概率还是同一个请求问题」不切；鉴权、限流、
 * 网络、超时、404/5xx 才接下一条，和浏览器 apiFailover 的口径保持一致。
 */
export const requestEmotionEvalWithFailover = async (
  apis: EmotionEvalApi[],
  promptContent: string | EmotionEvalRequestMessage[],
  timeoutMs: number = EMOTION_EVAL_TIMEOUT_MS,
): Promise<EmotionEvalOutcome> => {
  const routes = (Array.isArray(apis) ? apis : []).filter((api) =>
    !!api?.baseUrl && !!api?.model
  );
  if (routes.length === 0) {
    return { raw: null, error: '没有可用的情绪评估 API 线路', failoverEligible: false };
  }

  let last: EmotionEvalOutcome | null = null;
  for (let i = 0; i < routes.length; i += 1) {
    const outcome = await requestEmotionEval(routes[i], promptContent, timeoutMs);
    if (outcome.raw != null) return outcome;
    last = outcome;
    if (!outcome.failoverEligible) return outcome;
  }

  if (!last) return { raw: null, error: '情绪评估失败', failoverEligible: false };
  return routes.length > 1
    ? {
        ...last,
        error: `情绪评估故障转移已耗尽（${routes.length} 条线路）：${last.error || '未知错误'}`,
      }
    : last;
};
