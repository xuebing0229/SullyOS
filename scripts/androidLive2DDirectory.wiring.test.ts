import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Android Live2D directory picker wiring', () => {
  it('uses SAF tree selection and installs the Capacitor bridge during sync', () => {
    const nativeSource = readFileSync(resolve(__dirname, '../native/android/SullyLive2DDirectoryPlugin.java'), 'utf8');
    const pkg = JSON.parse(readFileSync(resolve(__dirname, '../package.json'), 'utf8'));
    expect(nativeSource).toContain('Intent.ACTION_OPEN_DOCUMENT_TREE');
    expect(nativeSource).toContain('DocumentsContract.buildChildDocumentsUriUsingTree');
    expect(nativeSource).toContain('takePersistableUriPermission');
    expect(nativeSource).toContain('endsWith(".model3.json")');
    expect(pkg.scripts['capacitor:sync:after']).toContain('install-android-live2d-directory-plugin.mjs');
  });
});
