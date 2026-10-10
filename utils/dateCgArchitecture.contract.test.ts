import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

describe('DateSession CG architecture contract', () => {
    const source = readFileSync('components/date/DateSession.tsx', 'utf8');
    const planner = readFileSync('utils/dateCgPlanner.ts', 'utf8');

    it('routes generation through the hidden planner and removes the chat-message relay', () => {
        expect(source).toContain('generateMeetingCgViaChatPlanner({');
        expect(source).toContain('meetingMessages: messages');
        expect(source).not.toContain('buildMeetingCgPrompt(');
        expect(source).not.toContain('persistMcpGeneratedImages({');
        expect(source).not.toContain('getRecentMessagesByCharId(char.id, 200, true)');
        expect(source).not.toContain('meetingCgToken');
    });

    it('reuses the main chat image-tool bridge instead of maintaining a second image schema path', () => {
        expect(planner).toContain('buildChatRequestPayload({');
        expect(planner).toContain('historyMsgs: recentMeetingMessages');
        expect(planner).toContain('worldbookQueryMessages: recentMeetingMessages');
        expect(planner).toContain('recallQueryHint: sceneSummary');
        expect(planner).toContain('buildMcpOpenAITools(charId');
        expect(planner).toContain('getMcpUseNativeTools()');
        expect(planner).toContain('parseImageToolClientOptions(chosen.args)');
        expect(planner).toContain('applyImageGenerationPresetById');
        expect(planner).toContain('prepareBuiltinImageToolArguments({');
        expect(planner).toContain("ownerType: 'meeting-cg'");
        expect(planner).toContain('allowMcpChat: false');
        expect(planner).not.toContain('augmentImageToolSchema(');
        expect(planner).not.toContain('resolveDefaultImageTool');
    });

    it('renders full-opacity CG in front of the sprite and below dialogue UI', () => {
        const spriteIndex = source.indexOf('pointer-events-none z-10 overflow-hidden');
        const cgIndex = source.indexOf('absolute inset-0 z-20 pointer-events-none');
        const dialogueIndex = source.indexOf('absolute inset-x-0 bottom-8 z-30');
        expect(spriteIndex).toBeGreaterThan(-1);
        expect(cgIndex).toBeGreaterThan(spriteIndex);
        expect(dialogueIndex).toBeGreaterThan(cgIndex);
        expect(source).toContain('object-cover opacity-100');
    });
});