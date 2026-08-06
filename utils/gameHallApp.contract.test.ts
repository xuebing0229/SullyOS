import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const appSource = readFileSync(
  new URL('../apps/GameHallApp.tsx', import.meta.url),
  'utf8',
);
const storeSource = readFileSync(
  new URL('./gameHallStore.ts', import.meta.url),
  'utf8',
);
const agentSource = readFileSync(
  new URL('./gameHallAgent.ts', import.meta.url),
  'utf8',
);

describe('GameHall tool result and history contracts', () => {
  it('feeds the user-selected game hall range through the full main-chat context chain', () => {
    expect(appSource).toContain('const history = await getGameHallMessages(session.id)');
    expect(appSource).toContain('respondToGameHallToolResult');
    expect(agentSource).toContain('loadCharacterContextRange(input.char)');
    expect(agentSource).toContain('buildChatRequestPayload({');
    expect(agentSource).toContain('gameHallMessages: context.messages');
  });

  it('shows the real successful tool result instead of a success-only placeholder', () => {
    expect(appSource).toContain('toolResult: result');
    expect(appSource).toContain('message.toolResult &&');
    expect(appSource).toContain('getGameHallToolResultPayload(message.toolResult)');
  });

  it('does not guess or silently call a state tool after a successful action', () => {
    expect(appSource).not.toContain('hasCallableStateTool');
    expect(appSource).not.toContain('canCallWithoutGuessing(tool, {})');
    expect(appSource).not.toContain('refreshState');
    expect(agentSource).not.toContain('hasCallableStateTool');
    expect(agentSource).not.toContain('refreshState');
  });

  it('keeps the current conversation active when merely leaving the app', () => {
    expect(appSource).toContain("status: 'active'");
    expect(appSource).not.toContain("status: 'ended'");
  });

  it('recovers the latest legacy ended session after upgrade', () => {
    expect(storeSource).toContain(
      "latest.find(session => session.status === 'active') || latest[0]",
    );
  });

  it('queues paper-plane messages locally and plans only after an explicit sealed turn', () => {
    const queueStart = appSource.indexOf('const queueUserMessage');
    const queueEnd = appSource.indexOf('const runSealedGameHallTurn');
    expect(queueStart).toBeGreaterThan(-1);
    expect(appSource.slice(queueStart, queueEnd)).not.toContain('planGameHallTurn');
    expect(appSource).toContain('await queueUserMessage(text)');
    expect(appSource).toContain('sealGameHallTurnForReply({');
    expect(appSource).toContain('轮到你了');
  });

  it('stores all parsed bubbles before display and keeps input enabled during replies', () => {
    expect(appSource).toContain('await saveGameHallMessages(persisted)');
    expect(appSource).toContain('thinkingChain: firstVisible ? input.thinkingChain : undefined');
    expect(appSource).toContain('chain={message.thinkingChain}');
    expect(appSource).toContain('styleId={(selected as any)?.thinkingChainStyle}');
    expect(appSource).toContain('disabled={handoffBusy || !input.trim()}');
  });

  it('does not use raw model output as a reply fallback', () => {
    expect(agentSource).not.toContain('parsed?.reply || raw');
    expect(agentSource).toContain("throw new Error('游戏厅回复格式解析失败')");
    expect(agentSource).toContain('!!parsed.action &&');
  });
});
