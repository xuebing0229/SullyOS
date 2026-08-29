// Fork-only public type declarations kept beside the upstream type surface.
import type { APIConfig, ActiveMsg2ApiConfig, ActiveMsg2CharacterConfig, ActiveMsg2ExpirePolicy, ActiveMsg2GlobalConfig, ActiveMsg2InboxMessage, ActiveMsg2Mode, ActiveMsg2Recurrence, ActiveMsg2TaskRecord, ActiveMsg2TaskSource, ActiveMsg2TaskStatus, AiServiceKind, AiSession, Amsg2ExpiredNoticeRecord, Anniversary, ApiPreset, AppConfig, AppID, AppearancePreset, AvatarTouchRegion, BankConfig, BankFullState, BankGuestbookItem, BankShopState, BankTransaction, BubbleStyle, CharCurrentListening, CharMusicProfile, CharMusicReview, CharNarrative, CharPlayRecord, CharPlaylist, CharPlaylistSong, CharacterAccommodationPolicy, CharacterBuff, CharacterExportData, CharacterGroup, CharacterProfile, ChatFineTuneFields, ChatFineTuneOverride, ChatLayoutPreset, ChatTheme, ChibiStudioData, ChibiStudioSlot, ChibiStudioSlotId, ChordInfo, CloudBackupConfig, CloudBackupFile, CloudBackupProvider, CompanionAvatarConfig, CompanionPerformancePrecision, CompanionStartupPreset, CompanionStartupSettings, CompanionTouchPreset, CompanionTouchReaction, CompanionTouchSettings, CompanionTouchZone, ConvTopic, CustomCreatorPart, DailySchedule, DateObservation, DateObserveConfig, DateObserveCustomField, DateObserveFieldConfig, DateObserveStyleId, DateState, DateStyleConfig, DesktopDecoration, DialogueItem, DiaryEntry, DiaryPage, DollhouseRoom, DollhouseState, DollhouseSticker, DreamArchetype, DreamFragment, DreamFragmentKind, DreamLog, DreamScript, Emoji, EmojiCategory, FullBackupData, GalleryImage, GameActionOption, GameLog, GameSession, GameSummary, GameTheme, GroupProfile, GroupTopicBox, GuidebookEndCard, GuidebookOption, GuidebookRound, GuidebookSession, HandbookEntry, HandbookFragment, HandbookLayout, HandbookPage, HandbookPageType, HotNewsItem, HotNewsSnapshot, InstantOversizeTransport, InstantPushConfig, InstantPushOutboundSession, InstantPushPendingToolCall, InstantPushReasoningBufferEntry, JournalAppearance, JournalAppearancePresetId, LayoutPlacement, LayoutRole, LayoutTemplate, LifeRecord, LifeRecordModule, LifeRecordSettings, LifeSimState, LyricCoWritingStyle, MedPlan, MelodyNote, MemoryFragment, MemoryPalaceBackupConfig, MemoryPalaceFeatureFlags, MemoryPalaceWaterlineConfig, MemoryPalaceWaterlinePreset, Message, MessageType, MinimaxRegion, MountedWorldbook, MusicProvider, NPCDesire, NovelBook, NovelProtagonist, NovelSegment, OSTheme, OfflineRecapEvent, PhoneContact, PhoneCustomApp, PhoneEvidence, PhoneSimLog, QuizQuestion, QuizQuestionNote, QuizSession, RealtimeConfig, RoomGeneratedState, RoomItem, RoomLayout, RoomNote, RoomTodo, SavingsGoal, ScheduleCardAppearance, ScheduleCardPresetId, ScheduleSlot, SectionArrangement, ShopRecipe, ShopStaff, SignalBooklet, SignalPoem, SignalPoemLine, SimAction, SimActionType, SimActivity, SimBeat, SimBeatKind, SimBuilding, SimEffectCode, SimEventType, SimFamily, SimFestival, SimGender, SimNPC, SimPendingEffect, SimProfession, SimScript, SimSeason, SimSkills, SimStoryAttachment, SimStoryAttachmentDraft, SimStoryAttachmentKind, SimStoryAttachmentRarity, SimStoryKind, SimTimeOfDay, SimWeather, SkinSet, SlotAuthorKind, SlotDef, SlotPayload, SlotRole, SlotTheater, SocialAppProfile, SocialComment, SocialPost, SongArrangement, SongAudio, SongComment, SongGenre, SongLine, SongMood, SongSheet, SongTemplateSection, SpecialMomentRecord, SpriteConfig, StickerData, StoryTheaterArchive, StoryTheaterArchiveStrategy, StoryTheaterEntry, StoryTheaterMask, StoryTheaterMaskSelection, StoryTheaterPreset, StoryTheaterPresetDocument, StoryTheaterPresetPrompt, StudyChapter, StudyCourse, StudyTutorPreset, SubAccount, SystemLog, Task, TavernCard, TheaterLine, Toast, Tracker, TrackerEntry, TrackerField, TrackerFieldKind, TranslationConfig, TtsProvider, UserImpression, UserProfile, UserVRState, VRActorNote, VRCardMeta, VRCastAssign, VRGuestbookMessage, VRGuestbookState, VRLetter, VRLetterReply, VRMusicQueueItem, VRMusicRoomState, VRNovelAnnotation, VRNovelSegment, VRPlayRole, VRRoomId, VRScript, VRStageLine, VRStageMode, VRStagedPlay, VRWorldCharState, VRWorldNovel, VirtualTime, VisionApiConfig, WorldCardMeta, WorldChapter, WorldCharBeat, WorldChatMessage, WorldDirective, WorldEpisode, WorldHomeMode, WorldHouse, WorldNPC, WorldNarrativeStyle, WorldProfile, WorldRelationship, WorldSeed, WorldSimDate, WorldThread, WorldTimeMode, Worldbook, WorldbookDepthRole, WorldbookEntryConfig, WorldbookPosition, WorldbookSelectiveLogic, XhsActionType, XhsActivityRecord, XhsFreeRoamSession, XhsMcpConfig, XhsOwnedPost, XhsStockImage } from './types';

export type ActiveMsg2DbDriver = 'pg' | 'neon';

export type ApiPricing =
  | { mode: 'per_request'; pricePerRequestYuan: string }
  | {
      mode: 'per_token';
      inputYuanPerMillion: string;
      cacheWriteYuanPerMillion: string;
      cacheReadYuanPerMillion: string;
      outputYuanPerMillion: string;
    };

export interface ApiBillingUsage {
  inputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  usageAvailable: boolean;
}

export interface ApiPricingSnapshot {
  presetId: string;
  presetName: string;
  pricing: ApiPricing;
}

export type ApiCallCostStatus =
  | 'priced'
  | 'free_local_cache'
  | 'free_failed'
  | 'unpriced'
  | 'ignored_unpriced';

export type ApiCallUnpricedReason =
  | 'preset_not_found'
  | 'preset_ambiguous'
  | 'pricing_not_configured'
  | 'usage_missing'
  | 'failure_cost_unknown'
  | 'legacy_unknown';

export type ApiCostUnresolvedKind = 'call' | 'legacy_aggregate';

export interface ApiCostUnresolvedEntry {
  id: string;
  kind: ApiCostUnresolvedKind;
  sourceEntryId?: string;
  timestamp: number;
  dateKey: string;
  callCount: number;
  presetId?: string;
  presetName: string;
  baseUrl?: string;
  model?: string;
  appId?: string;
  appName?: string;
  purpose?: string;
  charId?: string;
  charName?: string;
  reason: ApiCallUnpricedReason;
  billingUsage?: ApiBillingUsage;
  pricingSnapshot?: ApiPricingSnapshot;
  createdAt: number;
  updatedAt: number;
}

export type ApiCostResolution =
  | { kind: 'ignore_zero'; resolvedAt?: number }
  | { kind: 'manual_cost'; costMicros: string; resolvedAt?: number }
  | { kind: 'pricing_backfill'; costMicros: string; pricingSnapshot: ApiPricingSnapshot; resolvedAt?: number };

export interface ApiCostBucket {
  key: string;
  label: string;
  costMicros: string;
  callCount: number;
}

export interface ApiCostDailySummary {
  dateKey: string;
  totalCostMicros: string;
  pricedCallCount: number;
  freeCallCount: number;
  unpricedCallCount: number;
  ignoredCallCount: number;
  byPreset: ApiCostBucket[];
  byApp: ApiCostBucket[];
  byPurpose: ApiCostBucket[];
  updatedAt: number;
}

export interface ApiCostOverview {
  todayCostMicros: string;
  monthCostMicros: string;
  totalCostMicros: string;
  todayPricedCalls: number;
  todayFreeCalls: number;
  todayUnpricedCalls: number;
  totalUnpricedCalls: number;
}

export type VRAutonomousRoomId = Exclude<VRRoomId, 'signal' | 'cafe'>;

export type VRAutonomousRoomMode = 'free' | 'selected';

export type NovelAiReferenceType = 'character' | 'style' | 'character&style';

export interface NovelAiPreciseReferenceConfig {
  enabled: boolean;
  imageRef: string;
  imageSha256: string;
  slotId: string;
  type: NovelAiReferenceType;
  strength: number;
  fidelity: number;
  sourceName?: string;
  updatedAt: number;
}

export type AppMemorySource = 'simulator' | 'reading_together';

export type AppMemoryCandidateStatus = 'pending' | 'committed' | 'dismissed';

export interface AppMemoryCandidate {
  id: string;
  charId: string;
  sourceApp: AppMemorySource;
  sourceRecordId: string;
  title: string;
  summary: string;
  room:
    | 'living_room'
    | 'bedroom'
    | 'study'
    | 'user_room'
    | 'self_room'
    | 'attic'
    | 'windowsill';
  tags: string[];
  importance: number; // 1..10
  mood: string;
  valence?: number;   // -1..1
  arousal?: number;   // -1..1
  status: AppMemoryCandidateStatus;
  createdAt: number;
  updatedAt: number;
  committedAt?: number;
  memoryNodeId?: string;
  chatMessageId?: number;
}

export type SimulatorMode = 'html' | 'text' | 'hybrid' | 'frontend_ai';

export interface SimulatorProject {
  id: string;
  name: string;
  description?: string;
  mode: SimulatorMode;
  charId: string;
  html: string;
  prompt: string;
  breaker?: string;
  worldbookEnabled: boolean;
  regexEnabled: boolean;
  mainContextEnabled: boolean;
  localContextLimit: number;
  createdAt: number;
  updatedAt: number;
}

export interface SimulatorTurn {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  action?: string;
  payload?: unknown;
  createdAt: number;
}

export interface SimulatorSession {
  id: string;
  projectId: string;
  charId: string;
  status: 'active' | 'ended';
  turns: SimulatorTurn[];
  frontendState?: unknown;
  createdAt: number;
  updatedAt: number;
  endedAt?: number;
}

export interface ReadingSegment {
  id: string;
  index: number;
  text: string;
  chars: number;
}

export interface ReadingProject {
  id: string;
  title: string;
  sourceName: string;
  format: 'txt' | 'md';
  charId: string;
  segments: ReadingSegment[];
  progressIndex: number;
  stylePresetId?: string;
  localContextLimit: number;
  createdAt: number;
  updatedAt: number;
}

export type ReadingRecordType =
  | 'annotation'
  | 'inner_voice'
  | 'question'
  | 'answer'
  | 'user_note';

export interface ReadingRecord {
  id: string;
  projectId: string;
  segmentId: string;
  charId: string;
  type: ReadingRecordType;
  role: 'user' | 'assistant';
  content: string;
  createdAt: number;
}

export type ReadingWritingType = 'free' | 'user_char_story' | 'continue';

export interface ReadingWriting {
  id: string;
  projectId?: string;
  charId: string;
  type: ReadingWritingType;
  title: string;
  prompt: string;
  content: string;
  stylePresetId?: string;
  createdAt: number;
  updatedAt: number;
}

export interface ReadingStylePreset {
  id: string;
  name: string;
  prompt: string;
  target: 'all' | 'reading' | 'writing';
  createdAt: number;
  updatedAt: number;
}
