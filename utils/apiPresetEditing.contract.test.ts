import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '..');
const settings = fs.readFileSync(path.join(root, 'apps/Settings.tsx'), 'utf8');
const context = fs.readFileSync(path.join(root, 'context/OSContext.tsx'), 'utf8');

describe('editable API preset integration contract', () => {
  it('updates the selected preset directly instead of clearing it via updateApiConfig first', () => {
    const handler = settings.slice(
      settings.indexOf('const handleSaveApi ='),
      settings.indexOf('const handleSaveOtherApis ='),
    );
    expect(handler).toContain('updateApiPreset(selectedApiPreset.id, { name: presetName, config: nextConfig })');
    expect(handler.indexOf('updateApiPreset')).toBeLessThan(handler.indexOf('updateApiConfig'));
    expect(handler).toContain('保存到「');
  });

  it('immediately applies and selects a newly saved preset', () => {
    expect(settings).toContain('const preset = addApiPreset(name, buildCurrentApiPresetConfig(), newPresetPricing)');
    expect(settings).toContain('setSelectedPresetId(preset.id)');
    expect(context).toContain('persistCurrentApiConfig(applyApiPresetConfig(apiConfig, preset.config))');
    expect(context).toContain('persistActiveApiPresetId(preset.id)');
  });

  it('resets failover runtime when presets change and exposes Save As copy', () => {
    expect(context).toMatch(/const persistApiPresets[\s\S]*?resetApiFailoverRuntime\(\)/);
    expect(settings).toContain('另存为预设');
  });
});
