/**
 * 见面 VN 的台词边界。只有整行符合「机器标签 + 成对引号 + 机器标签」
 * 才能送入 TTS；格式不完整时宁可静音，也绝不把旁白当台词念出来。
 * Audio Tags 只保留引号内的部分。
 */
export const extractDateSpokenText = (raw: string): string => {
  const withoutControlTags = (raw || '')
    .replace(/\[(?:speaker|s):\s*(?:char|user)\s*\]/gi, '')
    .replace(/\[v:\s*[a-zA-Z]+\s*\]/gi, '')
    .trim();
  // 允许前缀表情标签和声音提示标签，但它们不属于台词正文。
  const line = withoutControlTags.replace(/^(?:\[[^\[\]\n]+\]\s*)*/, '').trim();
  if (!line) return '';
  const opening = line[0];
  const ending = opening === '「' ? '」' : opening === '“' ? '”' : opening === '"' ? '"' : '';
  if (!ending) return '';
  const endIndex = line.lastIndexOf(ending);
  if (endIndex <= 0) return '';
  // 引号外出现动作、旁白或第二段引号，说明不是独立台词行。
  // 不猜测哪些字该念；上游 VN 格式要求每行只有一个 beat。
  const after = line.slice(endIndex + 1).trim();
  if (after && !/^[。！？!?.,，、…~～\s]+$/.test(after)) return '';
  const spoken = line.slice(1, endIndex).trim();
  return spoken;
};

export const isDateSpokenLine = (raw: string): boolean =>
  extractDateSpokenText(raw).length > 0;
