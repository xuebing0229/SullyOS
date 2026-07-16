export const TURN_CONTEXT_OPEN = '\n\n[System: Turn Context Snapshot]\n';
export const TURN_CONTEXT_CLOSE = '\n[/System: Turn Context Snapshot]';

export function appendTurnContext(content: any, turnContext?: string): any {
    const snapshot = turnContext?.trim();
    if (!snapshot) return content;
    if (typeof content === 'string' && content.includes(TURN_CONTEXT_OPEN.trim())) return content;
    if (Array.isArray(content) && content.some(part =>
        part?.type === 'text' && typeof part.text === 'string' && part.text.includes(TURN_CONTEXT_OPEN.trim())
    )) return content;
    const envelope = `${TURN_CONTEXT_OPEN}${snapshot}${TURN_CONTEXT_CLOSE}`;
    if (typeof content === 'string') return `${content}${envelope}`;
    if (Array.isArray(content)) {
        const parts = content.map(part => ({ ...part }));
        const textPart = parts.find(part => part?.type === 'text' && typeof part.text === 'string');
        if (textPart) textPart.text += envelope;
        else parts.unshift({ type: 'text', text: envelope.trimStart() });
        return parts;
    }
    return content;
}
