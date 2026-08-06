import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

describe('failed image job card selection and deletion contract', () => {
  it('reuses selection UI without replacing ordinary message selection', () => {
    const chat = read('../apps/Chat.tsx');
    expect(chat).toContain('selectedMsgIds');
    expect(chat).toContain('selectedThinkingMsgIds');
    expect(chat).toContain('selectedImageJobIds');
    expect(chat).toContain('await DB.deleteMessages(ids)');
    expect(chat).toContain('await dismissBackgroundImageJobs(imageJobIdsToDismiss)');
    expect(chat).toContain('setSelectedImageJobIds(new Set())');
  });

  it('keeps cards visible in selection mode and wires long press/toggle only when selectable', () => {
    const chat = read('../apps/Chat.tsx');
    const card = read('../components/chat/ImageJobCard.tsx');
    expect(chat).not.toContain('!selectionMode && imageJobCards.map');
    expect(chat).toContain('selectable={selectable}');
    expect(chat).toContain('selectionMode={selectionMode}');
    expect(chat).toContain('selected={selectedImageJobIds.has(card.id)}');
    expect(card).toContain('onLongPress?.()');
    expect(card).toContain('onToggleSelect?.()');
    expect(card).toContain('suppressNextClickRef.current = true');
    expect(card).toContain("data-image-job-selected={selected ? 'true' : 'false'}");
  });

  it('routes ordinary messages and failed jobs independently in one delete action', () => {
    const chat = read('../apps/Chat.tsx');
    const ordinaryAt = chat.indexOf('await DB.deleteMessages(ids)');
    const imageJobAt = chat.indexOf('await dismissBackgroundImageJobs(imageJobIdsToDismiss)');
    expect(ordinaryAt).toBeGreaterThan(-1);
    expect(imageJobAt).toBeGreaterThan(ordinaryAt);
    expect(chat).toContain('msgIdsToDelete.size === 0 && thinkingIdsToClear.size === 0 && imageJobIdsToDismiss.length === 0');
  });
});
