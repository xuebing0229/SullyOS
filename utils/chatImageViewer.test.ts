import {
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import {
  CHAT_IMAGE_VIEWER_OPEN_EVENT,
  closeChatImageViewer,
  openChatImageViewer,
} from './chatImageViewer';

describe('chatImageViewer event bridge', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.stubGlobal('window', new EventTarget());
    if (typeof CustomEvent === 'undefined') {
      class TestCustomEvent<T = unknown> extends Event {
        detail: T;
        constructor(type: string, init?: CustomEventInit<T>) {
          super(type);
          this.detail = init?.detail as T;
        }
      }
      vi.stubGlobal('CustomEvent', TestCustomEvent);
    }
  });

  it('dispatches a normalized image payload', () => {
    const listener = vi.fn();
    window.addEventListener(
      CHAT_IMAGE_VIEWER_OPEN_EVENT,
      listener,
    );

    expect(openChatImageViewer({
      src: '  blobref:image-1  ',
      alt: '图片',
      messageId: 10,
      charId: 'char-1',
    })).toBe(true);

    expect(listener).toHaveBeenCalledTimes(1);
    const event = listener.mock.calls[0][0] as CustomEvent;
    expect(event.detail).toEqual({
      src: 'blobref:image-1',
      alt: '图片',
      messageId: 10,
      charId: 'char-1',
    });

    window.removeEventListener(
      CHAT_IMAGE_VIEWER_OPEN_EVENT,
      listener,
    );
  });

  it('refuses an empty source', () => {
    expect(openChatImageViewer({ src: '   ' }))
      .toBe(false);
  });

  it('can dispatch a close event without throwing', () => {
    expect(() => closeChatImageViewer())
      .not.toThrow();
  });
});
