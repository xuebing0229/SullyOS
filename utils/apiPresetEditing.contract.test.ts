import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '..');
const settings = fs.readFileSync(path.join(root, 'apps/Settings.tsx'), 'utf8');
const context = fs.readFileSync(path.join(root, 'context/OSContext.tsx'), 'utf8');

describe('editable multi-model API preset integration contract', () => {
  it('adds the selected model to the selected preset and activates the same preset identity', () => {
    const handler = settings.slice(
      settings.indexOf('const handleSaveApi ='),
      settings.indexOf('const buildVisionApiConfig ='),
    );
    expect(handler).toContain('setApiPresetDefaultModel(');
    expect(handler).toContain('models: updatedPreset.models');
    expect(handler).toContain('activateApiPreset(updatedPreset)');
    expect(handler).toContain('保存到「');
  });

  it('immediately applies and selects a newly saved preset', () => {
    expect(settings).toContain('const preset = addApiPreset(name, buildCurrentApiPresetConfig(), newPresetPricing)');
    expect(settings).toContain('setSelectedPresetId(preset.id)');
    expect(context).toContain('persistCurrentApiConfig(applyApiPresetConfig(apiConfig, preset.config))');
    expect(context).toContain('persistActiveApiPresetId(preset.id)');
  });

  it('stores a model collection on newly created presets', () => {
    expect(context).toContain("models: config.model ? [{ model: config.model, pricing }] : []");
  });

  it('resets failover runtime when presets change and exposes Save As copy', () => {
    expect(context).toMatch(/const persistApiPresets[\s\S]*?resetApiFailoverRuntime\(\)/);
    expect(settings).toContain('另存为预设');
  });
});
