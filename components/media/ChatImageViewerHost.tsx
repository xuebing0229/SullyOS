import React, {
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { X } from '@phosphor-icons/react';

import { useOS } from '../../context/OSContext';
import {
  CHAT_IMAGE_VIEWER_CLOSE_EVENT,
  CHAT_IMAGE_VIEWER_OPEN_EVENT,
  type ChatImageViewerPayload,
} from '../../utils/chatImageViewer';
import BlobImage from './BlobImage';

const ChatImageViewerHost: React.FC = () => {
  const { registerBackHandler } = useOS();
  const [image, setImage] =
    useState<ChatImageViewerPayload | null>(null);
  const closeButtonRef =
    useRef<HTMLButtonElement | null>(null);

  const close = useCallback(() => {
    setImage(null);
  }, []);

  useEffect(() => {
    const open = (event: Event) => {
      const detail =
        (event as CustomEvent<ChatImageViewerPayload>)
          .detail;
      if (!detail?.src) return;
      setImage(detail);
    };

    window.addEventListener(
      CHAT_IMAGE_VIEWER_OPEN_EVENT,
      open,
    );
    window.addEventListener(
      CHAT_IMAGE_VIEWER_CLOSE_EVENT,
      close,
    );

    return () => {
      window.removeEventListener(
        CHAT_IMAGE_VIEWER_OPEN_EVENT,
        open,
      );
      window.removeEventListener(
        CHAT_IMAGE_VIEWER_CLOSE_EVENT,
        close,
      );
    };
  }, [close]);

  useEffect(() => {
    if (!image) return;

    // 只锁页面外层滚动；聊天列表组件仍保持原 scrollTop。
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const unregister = registerBackHandler(() => {
      close();
      return true;
    });

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      close();
    };
    window.addEventListener('keydown', onKeyDown);

    requestAnimationFrame(() => {
      closeButtonRef.current?.focus();
    });

    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', onKeyDown);
      unregister?.();
    };
  }, [close, image, registerBackHandler]);

  if (!image) return null;

  return (
    <div
      className="fixed inset-0 z-[220] flex items-center justify-center bg-black/95 animate-fade-in"
      role="dialog"
      aria-modal="true"
      aria-label="查看大图"
      onClick={close}
      data-chat-image-viewer="open"
    >
      <button
        ref={closeButtonRef}
        type="button"
        aria-label="关闭大图"
        onClick={(event) => {
          event.stopPropagation();
          close();
        }}
        className="absolute right-3 z-10 grid h-10 w-10 place-items-center rounded-full bg-black/45 text-white backdrop-blur active:scale-95"
        style={{ top: 'calc(var(--safe-top, 0px) + 10px)' }}
      >
        <X size={24} weight="bold" />
      </button>

      <div className="pointer-events-none flex h-full w-full items-center justify-center px-2 py-16">
        <div
          className="pointer-events-auto flex max-h-full max-w-full items-center justify-center"
          onClick={(event) => event.stopPropagation()}
        >
          <BlobImage
            src={image.src}
            alt={image.alt || '聊天图片大图'}
            draggable={false}
            decoding="async"
            className="max-h-[calc(100vh-8rem)] max-w-[calc(100vw-1rem)] select-none object-contain"
            fallback={(
              <div className="rounded-2xl bg-white/10 px-6 py-8 text-sm text-white/60">
                图片已丢失
              </div>
            )}
          />
        </div>
      </div>
    </div>
  );
};

export default ChatImageViewerHost;
