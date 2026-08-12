export type LiveEventType = 'visual' | 'danmu' | 'gift' | 'mic' | 'system';

export interface LiveEvent {
  id: string;
  roomId: string;
  time: number;
  type: LiveEventType;
  content: string;
  user?: string;
  origin: 'ai' | 'user' | 'system';
  createdAt: number;
}

export interface LiveRankEntry {
  id: string;
  name: string;
  avatar?: string;
  score: number;
  isUser?: boolean;
  characterId?: string;
}

export interface LiveRoom {
  id: string;
  kind: 'recommend' | 'following' | 'mine';
  characterId?: string;
  streamerName: string;
  streamerAvatar?: string;
  title: string;
  category: string;
  coverText: string;
  viewerCount: number;
  followed?: boolean;
  status: 'preview' | 'live' | 'paused' | 'ended';
  rank: LiveRankEntry[];
  currentTime: number;
  duration: number;
  createdAt: number;
  updatedAt: number;
}

export interface LiveSettings {
  id: 'main';
  duration: number;
  danmuDensity: 'low' | 'medium' | 'high';
  speed: number;
  recommendWorldview: string;
  followingWorldview: string;
  globalPrompt: string;
  profileName: string;
  profileAvatar?: string;
  followingCharacterIds: string[];
  walletBalance: number;
  updatedAt: number;
}

export interface LiveSession {
  id: string;
  roomId: string;
  mode: 'viewer' | 'host';
  title: string;
  characterId?: string;
  status: 'paused' | 'ended';
  currentTime: number;
  createdAt: number;
  updatedAt: number;
  endedAt?: number;
}

export interface LiveGift {
  id: string;
  name: string;
  emoji: string;
  price: number;
}

export const LIVE_GIFTS: LiveGift[] = [
  { id: 'heart', name: '小心心', emoji: '❤️', price: 10 },
  { id: 'flower', name: '鲜花', emoji: '🌹', price: 30 },
  { id: 'coffee', name: '咖啡', emoji: '☕', price: 88 },
  { id: 'cake', name: '蛋糕', emoji: '🎂', price: 188 },
  { id: 'rocket', name: '火箭', emoji: '🚀', price: 520 },
  { id: 'castle', name: '梦幻城堡', emoji: '🏰', price: 1314 },
];

export const defaultLiveSettings = (): LiveSettings => ({
  id: 'main',
  duration: 90,
  danmuDensity: 'medium',
  speed: 1,
  recommendWorldview: '',
  followingWorldview: '',
  globalPrompt: '',
  profileName: '',
  followingCharacterIds: [],
  walletBalance: 5000,
  updatedAt: Date.now(),
});

export const liveId = (prefix: string): string =>
  `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
