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
    expect(appSource).toContain('history: turnHistory');
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
});
