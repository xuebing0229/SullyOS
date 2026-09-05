/** 文游整轮后台正文生成的系统通知协议。纯常量叶子，客户端与 AMSG Worker 共用。 */
export const STORY_BACKGROUND_STATUS_RESULT_KIND = 'story-background-status';

export type StoryBackgroundStatus = 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface StoryBackgroundStatusPayload {
  resultKind: typeof STORY_BACKGROUND_STATUS_RESULT_KIND;
  storyStatus: StoryBackgroundStatus;
  storyJobId: string;
  storyClientRequestId: string;
  storyOwnerKey: string;
  storyTitle: string;
  error?: string;
}
