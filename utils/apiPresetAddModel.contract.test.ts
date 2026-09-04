import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '..');
const settings = fs.readFileSync(path.join(root, 'apps/Settings.tsx'), 'utf8');

describe('API preset explicit add-model entry', () => {
  it('shows an add-model action on every preset card', () => {
    expect(settings).toContain("'+ 添加模型'");
    expect(settings).toContain('openAddModelPicker(preset)');
  });

  it('fetches the model list with the target preset connection, not the current form connection', () => {
    const start = settings.indexOf('const openAddModelPicker =');
    const end = settings.indexOf('const openEditPreset =', start);
    const handler = settings.slice(start, end);
    expect(handler).toContain('preset.config.baseUrl');
    expect(handler).toContain('preset.config.apiKey');
    expect(handler).toContain('/models');
  });

  it('adds a chosen model without changing the preset default model or active API', () => {
    const start = settings.indexOf('const saveModelToPreset =');
    const end = settings.indexOf('const deleteModelFromPreset =', start);
    const handler = settings.slice(start, end);
    expect(handler).toContain('ensureApiPresetModel(preset, model)');
    expect(handler).toContain('updateApiPreset(preset.id, { models: updated.models })');
    expect(handler).not.toContain('setApiPresetDefaultModel');
    expect(handler).not.toContain('activateApiPreset');
  });

  it('reuses the model picker for direct add and manual model input', () => {
    expect(settings).toContain('给「\${addingModelPreset.name}」添加模型');
    expect(settings).toContain("addingModelPreset ? '添加' : '确定'");
    expect(settings).toContain('saveModelToPreset(addingModelPreset, m)');
  });
});
