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

describe('GameHall tool result and history contracts', () => {
  it('feeds recent persisted messages back into the companion prompt', () => {
    expect(appSource).toContain(
      'history: [...messages, ...(userMessage ? [userMessage] : [])]',
    );
    expect(appSource).toContain('respondToGameHallToolResult');
  });

  it('shows the real successful tool result instead of a success-only placeholder', () => {
    expect(appSource).toContain('summarizeGameHallToolResult(result)');
    expect(appSource).toContain('工具返回：');
    expect(appSource).toContain('toolResultSummary');
  });

  it('does not turn a successful account action into failure because no state tool exists', () => {
    expect(appSource).toContain('hasCallableStateTool');
    expect(appSource).toContain('canCallWithoutGuessing(tool, {})');
    expect(appSource).toContain('await refreshState(false)');
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
