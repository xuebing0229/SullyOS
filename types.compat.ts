// Generated once during the upstream merge from fork-only members of shared interfaces.
// Keep this as the explicit compatibility boundary between the two type surfaces.
import type { APIConfig, ActiveMsg2ApiConfig, ActiveMsg2CharacterConfig, ActiveMsg2DbDriver, ActiveMsg2ExpirePolicy, ActiveMsg2GlobalConfig, ActiveMsg2InboxMessage, ActiveMsg2Mode, ActiveMsg2Recurrence, ActiveMsg2TaskRecord, ActiveMsg2TaskSource, ActiveMsg2TaskStatus, AiServiceKind, AiSession, Amsg2ExpiredNoticeRecord, Anniversary, ApiBillingUsage, ApiCallCostStatus, ApiCallUnpricedReason, ApiCostBucket, ApiCostDailySummary, ApiCostOverview, ApiCostResolution, ApiCostUnresolvedEntry, ApiCostUnresolvedKind, ApiPreset, ApiPricing, ApiPricingSnapshot, AppConfig, AppID, AppMemoryCandidate, AppMemoryCandidateStatus, AppMemorySource, AppearancePreset, AvatarTouchRegion, BankConfig, BankFullState, BankGuestbookItem, BankShopState, BankTransaction, BubbleStyle, CharCurrentListening, CharMusicProfile, CharMusicReview, CharNarrative, CharPlayRecord, CharPlaylist, CharPlaylistSong, CharacterAccommodationPolicy, CharacterBuff, CharacterExportData, CharacterGroup, CharacterProfile, ChatFineTuneFields, ChatFineTuneOverride, ChatLayoutPreset, ChatTheme, ChibiStudioData, ChibiStudioSlot, ChibiStudioSlotId, ChordInfo, CloudBackupConfig, CloudBackupFile, CloudBackupProvider, CompanionAvatarConfig, CompanionPerformancePrecision, CompanionStartupPreset, CompanionStartupSettings, CompanionTouchPreset, CompanionTouchReaction, CompanionTouchSettings, CompanionTouchZone, ConvTopic, CustomCreatorPart, DailySchedule, DateObservation, DateObserveConfig, DateObserveCustomField, DateObserveFieldConfig, DateObserveStyleId, DateState, DateStyleConfig, DesktopDecoration, DialogueItem, DiaryEntry, DiaryPage, DollhouseRoom, DollhouseState, DollhouseSticker, DreamArchetype, DreamFragment, DreamFragmentKind, DreamLog, DreamScript, Emoji, EmojiCategory, FullBackupData, GalleryImage, GameActionOption, GameLog, GameSession, GameSummary, GameTheme, GroupProfile, GroupTopicBox, GuidebookEndCard, GuidebookOption, GuidebookRound, GuidebookSession, HandbookEntry, HandbookFragment, HandbookLayout, HandbookPage, HandbookPageType, HotNewsItem, HotNewsSnapshot, InstantOversizeTransport, InstantPushConfig, InstantPushOutboundSession, InstantPushPendingToolCall, InstantPushReasoningBufferEntry, JournalAppearance, JournalAppearancePresetId, LayoutPlacement, LayoutRole, LayoutTemplate, LifeRecord, LifeRecordModule, LifeRecordSettings, LifeSimState, LyricCoWritingStyle, MedPlan, MelodyNote, MemoryFragment, MemoryPalaceBackupConfig, MemoryPalaceFeatureFlags, MemoryPalaceWaterlineConfig, MemoryPalaceWaterlinePreset, Message, MessageType, MinimaxRegion, MountedWorldbook, MusicProvider, NPCDesire, NovelAiPreciseReferenceConfig, NovelAiReferenceType, NovelBook, NovelProtagonist, NovelSegment, OSTheme, OfflineRecapEvent, PhoneContact, PhoneCustomApp, PhoneEvidence, PhoneSimLog, QuizQuestion, QuizQuestionNote, QuizSession, ReadingProject, ReadingRecord, ReadingRecordType, ReadingSegment, ReadingStylePreset, ReadingWriting, ReadingWritingType, RealtimeConfig, RoomGeneratedState, RoomItem, RoomLayout, RoomNote, RoomTodo, SavingsGoal, ScheduleCardAppearance, ScheduleCardPresetId, ScheduleSlot, SectionArrangement, ShopRecipe, ShopStaff, SignalBooklet, SignalPoem, SignalPoemLine, SimAction, SimActionType, SimActivity, SimBeat, SimBeatKind, SimBuilding, SimEffectCode, SimEventType, SimFamily, SimFestival, SimGender, SimNPC, SimPendingEffect, SimProfession, SimScript, SimSeason, SimSkills, SimStoryAttachment, SimStoryAttachmentDraft, SimStoryAttachmentKind, SimStoryAttachmentRarity, SimStoryKind, SimTimeOfDay, SimWeather, SimulatorMode, SimulatorProject, SimulatorSession, SimulatorTurn, SkinSet, SlotAuthorKind, SlotDef, SlotPayload, SlotRole, SlotTheater, SocialAppProfile, SocialComment, SocialPost, SongArrangement, SongAudio, SongComment, SongGenre, SongLine, SongMood, SongSheet, SongTemplateSection, SpecialMomentRecord, SpriteConfig, StickerData, StoryTheaterArchive, StoryTheaterArchiveStrategy, StoryTheaterEntry, StoryTheaterMask, StoryTheaterMaskSelection, StoryTheaterPreset, StoryTheaterPresetDocument, StoryTheaterPresetPrompt, StudyChapter, StudyCourse, StudyTutorPreset, SubAccount, SystemLog, Task, TavernCard, TheaterLine, Toast, Tracker, TrackerEntry, TrackerField, TrackerFieldKind, TranslationConfig, TtsProvider, UserImpression, UserProfile, UserVRState, VRActorNote, VRAutonomousRoomId, VRAutonomousRoomMode, VRCardMeta, VRCastAssign, VRGuestbookMessage, VRGuestbookState, VRLetter, VRLetterReply, VRMusicQueueItem, VRMusicRoomState, VRNovelAnnotation, VRNovelSegment, VRPlayRole, VRRoomId, VRScript, VRStageLine, VRStageMode, VRStagedPlay, VRWorldCharState, VRWorldNovel, VirtualTime, VisionApiConfig, WorldCardMeta, WorldChapter, WorldCharBeat, WorldChatMessage, WorldDirective, WorldEpisode, WorldHomeMode, WorldHouse, WorldNPC, WorldNarrativeStyle, WorldProfile, WorldRelationship, WorldSeed, WorldSimDate, WorldThread, WorldTimeMode, Worldbook, WorldbookDepthRole, WorldbookEntryConfig, WorldbookPosition, WorldbookSelectiveLogic, XhsActionType, XhsActivityRecord, XhsFreeRoamSession, XhsMcpConfig, XhsOwnedPost, XhsStockImage } from './types';

declare module './types' {
  interface ActiveMsg2GlobalConfig {
    driver?: ActiveMsg2DbDriver;
    databaseUrl?: string;
    initSecret?: string;
    tenantId?: string;
    tenantToken?: string;
    cronToken?: string;
    cronWebhookUrl?: string;
    masterKeyFingerprint?: string;
  }

  interface ActiveMsg2TaskRecord {
    anchorLastUserMsgAt?: number;
  }

  interface ActiveMsg2CharacterConfig {
    mode?: ActiveMsg2Mode;
    firstSendTime?: string;
    recurrenceType?: ActiveMsg2Recurrence;
    userMessage?: string;
    promptHint?: string;
    taskUuid?: string;
    remoteStatus?: 'idle' | 'scheduled' | 'sent' | 'error';
  }

  interface InstantPushPendingToolCall {
    directives?: Array<Record<string, unknown>>;
  }

  interface ApiPreset {
    pricing?: ApiPricing;
  }

  interface VRWorldCharState {
    autonomousRoomMode?: VRAutonomousRoomMode;
    autonomousRoomIds?: VRAutonomousRoomId[];
  }

  interface DateState {
    meetingCgBackground?: import('./utils/meetingCg').MeetingCgBackground;
  }

  interface CharacterProfile {
    novelAiReference?: NovelAiPreciseReferenceConfig;
  }

  interface GalleryImage {
    source?: 'manual' | 'chat-upload' | 'mcp-generated';
    sourceMeta?: {
        serverId?: string;
        serverName?: string;
        toolName?: string;
        engine?: string;
        prompt?: string;
        originalUrl?: string;
    };
  }

  interface FullBackupData {
    activeApiPresetId?: string | null;
    apiFailoverGroups?: import('./utils/apiFailover').ApiFailoverGroup[];
    apiCostDailySummaries?: ApiCostDailySummary[];
    apiCostUnresolvedEntries?: ApiCostUnresolvedEntry[];
    apiCallLog?: import('./utils/apiCallLog').ApiCallLogEntry[];
    simulatorProjects?: SimulatorProject[];
    simulatorSessions?: SimulatorSession[];
    readingProjects?: ReadingProject[];
    readingRecords?: ReadingRecord[];
    readingWritings?: ReadingWriting[];
    readingStylePresets?: ReadingStylePreset[];
    appMemoryCandidates?: AppMemoryCandidate[];
    gameHallSessions?: import('./utils/gameHallTypes').GameHallSession[];
    gameHallMessages?: import('./utils/gameHallTypes').GameHallMessage[];
    gameHallPendingActions?: import('./utils/gameHallTypes').GameHallPendingAction[];
    characterExternalAccounts?: import('./utils/gameHallTypes').CharacterExternalAccount[];
    gameHallBridgeSnapshots?: Record<string, unknown>[];
    gameHallEvents?: Record<string, unknown>[];
    gameHallMemoryCandidates?: Record<string, unknown>[];
    gameHallPreferenceEvidence?: Record<string, unknown>[];
    gameHallAutoplayLocal?: import('./utils/gameHallAutoplayBackup').GameHallAutoplayBackup;
    liveSettings?: import('./utils/liveTypes').LiveSettings[];
    liveRooms?: import('./utils/liveTypes').LiveRoom[];
    liveEvents?: import('./utils/liveTypes').LiveEvent[];
    liveSessions?: import('./utils/liveTypes').LiveSession[];
    imageGenerationLocal?: import('./utils/imageGenerationPresets').ImageGenerationBackupLocal;
    gameHallCedarConnection?: import('./utils/cedarToyMcpAdapter').CedarToyConnectionBackup;
    backgroundImageJobs?: import('./utils/backgroundImageJobs').BackgroundImageJobsBackup;
  }
}

export {};
