import { App } from '@capacitor/app';
import { Capacitor, registerPlugin } from '@capacitor/core';
import type { ActiveMsg2InboxMessage } from '../types';
import { ActiveMsgStore } from './activeMsgStore';
import { flushInboxToChat } from './activeMsgRuntime';

export const NATIVE_POLL_TOKEN_STORAGE_KEY = 'amsg2_native_poll_token_v1';
const RECEIVED_IDS_KEY = 'amsg2_native_received_ids_v1';

interface SullyAmsgPollPlugin {
  start(options: { workerUrl: string; deviceToken: string }): Promise<{ running: boolean }>;
  stop(): Promise<void>;
  status(): Promise<{ supported: boolean; running: boolean; permission: 'granted' | 'prompt' | 'denied' }>;
  drain(): Promise<{ messages: string[] }>;
}

const NativePoll = registerPlugin<SullyAmsgPollPlugin>('SullyAmsgPoll');
let initialized = false;

export const isNativeAmsgPollRuntime = () =>
  import.meta.env.VITE_AMSG_NATIVE_PUSH === 'poll' && Capacitor.isNativePlatform();

export const readNativeAmsgPollToken = () => localStorage.getItem(NATIVE_POLL_TOKEN_STORAGE_KEY)?.trim() || '';

export const ensureNativeAmsgPollToken = () => {
  const existing = readNativeAmsgPollToken();
  if (existing) return existing;
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const token = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  localStorage.setItem(NATIVE_POLL_TOKEN_STORAGE_KEY, token);
  return token;
};

const readReceivedIds = (): string[] => {
  try {
    const parsed = JSON.parse(localStorage.getItem(RECEIVED_IDS_KEY) || '[]');
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
  } catch { return []; }
};

const ingest = async (raw: string) => {
  let payload: Record<string, any>;
  try { payload = JSON.parse(raw); } catch { return; }
  const charId = payload?.metadata?.charId;
  if (typeof charId !== 'string' || !charId) return;
  const messageId = String(payload.messageId || `${charId}-${Date.now()}`);
  const received = readReceivedIds();
  if (received.includes(messageId)) return;
  const body = String(payload.message || payload.body || '').trim();
  const parsedSentAt = payload.timestamp ? new Date(payload.timestamp).getTime() : NaN;
  const inbox: ActiveMsg2InboxMessage = {
    messageId,
    charId,
    charName: String(payload.contactName || payload.metadata?.charName || '主动消息'),
    body,
    previewBody: String(payload.notification?.body || body).trim(),
    avatarUrl: payload.avatarUrl,
    source: payload.source,
    messageType: payload.messageType,
    messageSubtype: payload.messageSubtype,
    taskId: payload.taskId ?? null,
    taskUuid: payload.taskUuid ?? null,
    recurrenceType: payload.recurrenceType ?? null,
    occurrenceMs: payload.occurrenceMs ?? null,
    metadata: {
      ...(payload.metadata || {}),
      sessionId: payload.sessionId,
      messageIndex: payload.messageIndex,
      totalMessages: payload.totalMessages,
    },
    sentAt: Number.isFinite(parsedSentAt) ? parsedSentAt : Date.now(),
    receivedAt: Date.now(),
  };
  await ActiveMsgStore.saveInboxMessage(inbox);
  localStorage.setItem(RECEIVED_IDS_KEY, JSON.stringify([messageId, ...received.filter((id) => id !== messageId)].slice(0, 100)));
};

export const drainNativeAmsgPoll = async () => {
  const result = await NativePoll.drain();
  for (const raw of result.messages || []) if (typeof raw === 'string') await ingest(raw);
  await flushInboxToChat();
};

export const startNativeAmsgPoll = async (workerUrl: string) => {
  if (!isNativeAmsgPollRuntime()) throw new Error('当前不是 Android 原生轮询构建');
  const token = ensureNativeAmsgPollToken();
  await NativePoll.start({ workerUrl: workerUrl.trim(), deviceToken: token });
  return token;
};

export const getNativeAmsgPollStatus = async () => NativePoll.status();

export const initNativeAmsgPoll = async () => {
  if (initialized || !isNativeAmsgPollRuntime()) return;
  initialized = true;
  const config = await ActiveMsgStore.getGlobalConfig();
  if (config.workerUrl?.trim() && readNativeAmsgPollToken()) {
    await NativePoll.start({ workerUrl: config.workerUrl.trim(), deviceToken: readNativeAmsgPollToken() }).catch(() => undefined);
  }
  await drainNativeAmsgPoll().catch(() => undefined);
  await App.addListener('resume', () => void drainNativeAmsgPoll());
};
