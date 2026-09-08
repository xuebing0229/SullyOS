import { describe, expect, it } from 'vitest';

const ensureNavigator = () => {
  if (!('navigator' in globalThis)) {
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { userAgent: 'node', platform: 'Linux', maxTouchPoints: 0 },
    });
  }
};

describe('Live2D Blob texture parser selection', () => {
  it('does not rely on a fragment extension that Pixi removes', async () => {
    ensureNavigator();
    const { loadTextures } = await import('pixi.js');
    expect(loadTextures.test?.('blob:https://localhost/texture#live2d-texture.png')).toBe(false);
  });

  it('keeps an explicit texture parser on a bare Blob URL', async () => {
    ensureNavigator();
    const { Assets } = await import('pixi.js');
    const url = 'blob:https://localhost/live2d-explicit-parser-test';
    Assets.add({
      alias: url,
      src: url,
      parser: 'texture',
      data: { autoGenerateMipmaps: false },
    });

    try {
      expect(Assets.resolver.resolve(url)).toMatchObject({
        src: url,
        parser: 'texture',
        data: { autoGenerateMipmaps: false },
      });
    } finally {
      Assets.resolver.removeAlias(url);
    }
  });
});
