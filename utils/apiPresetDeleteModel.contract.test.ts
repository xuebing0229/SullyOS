import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '..');
const settings = fs.readFileSync(path.join(root, 'apps/Settings.tsx'), 'utf8');

describe('API preset model delete UI', () => {
  it('shows a delete action beside every saved model', () => {
    expect(settings).toContain('deleteModelFromPreset(preset, item.model)');
    expect(settings).toContain('aria-label={\`删除模型 \${item.model}\`}');
    expect(settings).toContain('从这条预设中删除模型');
  });

  it('keeps one model minimum and explains how to remove the whole site', () => {
    const start = settings.indexOf('const deleteModelFromPreset =');
    const end = settings.indexOf('const openAddModelPicker =', start);
    const handler = settings.slice(start, end);
    expect(handler).toContain('if (entries.length <= 1)');
    expect(handler).toContain('可以直接删除整条预设');
  });

  it('updates saved default and preserves an active surviving model when possible', () => {
    const start = settings.indexOf('const deleteModelFromPreset =');
    const end = settings.indexOf('const openAddModelPicker =', start);
    const handler = settings.slice(start, end);
    expect(handler).toContain('removeApiPresetModel(preset, model)');
    expect(handler).toContain('config: updatedPreset.config');
    expect(handler).toContain('activeModelStillSaved');
    expect(handler).toContain('activateApiPreset(runtimePreset)');
  });
});
