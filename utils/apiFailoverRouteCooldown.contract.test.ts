import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
const read = (relative: string) => fs.readFileSync(path.resolve(process.cwd(), relative), 'utf8');

describe('failover three-minute cooldown contract', () => {
  it('checks persisted cooldown before executing', () => {
    const source = read('utils/apiFailover.ts');
    expect(source).toContain('getApiRouteCooldown');
    expect(source).toContain("kind: 'route_cooldown'");
    expect(source).toContain('markApiRouteCooldown');
  });
  it('does not retain same-route retry', () => {
    const source = read('utils/apiFailover.ts');
    expect(source).not.toContain('retryPolicy.execute');
    expect(source).not.toContain('new ExponentialBackoff');
  });
  it('normalizes old policy to one attempt and 180 seconds', () => {
    const source = read('utils/apiFailover.ts');
    expect(source).toContain('routeMaxAttempts: 1');
    expect(source).toContain('consecutiveFailureThreshold: 1');
    expect(source).toContain('API_FAILOVER_ROUTE_FAILURE_COOLDOWN_MS');
  });
  it('does not add cooldown timestamps to backup types', () => {
    const types = read('types.ts');
    expect(types).not.toContain('apiFailoverRouteCooldown');
    expect(types).not.toContain('routeCooldownEntries');
  });
  it('removes misleading controls and shows fixed rule', () => {
    const source = read('components/settings/ApiFailoverSettings.tsx');
    expect(source).not.toContain('单线路总尝试');
    expect(source).not.toContain('连续失败熔断');
    expect(source).not.toContain('冷却（秒）');
    expect(source).toContain('失败线路冷却 3 分钟');
  });
});
