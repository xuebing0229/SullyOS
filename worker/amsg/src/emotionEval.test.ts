// worker/amsg/src/emotionEval.test.ts
//
// 占位符还原：前端把评估提示词里两段大文本（角色的 system prompt、完整对话历史）
// 留成占位符发上来，worker 用本次请求已有的消息填回原位。填错一个字，评估看到的
// 就不是角色真正看到的那份上下文，判出来的情绪对不上它刚说的话——而这种偏差在
// 界面上完全看不出来，只会表现为「情绪越来越不准」。
import { afterEach, describe, it, expect, vi } from 'vitest';

import {
  resolveEmotionEvalApi,
  restoreEvalPrompt,
  runAmsgEmotionEval,
  takeEmotionEvalSpec,
} from './emotionEval';

const TEMPLATE = [
  '## 角色此刻看到的完整上下文',
  '__EMOTION_EVAL_SYSTEM_PROMPT__',
  '## 完整对话历史',
  '__EMOTION_EVAL_HISTORY__',
].join('\n');

describe('restoreEvalPrompt', () => {
  it('system prompt 进第一个槽，其余消息按 [角色]: 正文 拼进第二个槽', () => {
    const out = restoreEvalPrompt(TEMPLATE, [
      { role: 'system', content: '你是 Nyah。' },
      { role: 'user', content: '在吗' },
      { role: 'assistant', content: '在的。' },
    ], 'Nyah');

    expect(out).not.toContain('__EMOTION_EVAL_SYSTEM_PROMPT__');
    expect(out).not.toContain('__EMOTION_EVAL_HISTORY__');
    expect(out).toContain('你是 Nyah。');
    expect(out).toContain('[用户]: 在吗');
    expect(out).toContain('[Nyah]: 在的。');
  });

  // String.replace 的第二个参数里，`$&`（整个匹配）、`$1`、`$'` 都是替换模式。
  // 用户设定里出现这些字符完全正常（写代码、写价格、写颜文字），naive 的
  // `.replace(槽位, 文本)` 会把它们当指令展开——system prompt 里凭空多出一串
  // 「__EMOTION_EVAL_SYSTEM_PROMPT__」，用户的原话反而丢了。函数式 replacer 才不会。
  it('设定里带 $& / $1 这类字符时逐字还原，不被当成替换模式展开', () => {
    const nastySystem = '规则：价格写成 $1，强调用 $& 包起来，别写 $`。';
    const out = restoreEvalPrompt(TEMPLATE, [
      { role: 'system', content: nastySystem },
      { role: 'user', content: '懂了 $&' },
    ], 'Nyah');

    expect(out).toContain(nastySystem);
    expect(out).toContain('[用户]: 懂了 $&');
    // naive 实现下 $& 会被展开成占位符本身，这两条就是那种走样的样子
    expect(out).not.toContain('__EMOTION_EVAL_SYSTEM_PROMPT__');
    expect(out).not.toContain('__EMOTION_EVAL_HISTORY__');
  });

  it('带图片的结构化消息拍平成「文字 [图片]」（跟本地那份逐字同款）', () => {
    const out = restoreEvalPrompt(TEMPLATE, [
      { role: 'system', content: '你是 Nyah。' },
      {
        role: 'user',
        content: [
          { type: 'text', text: '看这个' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
        ],
      },
    ], 'Nyah');

    expect(out).toContain('[用户]: 看这个 [图片]');
    // 图片的 base64 一个字节都不该进评估请求（白烧 token，还可能撑爆请求体）
    expect(out).not.toContain('base64');
  });

  // 即时对话的时效块（现在几点、外面在下雨）是追加在末尾的 system 消息。
  // 它必须进历史，评估才知道角色刚才是对着什么时间说的那句话。
  it('末尾追加的 system 块进历史，标成 [系统]', () => {
    const out = restoreEvalPrompt(TEMPLATE, [
      { role: 'system', content: '你是 Nyah。' },
      { role: 'user', content: '在吗' },
      { role: 'system', content: '【此刻的系统信息·仅你可见】\n现在是 2026年8月1日 早晨 08:00。' },
    ], 'Nyah');

    expect(out).toContain('[系统]: 【此刻的系统信息·仅你可见】');
    expect(out).toContain('现在是 2026年8月1日 早晨 08:00。');
  });

  it('第一条不是 system 时全都算历史（不硬吃掉一条当设定）', () => {
    const out = restoreEvalPrompt(TEMPLATE, [
      { role: 'user', content: '在吗' },
    ], 'Nyah');

    expect(out).toContain('[用户]: 在吗');
    // 设定槽位填空串：没有就是没有，不能拿第一条用户消息顶上去
    expect(out).toContain('## 角色此刻看到的完整上下文\n\n## 完整对话历史');
  });
});


describe('结构化说话人 role', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('副 API 真正收到 user / assistant 分开的消息，不再把双方对话拍成一条 user 文本', async () => {
    const fetchMock = vi.fn(async (_url: unknown, init: any) => ({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: '{"changed":false,"buffs":[],"injection":"","innerState":"ok"}' } }],
      }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    await runAmsgEmotionEval(
      { prompt: TEMPLATE },
      { baseUrl: 'https://eval.example.com/v1', apiKey: 'sk-eval', model: 'eval-mini' },
      [
        { role: 'system', content: '你是 Nyah。' },
        { role: 'user', content: '你刚才明明说「我可以不去」。' },
        { role: 'assistant', content: '我说的是「你不用勉强」，不是那句话。' },
        {
          role: 'user',
          content: [
            { type: 'text', text: '你看，我截图了' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
          ],
        },
        { role: 'system', content: '现在是 08:00。' },
      ],
      'Nyah',
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0][1] as any;
    const body = JSON.parse(String(init.body));
    const messages = body.messages as Array<{ role: string; content: string }>;

    expect(messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user', 'user']);
    expect(messages[1].content).toBe('你刚才明明说「我可以不去」。');
    expect(messages[2].content).toBe('我说的是「你不用勉强」，不是那句话。');
    expect(messages[3].content).toBe('你看，我截图了 [图片]');
    expect(messages[4].content).toContain('评估控制指令，不属于真实对话');
    expect(messages[4].content).toContain('最后一条真实对话的 role=user');
    expect(messages[4].content).toContain('只输出一个合法 JSON 对象');
    expect(messages[0].content).toContain('role=user 永远是用户本人');
    expect(messages[0].content).toContain('role=assistant 永远是目标角色「Nyah」');
    expect(messages[0].content).toContain('现在是 08:00。');
    expect(messages[0].content).not.toContain('[用户]: 你刚才明明说');
    expect(body.temperature).toBe(0.2);
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(JSON.stringify(body)).not.toContain('base64');
  });

  it('站子明确拒绝 response_format 时自动去掉 JSON mode 重试一次', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: async () => 'Unsupported parameter: response_format',
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: '{"changed":false,"buffs":[],"injection":"","innerState":"ok"}' } }],
        }),
      });
    vi.stubGlobal('fetch', fetchMock);

    const outcome = await runAmsgEmotionEval(
      { prompt: TEMPLATE },
      { baseUrl: 'https://eval.example.com/v1', apiKey: 'sk-eval', model: 'eval-mini' },
      [
        { role: 'user', content: '在吗' },
        { role: 'assistant', content: '在。' },
      ],
      'Nyah',
    );

    expect(outcome.raw).toContain('"innerState":"ok"');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstBody = JSON.parse(String(fetchMock.mock.calls[0][1].body));
    const secondBody = JSON.parse(String(fetchMock.mock.calls[1][1].body));
    expect(firstBody.response_format).toEqual({ type: 'json_object' });
    expect(secondBody).not.toHaveProperty('response_format');
    expect(firstBody.temperature).toBe(0.2);
    expect(secondBody.temperature).toBe(0.2);
    const secondMessages = secondBody.messages as Array<{ role: string; content: string }>;
    expect(secondMessages.at(-1)?.content).toContain('最后一条真实对话的 role=assistant');
  });
});

// 失败原因这句话最终要走 push 出门（评估失败信号带给客户端），里头绝不能有 apiKey。
// 个别中转会把整个请求（含 Authorization 头）回显在错误页里，所以打码必须先于截断：
// 先截的话，切口正好落在 key 中间时整串里查不到完整 key，半截凭据就原样带出去了。
describe('评估失败原因的脱敏', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('错误正文里的 apiKey 被截断切中也不许漏出半截（先打码后截断）', async () => {
    const apiKey = 'sk-secondary-0123456789abcdef0123456789abcdef';
    // 110 个填充字符 + key：120 字符的切口正好穿过 key 的前半截。
    const body = 'x'.repeat(110) + apiKey + ' tail';
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 401,
      text: async () => body,
    })));

    const outcome = await runAmsgEmotionEval(
      { prompt: TEMPLATE },
      { baseUrl: 'https://eval.example.com/v1', apiKey, model: 'eval-mini' },
      [{ role: 'user', content: '在吗' }],
      'Nyah',
    );

    expect(outcome.raw).toBeNull();
    expect(outcome.error).toContain('副 API HTTP 401');
    expect(outcome.error).toContain('***');
    expect(outcome.error, 'key 的前缀一个字节都不许出门').not.toContain(apiKey.slice(0, 10));
  });
});

// 评估配置的两种长相：存量任务把副 API 凭据整份塞在 metadata 里；新任务只带提示词模板，
// 凭据在 llm_credentials 表里、任务只带 credRefs.emotion 这个名字。两种都得认。
describe('副 API 凭据的来路（内联 / 凭据表）', () => {
  const SPEC_INLINE = {
    prompt: 'T',
    api: { baseUrl: 'https://inline.example.dev/v1', apiKey: 'sk-inline', model: 'inline-mini' },
  };

  it('存量任务里内联的那份优先（不去劳动凭据表）', async () => {
    const resolve = vi.fn();
    await expect(resolveEmotionEvalApi(SPEC_INLINE, { emotion: 'char:c1/emotion' }, resolve))
      .resolves.toEqual(SPEC_INLINE.api);
    expect(resolve).not.toHaveBeenCalled();
  });

  it('只带引用 → 按名字现读，apiUrl 摘回 baseUrl 口径（评估请求自己会补 /chat/completions）', async () => {
    const resolve = vi.fn(async () => ({
      apiUrl: 'https://tabled.example.dev/v1/chat/completions',
      apiKey: 'sk-tabled',
      primaryModel: 'tabled-mini',
    }));

    await expect(resolveEmotionEvalApi({ prompt: 'T' }, { emotion: 'char:c1/emotion' }, resolve))
      .resolves.toEqual({
        baseUrl: 'https://tabled.example.dev/v1', apiKey: 'sk-tabled', model: 'tabled-mini',
      });
    expect(resolve).toHaveBeenCalledWith('char:c1/emotion');
  });

  it('云端那行没了 / 老部署根本没有这个方法 → null，这一轮不评估（主回复照发）', async () => {
    await expect(resolveEmotionEvalApi({ prompt: 'T' }, { emotion: 'char:c1/emotion' }, async () => null))
      .resolves.toBeNull();
    await expect(resolveEmotionEvalApi({ prompt: 'T' }, { emotion: 'char:c1/emotion' }, undefined))
      .resolves.toBeNull();
    await expect(resolveEmotionEvalApi({ prompt: 'T' }, null, async () => null)).resolves.toBeNull();
  });

  it('读凭据抛错也只是不评估，绝不把这一轮的正文连累掉', async () => {
    await expect(resolveEmotionEvalApi({ prompt: 'T' }, { emotion: 'char:c1/emotion' }, async () => {
      throw new Error('D1 挂了');
    })).resolves.toBeNull();
  });
});

// 两道防线一道都不能少：任务 metadata 走的是加密信封，放凭据安全；推送出了这台 worker
// 就归推送服务管了，所以捕获点就地删、组 push 前再删一次。
describe('takeEmotionEvalSpec 认新旧两种形状', () => {
  it('只带提示词模板（新任务）→ 认，并就地把键删掉', () => {
    const metadata: Record<string, unknown> = { charId: 'c1', amsgEmotionEval: { prompt: 'T' } };
    expect(takeEmotionEvalSpec(metadata)).toEqual({ prompt: 'T' });
    expect(metadata).not.toHaveProperty('amsgEmotionEval');
  });

  it('带整份内联凭据（存量任务）→ 照旧认，键同样就地删掉', () => {
    const spec = { prompt: 'T', api: { baseUrl: 'https://x.dev', apiKey: 'sk-x', model: 'm' } };
    const metadata: Record<string, unknown> = { amsgEmotionEval: spec };
    expect(takeEmotionEvalSpec(metadata)).toEqual(spec);
    expect(metadata).not.toHaveProperty('amsgEmotionEval');
  });

  it('带了 api 却配不齐 → 判不可用，键照删（那份里同样有 apiKey）', () => {
    const metadata: Record<string, unknown> = {
      amsgEmotionEval: { prompt: 'T', api: { baseUrl: '', apiKey: 'sk-x', model: '' } },
    };
    expect(takeEmotionEvalSpec(metadata)).toBeNull();
    expect(metadata).not.toHaveProperty('amsgEmotionEval');
  });

  it('没有提示词模板 → 不可用（评估无从谈起）', () => {
    expect(takeEmotionEvalSpec({ amsgEmotionEval: { prompt: '' } })).toBeNull();
  });
});


describe('情绪 API 故障转移', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('首线路 503 时自动切到备用线路，并返回备用线路结果', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        text: async () => 'upstream unavailable',
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: '{"changed":false,"buffs":[],"injection":"","innerState":"ok"}' } }],
        }),
      });
    vi.stubGlobal('fetch', fetchMock);

    const outcome = await runAmsgEmotionEval(
      {
        prompt: TEMPLATE,
        fallbackApis: [
          { baseUrl: 'https://backup.example.com/v1', apiKey: 'sk-backup', model: 'eval-backup' },
        ],
      },
      { baseUrl: 'https://primary.example.com/v1', apiKey: 'sk-primary', model: 'eval-primary' },
      [{ role: 'user', content: '在吗' }],
      'Nyah',
    );

    expect(outcome.raw).toContain('"innerState":"ok"');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0][0])).toContain('primary.example.com');
    expect(String(fetchMock.mock.calls[1][0])).toContain('backup.example.com');
  });

  it('首线路 400 时不切备用线路，避免把同一个坏请求重复烧一遍', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 400,
      text: async () => 'bad request',
    }));
    vi.stubGlobal('fetch', fetchMock);

    const outcome = await runAmsgEmotionEval(
      {
        prompt: TEMPLATE,
        fallbackApis: [
          { baseUrl: 'https://backup.example.com/v1', apiKey: 'sk-backup', model: 'eval-backup' },
        ],
      },
      { baseUrl: 'https://primary.example.com/v1', apiKey: 'sk-primary', model: 'eval-primary' },
      [{ role: 'user', content: '在吗' }],
      'Nyah',
    );

    expect(outcome.raw).toBeNull();
    expect(outcome.error).toContain('HTTP 400');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
