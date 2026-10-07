/**
 * Emotion-eval models occasionally leak reasoning wrapper tags into JSON string fields,
 * e.g. "热度在往上</think> <think>蹭". Those tags are transport/model artifacts, not
 * user-facing emotion text. Strip the wrappers while preserving the text around/inside them.
 *
 * Keep this deliberately narrow: only known reasoning-tag names are removed, so ordinary
 * angle-bracket text in a character's prose is left alone.
 */
export function stripEmotionReasoningMarkup(text: string): string {
    if (typeof text !== 'string' || !text) return text;
    return text
        .replace(/(?:<|＜)\s*(?:\/|／)?\s*(?:think|thinking|thought|reasoning|analysis)\b[^>＞]*(?:>|＞)/giu, '')
        .replace(/[ \t]{2,}/g, ' ')
        .replace(/[ \t]+\n/g, '\n')
        .trim();
}
