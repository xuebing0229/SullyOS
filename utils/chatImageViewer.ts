export const CHAT_IMAGE_VIEWER_OPEN_EVENT =
  'sullyos:chat-image-viewer-open';

export const CHAT_IMAGE_VIEWER_CLOSE_EVENT =
  'sullyos:chat-image-viewer-close';

export interface ChatImageViewerPayload {
  src: string;
  alt?: string;
  messageId?: number | string;
  charId?: string;
}

const normalizePayload = (
  payload: ChatImageViewerPayload,
): ChatImageViewerPayload | null => {
  const src = String(payload?.src || '').trim();
  if (!src) return null;

  return {
    src,
    alt:
      typeof payload.alt === 'string'
        ? payload.alt
        : undefined,
    messageId: payload.messageId,
    charId:
      typeof payload.charId === 'string'
        ? payload.charId
        : undefined,
  };
};

export function openChatImageViewer(
  payload: ChatImageViewerPayload,
): boolean {
  const normalized = normalizePayload(payload);
  if (!normalized) return false;

  try {
    window.dispatchEvent(
      new CustomEvent<ChatImageViewerPayload>(
        CHAT_IMAGE_VIEWER_OPEN_EVENT,
        { detail: normalized },
      ),
    );
    return true;
  } catch {
    return false;
  }
}

export function closeChatImageViewer(): void {
  try {
    window.dispatchEvent(
      new CustomEvent(
        CHAT_IMAGE_VIEWER_CLOSE_EVENT,
      ),
    );
  } catch {
    // SSR / tests
  }
}
