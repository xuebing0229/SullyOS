import { App } from '@capacitor/app';
import { Capacitor, registerPlugin } from '@capacitor/core';

import { CHAT_GEN_EVENTS } from './chatGenEvents';
import {
  AMSG_INSTANT_CHAT_PENDING_EVENT,
  getInstantChatPending,
  listInstantChatPendings,
} from './amsgInstantChat';

const STORAGE_KEY = 'sully_chat_floating_enabled_v1';
export const CHAT_FLOATING_SETTING_EVENT = 'sully-chat-floating-setting-changed';

type ChatFloatingPhase = 'waiting' | 'thinking' | 'writing' | 'tool' | 'cloud';

interface ChatFloatingPlugin {
  chatFloatingStatus(): Promise<{ overlayGranted: boolean }>;
  requestChatFloatingPermission(): Promise<void>;
  startChatFloating(options: {
    generationId: string;
    title: string;
    phase: ChatFloatingPhase;
    preview?: string;
    appForeground: boolean;
  }): Promise<void>;
  updateChatFloating(options: {
    generationId: string;
    title?: string;
    phase: ChatFloatingPhase;
    preview?: string;
  }): Promise<void>;
  finishChatFloating(options: {
    generationId: string;
    title?: string;
    success: boolean;
    error?: string;
  }): Promise<void>;
  releaseChatFloating(options: { generationId: string }): Promise<void>;
  setChatFloatingAppForeground(options: { foreground: boolean }): Promise<void>;
}

const NativeStoryBackground = registerPlugin<ChatFloatingPlugin>('SullyStoryBackground');

let installed = false;
let appForeground = typeof document === 'undefined' ? true : !document.hidden;
const activeIds = new Set<string>();
let knownInstantChars = new Set<string>();
const instantReceived = new Map<string, { charName: string; preview: string }>();

const isNativeAndroid = (): boolean =>
  Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';

const generationId = (charId: string): string =>
  `chat:${String(charId || '').replace(/[^A-Za-z0-9:_-]/g, '_').slice(0, 140)}`;

const cleanPreview = (value: unknown): string => {
  const text = typeof value === 'string' ? value.trim() : '';
  return text.length > 6000 ? text.slice(-6000) : text;
};

export const isChatFloatingEnabled = (): boolean => {
  try { return localStorage.getItem(STORAGE_KEY) === '1'; }
  catch { return false; }
};

export const setChatFloatingEnabled = (enabled: boolean): void => {
  try {
    if (enabled) localStorage.setItem(STORAGE_KEY, '1');
    else localStorage.removeItem(STORAGE_KEY);
  } catch { /* best effort */ }
  if (!enabled && isNativeAndroid()) {
    for (const id of activeIds) void NativeStoryBackground.releaseChatFloating({ generationId: id }).catch(() => {});
    activeIds.clear();
  }
  try {
    window.dispatchEvent(new CustomEvent(CHAT_FLOATING_SETTING_EVENT, { detail: { enabled } }));
  } catch { /* SSR */ }
};

export const getChatFloatingPermission = async (): Promise<boolean> => {
  if (!isNativeAndroid()) return false;
  try { return (await NativeStoryBackground.chatFloatingStatus()).overlayGranted === true; }
  catch { return false; }
};

export const requestChatFloatingPermission = async (): Promise<void> => {
  if (!isNativeAndroid()) return;
  await NativeStoryBackground.requestChatFloatingPermission();
};

const start = (charId: string, charName: string, phase: ChatFloatingPhase, preview = '') => {
  if (!isNativeAndroid() || !isChatFloatingEnabled() || !charId) return;
  const id = generationId(charId);
  activeIds.add(id);
  void NativeStoryBackground.startChatFloating({
    generationId: id,
    title: charName || '聊天',
    phase,
    preview: cleanPreview(preview),
    appForeground,
  }).catch(error => console.warn('[ChatFloating] start failed', error));
};

const update = (charId: string, charName: string, phase: ChatFloatingPhase, preview = '') => {
  if (!isNativeAndroid() || !isChatFloatingEnabled() || !charId) return;
  const id = generationId(charId);
  if (!activeIds.has(id)) {
    start(charId, charName, phase, preview);
    return;
  }
  void NativeStoryBackground.updateChatFloating({
    generationId: id,
    title: charName || '聊天',
    phase,
    preview: cleanPreview(preview),
  }).catch(() => {});
};

const finish = (charId: string, charName: string, preview = '') => {
  if (!isNativeAndroid() || !isChatFloatingEnabled() || !charId) return;
  const id = generationId(charId);
  if (!activeIds.has(id)) start(charId, charName, 'writing', preview);
  void NativeStoryBackground.finishChatFloating({
    generationId: id,
    title: charName || '聊天',
    success: true,
  }).catch(() => {});
};

const release = (charId: string) => {
  if (!isNativeAndroid() || !charId) return;
  const id = generationId(charId);
  activeIds.delete(id);
  void NativeStoryBackground.releaseChatFloating({ generationId: id }).catch(() => {});
};

const syncInstantPendings = () => {
  if (!isNativeAndroid() || !isChatFloatingEnabled()) return;
  const pendings = listInstantChatPendings();
  const nextChars = new Set(pendings.map(item => item.charId));
  for (const item of pendings) {
    update(item.charId, item.charName || '', 'cloud', '回复已交给云端，正在生成…');
  }
  for (const oldCharId of knownInstantChars) {
    if (nextChars.has(oldCharId)) continue;
    const received = instantReceived.get(oldCharId);
    if (received) {
      finish(oldCharId, received.charName, received.preview);
      instantReceived.delete(oldCharId);
    }
    release(oldCharId);
  }
  knownInstantChars = nextChars;
};

export const installNativeChatFloatingBridge = (): (() => void) => {
  if (installed || typeof window === 'undefined') return () => {};
  installed = true;

  const onReplyStart = (event: Event) => {
    const detail = (event as CustomEvent).detail || {};
    start(detail.charId, detail.charName, 'waiting', '');
  };
  const onReplyProgress = (event: Event) => {
    const detail = (event as CustomEvent).detail || {};
    const phase: ChatFloatingPhase = ['thinking', 'writing', 'tool', 'cloud'].includes(detail.phase)
      ? detail.phase
      : 'waiting';
    update(detail.charId, detail.charName, phase, detail.preview || '');
  };
  const onReplyArrived = (event: Event) => {
    const detail = (event as CustomEvent).detail || {};
    finish(detail.charId, detail.charName, detail.preview || '');
  };
  const onReplyEnd = (event: Event) => {
    const detail = (event as CustomEvent).detail || {};
    if (!detail.charId) return;
    const pending = getInstantChatPending(detail.charId);
    if (pending) {
      update(detail.charId, pending.charName || detail.charName || '', 'cloud', '回复已交给云端，正在生成…');
    } else {
      release(detail.charId);
    }
  };
  const onActiveMessage = (event: Event) => {
    const detail = (event as CustomEvent).detail || {};
    if (!detail.charId || !getInstantChatPending(detail.charId)) return;
    const preview = cleanPreview(detail.body || '');
    instantReceived.set(detail.charId, { charName: detail.charName || '', preview });
    update(detail.charId, detail.charName || '', 'writing', preview);
  };
  const onPendingChanged = () => syncInstantPendings();
  const onSettingChanged = () => {
    if (isChatFloatingEnabled()) syncInstantPendings();
    else {
      for (const id of [...activeIds]) {
        void NativeStoryBackground.releaseChatFloating({ generationId: id }).catch(() => {});
      }
      activeIds.clear();
    }
  };

  window.addEventListener(CHAT_GEN_EVENTS.replyStart, onReplyStart);
  window.addEventListener(CHAT_GEN_EVENTS.replyProgress, onReplyProgress);
  window.addEventListener(CHAT_GEN_EVENTS.replyArrived, onReplyArrived);
  window.addEventListener(CHAT_GEN_EVENTS.replyEnd, onReplyEnd);
  window.addEventListener('active-msg-received', onActiveMessage);
  window.addEventListener(AMSG_INSTANT_CHAT_PENDING_EVENT, onPendingChanged);
  window.addEventListener(CHAT_FLOATING_SETTING_EVENT, onSettingChanged);

  let appStateHandle: { remove: () => Promise<void> } | null = null;
  void App.addListener('appStateChange', ({ isActive }) => {
    appForeground = isActive;
    if (isNativeAndroid() && isChatFloatingEnabled()) {
      void NativeStoryBackground.setChatFloatingAppForeground({ foreground: isActive }).catch(() => {});
      if (!isActive) syncInstantPendings();
    }
  }).then(handle => { appStateHandle = handle; }).catch(() => {});

  if (isChatFloatingEnabled()) syncInstantPendings();

  return () => {
    window.removeEventListener(CHAT_GEN_EVENTS.replyStart, onReplyStart);
    window.removeEventListener(CHAT_GEN_EVENTS.replyProgress, onReplyProgress);
    window.removeEventListener(CHAT_GEN_EVENTS.replyArrived, onReplyArrived);
    window.removeEventListener(CHAT_GEN_EVENTS.replyEnd, onReplyEnd);
    window.removeEventListener('active-msg-received', onActiveMessage);
    window.removeEventListener(AMSG_INSTANT_CHAT_PENDING_EVENT, onPendingChanged);
    window.removeEventListener(CHAT_FLOATING_SETTING_EVENT, onSettingChanged);
    void appStateHandle?.remove();
    installed = false;
  };
};
