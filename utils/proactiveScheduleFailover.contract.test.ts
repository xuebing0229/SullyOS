import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (relative: string) =>
    fs.readFileSync(path.resolve(process.cwd(), relative), 'utf8');

describe('proactive and schedule main failover contract', () => {
    it('routes default proactive messages through chat failover but keeps secondary direct', () => {
        const source = read('context/OSContext.tsx');
        expect(source).toContain("resolveApiExecutionPlan(\n                  'chat',\n                  api,\n                  !useSecondary");
        expect(source).toContain('executeOpenAiChatPlan({');
        expect(source).toContain("purpose: '主动消息'");
        expect(source).toContain('directMaxRetries: 2');
    });

    it('routes schedule generation and flow evolution through the shared helper', () => {
        const source = read('utils/scheduleGenerator.ts');
        expect(source).toContain("resolveApiExecutionPlan('chat', apiConfig, true)");
        expect(source).toContain('purpose: ScheduleRequestPurpose');
        expect(source).toContain("'生成当日日程'");
        expect(source).toContain("'进化意识流'");
        expect(source).not.toContain('safeResponseJson');
    });

    it('does not add another failover scope or duplicate cooldown classification', () => {
        const source = read('utils/scheduleGenerator.ts');
        expect(source).not.toContain("resolveApiExecutionPlan('schedule'");
        expect(source).not.toContain('markApiRouteCooldown');
        expect(source).not.toContain('classifyApiError');
    });
});