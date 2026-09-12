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
import type { McpServerConfig } from '../../utils/mcpClient';
import BlobImage from './BlobImage';

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
  const currentImageSrcRef = useRef<string | null>(null);

  const close = useCallback(() => {
    currentImageSrcRef.current = null;
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
      currentImageSrcRef.current = detail.src;
      setImage(detail);
      setSourceMessage(null);
      setRegenerating(false);

      const charId = detail.charId || activeCharacterId;
      const lookup = detail.messageId != null
        ? DB.getMessage(detail.messageId as any)
        : charId
          ? DB.findImageMessageByUrl(charId, detail.src)
          : Promise.resolve(null);

      void lookup
        .then(message => {
          // 用户可能已经关掉大图或切到另一张；旧查询结果不能污染当前查看器。
          if (currentImageSrcRef.current !== detail.src) return;
          if (
            message?.role === 'assistant'
            && message.metadata?.mcpGeneratedImage === true
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

    const metadata = (sourceMessage.metadata || {}) as Record<string, any>;
    const replayArgs = metadata.imageRequestArgs;
    if (
      metadata.imageRequestVersion !== 1
      || !replayArgs
      || typeof replayArgs !== 'object'
      || Array.isArray(replayArgs)
    ) {
      addToast('这张图生成于旧版本，没有保存完整抽卡参数；请让角色重新生成一张，新图以后可以直接原样重抽', 'info');
      return;
    }

    const originalServerId = String(metadata.mcpServerId || '');
    const originalToolName = String(metadata.mcpToolName || '');
    if (!originalServerId || !originalToolName) {
      addToast('这张图缺少原始生图服务信息，无法原样重抽', 'info');
      return;
    }

    setRegenerating(true);
    try {
      // 真正的 reroll：不调用主聊天 API，也不重新计算当前预设/Vibe/参考图。
      // 只在用户点击时加载生图模块，并直接复用第一次实际发送给生图服务的最终参数快照。
      const [
        { callMcpTool, getEnabledMcpServers },
        { getImageGenerationPresets },
        {
          BUILTIN_IMAGE_MCP_REQUEST_TIMEOUT_MS,
          fetchBuiltinImageRemoteConfig,
          updateBuiltinImageRemoteConfig,
        },
        { persistMcpGeneratedImages },
      ] = await Promise.all([
        import('../../utils/mcpClient'),
        import('../../utils/imageGenerationPresets'),
        import('../../utils/builtinImageMcp'),
        import('../../utils/mcpImagePersistence'),
      ]);

      let server: McpServerConfig | null = null;
      const presetId = typeof metadata.imagePresetId === 'string'
        ? metadata.imagePresetId
        : '';

      if (presetId) {
        const preset = getImageGenerationPresets().find(item => item.id === presetId);
        if (!preset) {
          throw new Error('原图使用的生图预设已经被删除，无法保证原样重抽');
        }
        if (
          typeof metadata.imagePresetUpdatedAt !== 'number'
          || metadata.imagePresetUpdatedAt !== preset.updatedAt
        ) {
          throw new Error('原图使用的生图预设后来被修改过，无法保证原样重抽；请让角色按当前预设重新生成一张');
        }

        // 不把远端配置、API Key、Token 复制进聊天消息。
        // 预设版本没变时，用当前保存的同一预设重新写回远端配置，确保服务端也回到当时的模型配置；
        // 这不会改变本机 active preset / UI 选择。
        const binding = {
          id: preset.engineId,
          enabled: preset.binding.enabled,
          mcpUrl: preset.binding.mcpUrl,
          controlBaseUrl: preset.binding.controlBaseUrl,
          token: preset.binding.token,
          tools: preset.binding.tools,
          updatedAt: preset.updatedAt,
        };
        const currentRemote = await fetchBuiltinImageRemoteConfig(binding);
        await updateBuiltinImageRemoteConfig(binding, {
          expectedRevision: currentRemote.revision,
          patch: JSON.parse(JSON.stringify(preset.remoteConfig)),
          apiKey: preset.apiKey,
        });

        server = {
          id: `builtin_image_preset_${preset.id}`,
          name: `生图预设「${preset.name}」`,
          url: preset.binding.mcpUrl,
          controlBaseUrl: preset.binding.controlBaseUrl,
          token: preset.binding.token,
          enabled: true,
          tools: JSON.parse(JSON.stringify(preset.binding.tools)),
          updatedAt: preset.updatedAt,
          builtin: true,
          requestTimeoutMs: BUILTIN_IMAGE_MCP_REQUEST_TIMEOUT_MS,
          imagePresetId: preset.id,
          imagePresetPurpose: preset.purpose,
          imagePresetEngineId: preset.engineId,
          imagePresetAllowCharacterReference: preset.allowCharacterReference,
        };
      } else {
        // 没走生图预设的普通 MCP / 旧式内置生图，只锁回原 serverId；
        // 如果用户已经禁用或删除了那条连接，就明确失败，不偷换另一条线路。
        server = getEnabledMcpServers(charId)
          .find(item => item.id === originalServerId) || null;
      }

      if (!server) {
        throw new Error('原图使用的生图连接当前不可用，无法原样重抽');
      }
      if (!(server.tools || []).some(tool => tool.name === originalToolName)) {
        throw new Error('原图使用的生图工具当前已不存在，无法原样重抽');
      }

      const toolArgs = JSON.parse(JSON.stringify(replayArgs)) as Record<string, any>;
      delete toolArgs.after_generate_action;
      const result = await callMcpTool(server, originalToolName, toolArgs);
      if (!result.success) {
        throw new Error(result.error || '生图工具调用失败');
      }

      // meeting-cg 模式只保存二进制与相册项，不额外追加聊天楼层；
      // reroll 成功后把原楼层精确替换为新 blobRef，原始请求快照继续保留供下次再抽。
      const persisted = await persistMcpGeneratedImages({
        result,
        char: character,
        server,
        toolName: originalToolName,
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
        imageEngine: asset.engine || previous?.imageEngine,
        imagePrompt: asset.prompt || previous?.imagePrompt,
        regeneratedAt: Date.now(),
      }));

      currentImageSrcRef.current = asset.blobRef;
      setImage(current => current ? { ...current, src: asset.blobRef } : current);
      setSourceMessage(current => current ? {
        ...current,
        content: asset.blobRef,
        metadata: {
          ...(current.metadata || {}),
          galleryImageId: asset.galleryImageId,
          imageEngine: asset.engine || current.metadata?.imageEngine,
          imagePrompt: asset.prompt || current.metadata?.imagePrompt,
          regeneratedAt: Date.now(),
        },
      } : current);
      window.dispatchEvent(new CustomEvent('active-msg-progress', {
        detail: { charId },
      }));
      addToast('已按原始生图参数重新抽一张并替换原图', 'success');
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
          {regenerating ? '正在重新抽图…' : '重新生成这张图'}
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
