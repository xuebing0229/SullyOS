import { ChatParser } from './chatParser';

export type AssistantDisplayPart =
  | { type: 'text'; content: string }
  | { type: 'emoji'; name: string };

/** Ordered split units before caller-specific quote/metadata handling. */
export type AssistantDisplayUnit = AssistantDisplayPart;

export function splitAssistantDisplayUnits(content: string): AssistantDisplayUnit[] {
  const output: AssistantDisplayUnit[] = [];
  for (const part of ChatParser.splitResponse(content)) {
    if (part.type === 'emoji') {
      const name = String(part.content || '').trim();
      if (name) output.push({ type: 'emoji', name });
      continue;
    }
    const blocks = part.content
      .split(/^\s*---\s*$/m)
      .map(block => block.trim())
      .filter(Boolean);
    const chunks = blocks.flatMap(block => ChatParser.chunkText(block));
    if (!chunks.length && part.content.trim()) chunks.push(part.content.trim());
    chunks.forEach(chunk => output.push({ type: 'text', content: chunk }));
  }
  return output;
}

export interface AssistantDisplayResult {
  cleanedContent: string;
  thinkingChain?: string;
  parts: AssistantDisplayPart[];
}

/** Shared first-pass cleanup used by both normal chat and Game Hall. */
export const normalizeAssistantContent = (raw: string): string => {
  let cleaned = raw || '';
  cleaned = cleaned.replace(/<(think|thinking|thought)>[\s\S]*?<\/\1>/gi, '');
  cleaned = cleaned.replace(/<(?:think|thinking|thought)>[\s\S]*$/gi, '');
  cleaned = cleaned.replace(/\[\d{4}[-/年]\d{1,2}[-/月]\d{1,2}.*?\]/g, '');
  cleaned = cleaned.replace(/^[\w一-龥]+:\s*/, '');
  cleaned = cleaned.replace(/\s*\[(?:聊天|通话|约会)\]\s*/g, '\n');
  cleaned = cleaned.replace(
    /\[(?:你|User|用户|System)\s*发送了表情包[:：]\s*(.*?)\]/g,
    '[[SEND_EMOJI: $1]]',
  );
  return cleaned;
};

export function extractAssistantThinking(input: {
  rawContent: string;
  reasoningContent?: string;
  enabled: boolean;
}): string | undefined {
  if (!input.enabled) return undefined;
  const blocks: string[] = [];
  const reasoning = String(input.reasoningContent || '').trim();
  if (reasoning) blocks.push(reasoning);

  const pattern = /<(think|thinking|thought)>([\s\S]*?)<\/\1>/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(input.rawContent || ''))) {
    const text = String(match[2] || '').trim();
    if (text) blocks.push(text);
  }
  // Preserve the current main-chat behavior for an unterminated reasoning block
  // while still stripping it completely from visible content.
  if (!/<\/(?:think|thinking|thought)>/i.test(input.rawContent || '')) {
    const openOnly = (input.rawContent || '').match(/<(?:think|thinking|thought)>([\s\S]*$)/i);
    if (openOnly?.[1]?.trim()) blocks.push(openOnly[1].trim());
  }
  const unique = Array.from(new Set(blocks));
  return unique.length ? unique.join('\n\n') : undefined;
}

export function splitAssistantDisplayParts(rawContent: string): AssistantDisplayPart[] {
  const normalized = normalizeAssistantContent(rawContent);
  const sanitized = ChatParser.sanitize(normalized, { keepCitations: false });
  if (!sanitized) return [];

  const output: AssistantDisplayPart[] = [];
  for (const unit of splitAssistantDisplayUnits(sanitized)) {
    if (unit.type === 'emoji') {
      output.push(unit);
      continue;
    }
    const clean = ChatParser.sanitize(unit.content);
    if (clean && ChatParser.hasDisplayContent(clean)) {
      output.push({ type: 'text', content: clean });
    }
  }
  return output;
}

export function buildAssistantDisplayResult(input: {
  rawContent: string;
  reasoningContent?: string;
  showThinkingChain: boolean;
}): AssistantDisplayResult {
  return {
    cleanedContent: normalizeAssistantContent(input.rawContent),
    thinkingChain: extractAssistantThinking({
      rawContent: input.rawContent,
      reasoningContent: input.reasoningContent,
      enabled: input.showThinkingChain,
    }),
    parts: splitAssistantDisplayParts(input.rawContent),
  };
}