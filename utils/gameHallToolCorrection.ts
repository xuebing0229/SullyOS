import type { McpToolDef, McpToolResult } from './mcpClient';
import type {
  GameHallPendingAction,
  GameHallToolRequestSnapshot,
} from './gameHallTypes';

const NON_CORRECTABLE_FAILURE = /(?:\b(?:401|403|407|408|429|500|502|503|504)\b|unauthori[sz]ed|forbidden|authentication|authorization|access[ _-]?token|api[ _-]?key|token\s+(?:expired|invalid|missing)|login required|rate[ _-]?limit|too many requests|timeout|timed out|network|fetch failed|socket|\beconn|\benotfound|\bdns\b|登录|认证|鉴权|授权|令牌|密钥|限流|超时|网络|服务不可用)/i;

const CORRECTABLE_FAILURE = /(?:unknown|unsupported|unrecognized|invalid)\s+(?:arcade\s+)?(?:action|tool|command|operation)|(?:action|tool|command|operation)\s+(?:is\s+)?(?:unknown|unsupported|unrecognized|invalid)|missing\s+(?:required\s+)?(?:parameter|argument|field|property)|required\s+(?:parameter|argument|field|property).*missing|invalid[_ -]?argument|invalid[_ -]?params?|schema\s+(?:validation|error)|validation\s+(?:failed|error)|invalid\s+enum|must\s+be\s+one\s+of|expected\s+one\s+of|allowed\s+values?|additional\s+propert|unexpected\s+(?:parameter|argument|field|property)|type\s+mismatch|未知.{0,24}(?:action|动作|工具|命令|操作)|(?:action|动作|工具|命令|操作).{0,24}(?:未知|不支持|无效|不存在)|缺少.{0,24}(?:必填|参数|字段)|(?:必填|参数|字段).{0,24}缺失|参数.{0,24}(?:无效|格式错误|类型错误)|枚举.{0,24}(?:无效|错误|范围)/i;

const stringify = (value: unknown): string => {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};

export const gameHallToolFailureText = (
  result: McpToolResult,
): string => [
  result.error,
  result.rawText,
  stringify(result.data),
  stringify(result.structuredContent),
  stringify(result.rawResult),
].filter(Boolean).join('\n');

/**
 * Only deterministic request-shape mistakes get an automatic correction turn.
 * Transport, authentication, throttling and server failures must never spend a
 * second model/tool call pretending that a different action can repair them.
 */
export const isCorrectableGameHallToolFailure = (
  result: McpToolResult,
): boolean => {
  if (result.success) return false;
  const text = gameHallToolFailureText(result);
  if (!text || NON_CORRECTABLE_FAILURE.test(text)) return false;
  return CORRECTABLE_FAILURE.test(text);
};

const schemaExample = (
  schema: any,
  fieldName = 'value',
  depth = 0,
): unknown => {
  if (!schema || typeof schema !== 'object' || depth > 6) return `<${fieldName}>`;
  if ('const' in schema) return schema.const;
  if ('example' in schema) return schema.example;
  if (Array.isArray(schema.examples) && schema.examples.length) return schema.examples[0];
  if ('default' in schema) return schema.default;
  if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0];

  const variant = Array.isArray(schema.oneOf) && schema.oneOf.length
    ? schema.oneOf[0]
    : Array.isArray(schema.anyOf) && schema.anyOf.length
      ? schema.anyOf[0]
      : undefined;
  if (variant) return schemaExample(variant, fieldName, depth + 1);

  const type = Array.isArray(schema.type)
    ? schema.type.find((item: unknown) => item !== 'null')
    : schema.type;
  if (type === 'object' || schema.properties) {
    const properties = schema.properties || {};
    const required = Array.isArray(schema.required) ? schema.required : [];
    return Object.fromEntries(required.map((key: string) => [
      key,
      schemaExample(properties[key], key, depth + 1),
    ]));
  }
  if (type === 'array') {
    const count = Math.max(0, Number(schema.minItems) || 0);
    return Array.from({ length: count }, () => schemaExample(schema.items, fieldName, depth + 1));
  }
  if (type === 'integer') return Number.isFinite(schema.minimum) ? Math.ceil(schema.minimum) : 0;
  if (type === 'number') return Number.isFinite(schema.minimum) ? schema.minimum : 0;
  if (type === 'boolean') return false;
  if (type === 'null') return null;
  return `<${fieldName}>`;
};

export const buildGameHallToolCallExamples = (
  tools: McpToolDef[],
): Array<{ toolIndex: number; toolName: string; args: unknown }> =>
  tools.map((tool, toolIndex) => ({
    toolIndex,
    toolName: tool.name,
    args: schemaExample(tool.inputSchema || { type: 'object' }, 'args'),
  }));

export interface GameHallToolCorrectionFeedbackInput {
  failedAction: GameHallPendingAction;
  failedRequest: GameHallToolRequestSnapshot;
  failedResult: McpToolResult;
  availableTools: McpToolDef[];
}

export const buildGameHallToolCorrectionFeedback = (
  input: GameHallToolCorrectionFeedbackInput,
): string => `
\n【游戏厅工具纠错：仅此一次】
你刚才的工具调用因可纠正的动作名或参数问题失败。不要原样重发，也不要自造 action、toolName 或字段。

失败行动：
${stringify({
  toolIndex: input.failedAction.toolIndex,
  toolName: input.failedAction.toolName,
  args: input.failedAction.args,
  accountRef: input.failedAction.accountRef,
})}

实际发送请求：
${stringify(input.failedRequest)}

完整失败返回：
${stringify(input.failedResult)}

下面的最小调用示例由本轮原始 tools/list schema 动态生成，顺序和 toolIndex 与原数组一致：
${stringify(buildGameHallToolCallExamples(input.availableTools))}

请结合完整 tools/list、失败返回和上述示例重新规划一次。只能选择真实 toolIndex/toolName，并修正 args；不要解释教程。
这次修正后的行动如果仍失败，系统会停止，不会继续自动重试。`;
