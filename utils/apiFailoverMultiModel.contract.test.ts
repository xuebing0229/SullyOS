import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '..');
const settings = fs.readFileSync(
  path.join(root, 'components/settings/ApiFailoverSettings.tsx'),
  'utf8',
);
const runtime = fs.readFileSync(
  path.join(root, 'utils/apiFailover.ts'),
  'utf8',
);
const analysis = fs.readFileSync(
  path.join(root, 'utils/apiFailoverGroupAnalysis.ts'),
  'utf8',
);

describe('failover multi-model route contract', () => {
  it('shows preset + model as one selectable route unit', () => {
    expect(settings).toContain('getApiPresetModelEntries(preset)');
    expect(settings).toContain('presetName: preset.name');
    expect(settings).toContain('model: item.model');
    expect(settings).toContain('{option.presetName} · {option.model}');
  });

  it('allows the same preset more than once when models differ', () => {
    expect(settings).toContain('memberRouteKey(member.presetId, member.model)');
    expect(settings).toContain('model: option.model');
    expect(settings).not.toContain('unusedPresetIds');
  });

  it('persists a model on each failover member and resolves it into the request config', () => {
    expect(runtime).toContain('model?: string;');
    expect(analysis).toContain('model: entry.model');
    expect(analysis).toContain('apiPresetHasModel(preset, model)');
  });

  it('keeps the native-looking settings card and switch treatment', () => {
    expect(settings).toContain('rounded-[22px]');
    expect(settings).toContain("bg-emerald-500");
    expect(settings).toContain('+ 添加备用线路');
  });
});
