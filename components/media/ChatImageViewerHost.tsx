import React, {
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { ArrowClockwise, SpinnerGap, X } from '@phosphor-icons/react';

import { useOS } from '../../context/OSContext';
import type { Message } from '../../types';
import { DB } from '../../utils/db';
import {
  CHAT_IMAGE_VIEWER_CLOSE_EVENT,
  CHAT_IMAGE_VIEWER_OPEN_EVENT,
  type ChatImageViewerPayload,
} from '../../utils/chatImageViewer';
import {
  callMcpTool,
  getEnabledMcpServers,
  type McpServerConfig,
} from '../../utils/mcpClient';
import { getCharacterAutoImageMcpServers } from '../../utils/imageGenerationPresets';
import { persistMcpGeneratedImages } from '../../utils/mcpImagePersistence';
import BlobImage from './BlobImage';

const promptArgumentFor = (
  server: McpServerConfig,
  toolName: string,
  prompt: string,
): Record<string, any> => {
  const tool = (server.tools || []).find(item => item.name === toolName);
  const properties = tool?.inputSchema?.properties && typeof tool.inputSchema.properties === 'object'
    ? tool.inputSchema.properties as Record<string, unknown>
    : {};
  const candidates = [
    'prompt',
    'positive_prompt',
    'positivePrompt',
    'description',
    'tags',
    'input',
  ];
  const key = candidates.find(candidate => candidate in properties)
    || (toolName === 'novelai_generate_image' ? 'prompt' : 'prompt');
  return { [key]: prompt };
};

const ChatImageViewerHost: React.FC = () => {
  const {
    registerBackHandler,
    activeCharacterId,
    characters,
    addToast,
  } = useOS();
  const [image, setImage] =
    useState<ChatImageViewerPayload | null>(null);
  const [sourceMessage, setSourceMessage] =
    useState<Message | null>(null);
  const [regenerating, setRegenerating] = useState(false);
  const closeButtonRef =
    useRef<HTMLButtonElement | null>(null);

  const close = useCallback(() => {
    setImage(null);
    setSourceMessage(null);
    setRegenerating(false);
  }, []);

  useEffect(() => {
    const open = (event: Event) => {
      const detail =
        (event as CustomEvent<ChatImageViewerPayload>)
          .detail;
      if (!detail?.src) return;
      setImage(detail);
      setSourceMessage(null);
      setRegenerating(false);

      const charId = activeCharacterId;
      if (!charId) return;
      void DB.findImageMessageByUrl(charId, detail.src)
        .then(message => {
          if (
            message?.role === 'assistant'
            && message.metadata?.mcpGeneratedImage === true
            && typeof message.metadata?.imagePrompt === 'string'
            && message.metadata.imagePrompt.trim()
          ) {
            setSourceMessage(message);
          }
        })
        .catch(() => {
          // 大图查看本身不能因为“找不到原消息”失败；只是隐藏重生按钮。
        });
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
  }, [activeCharacterId, close]);

  const regenerateCurrentImage = useCallback(async () => {
    if (!image || !sourceMessage || regenerating) return;
    const charId = sourceMessage.charId || activeCharacterId;
    const character = characters.find(item => item.id === charId);
    if (!charId || !character) {
      addToast('找不到这张图所属的角色，暂时不能重生', 'error');
      return;
    }
    const prompt = String(sourceMessage.metadata?.imagePrompt || '').trim();
    if (!prompt) {
      addToast('这张旧图没有保存生图提示词', 'info');
      return;
    }

    setRegenerating(true);
    try {
      const configuredServers = [
        ...getCharacterAutoImageMcpServers(),
        ...getEnabledMcpServers(charId),
      ];
      const originalServerId = String(sourceMessage.metadata?.mcpServerId || '');
      const originalToolName = String(sourceMessage.metadata?.mcpToolName || '');
      const originalServer = configuredServers.find(server => server.id === originalServerId);
      const server = originalServer || configuredServers.find(server =>
        server.builtin === true
        && (server.tools || []).some(tool =>
          tool.name === originalToolName
          || tool.name === 'generate_image'
          || tool.name === 'novelai_generate_image',
        ),
      );
      if (!server) {
        throw new Error('当前没有可用的内置生图预设，请先去设置检查生图连接');
      }
      const toolName = (server.tools || []).some(tool => tool.name === originalToolName)
        ? originalToolName
        : (server.tools || []).find(tool =>
          tool.name === 'novelai_generate_image'
          || tool.name === 'generate_image')?.name;
      if (!toolName) throw new Error('当前生图预设没有可调用的生图工具');

      const toolArgs = promptArgumentFor(server, toolName, prompt);
      const result = await callMcpTool(server, toolName, toolArgs);
      if (!result.success) {
        throw new Error(result.error || '生图工具调用失败');
      }

      const persisted = await persistMcpGeneratedImages({
        result,
        char: character,
        server,
        toolName,
        toolArgs,
        ownerType: 'meeting-cg',
        allowTemporaryUrlFallback: false,
      });
      const asset = persisted.assets[0];
      if (!asset) {
        throw new Error(persisted.errors[0] || '生图成功但没有拿到可保存的图片');
      }

      await DB.updateMessage(sourceMessage.id, asset.blobRef);
      await DB.updateMessageMetadata(sourceMessage.id, previous => ({
        ...(previous || {}),
        mcpGeneratedImage: true,
        persistedLocally: true,
        temporaryRemoteUrl: false,
        galleryImageId: asset.galleryImageId,
        mcpServerId: server.id,
        mcpServerName: server.name,
        mcpToolName: toolName,
        imageEngine: asset.engine || previous?.imageEngine,
        imagePrompt: asset.prompt || prompt,
        regeneratedAt: Date.now(),
      }));

      setImage(current => current ? { ...current, src: asset.blobRef } : current);
      setSourceMessage(current => current ? {
        ...current,
        content: asset.blobRef,
        metadata: {
          ...(current.metadata || {}),
          galleryImageId: asset.galleryImageId,
          mcpServerId: server.id,
          mcpServerName: server.name,
          mcpToolName: toolName,
          imageEngine: asset.engine || current.metadata?.imageEngine,
          imagePrompt: asset.prompt || prompt,
          regeneratedAt: Date.now(),
        },
      } : current);
      window.dispatchEvent(new CustomEvent('active-msg-progress', {
        detail: { charId },
      }));
      addToast('这张图已经重新生成并替换原图', 'success');
    } catch (error: any) {
      addToast(error?.message || '重新生成这张图失败', 'error');
    } finally {
      setRegenerating(false);
    }
  }, [
    activeCharacterId,
    addToast,
    characters,
    image,
    regenerating,
    sourceMessage,
  ]);

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

      {sourceMessage && (
        <button
          type="button"
          disabled={regenerating}
          onClick={(event) => {
            event.stopPropagation();
            void regenerateCurrentImage();
          }}
          className="absolute left-1/2 z-10 inline-flex -translate-x-1/2 items-center gap-2 rounded-full bg-black/55 px-4 py-2 text-xs font-bold text-white backdrop-blur disabled:opacity-60 active:scale-95"
          style={{ bottom: 'calc(var(--safe-bottom, 0px) + 18px)' }}
        >
          {regenerating
            ? <SpinnerGap size={16} className="animate-spin" />
            : <ArrowClockwise size={16} weight="bold" />}
          {regenerating ? '正在重生这张图…' : '重新生成这张图'}
        </button>
      )}

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
