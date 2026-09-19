import { describe, expect, it, vi } from 'vitest';
import {
  applyLive2DVTubeArtMeshColors,
  bridgeCubism6RenderOrders,
  enableCubism5HighPrecisionMasks,
} from './live2dCore';

const createModel = (
  drawables: { count: number; renderOrders?: Int32Array },
  renderOrders: Int32Array,
  offscreenCount = 0,
) => ({
  internalModel: {
    coreModel: {
      _model: {
        drawables,
        offscreens: { count: offscreenCount },
        getRenderOrders: () => renderOrders,
      },
    },
  },
});

describe('bridgeCubism6RenderOrders', () => {
  it('maps Core 6 model render orders onto the legacy drawable field', () => {
    const drawables: { count: number; renderOrders?: Int32Array } = { count: 3 };
    const renderOrders = new Int32Array([2, 0, 1]);

    const result = bridgeCubism6RenderOrders(createModel(drawables, renderOrders));

    expect(result).toEqual({ offscreenCount: 0 });
    expect(drawables.renderOrders).toEqual(renderOrders);
  });

  it('leaves pre-5.3 drawable render orders untouched', () => {
    const existing = new Int32Array([0, 1]);
    const drawables = { count: 2, renderOrders: existing };
    const model = createModel(drawables, new Int32Array([1, 0]));

    bridgeCubism6RenderOrders(model);

    expect(drawables.renderOrders).toBe(existing);
  });

  it('rejects Core 6 offscreen models instead of rendering them incorrectly', () => {
    const drawables: { count: number; renderOrders?: Int32Array } = { count: 2 };
    const model = createModel(drawables, new Int32Array([0, 2, 1]), 1);

    expect(() => bridgeCubism6RenderOrders(model)).toThrow(
      'This Cubism 5.3 model uses 1 offscreen object(s)',
    );
    expect(drawables.renderOrders).toBeUndefined();
  });
});

describe('applyLive2DVTubeArtMeshColors', () => {
  const hairColor = {
    id: 'ArtMeshHair',
    multiply: [0.5, 0.25, 1, 1] as [number, number, number, number],
    screen: [0.1, 0.2, 0.3, 1] as [number, number, number, number],
  };

  it('uses the legacy Cubism color API shipped by the current Pixi adapter', () => {
    const ids = ['ArtMeshFace', 'ArtMeshHair'];
    const setMultiplyColorByRGBA = vi.fn();
    const setScreenColorByRGBA = vi.fn();
    const setOverrideFlagForDrawableMultiplyColors = vi.fn();
    const setOverrideFlagForDrawableScreenColors = vi.fn();
    const model = {
      internalModel: {
        coreModel: {
          _model: { drawables: { count: ids.length, ids } },
          getDrawableCount: () => ids.length,
          getDrawableId: (index: number) => ({ getString: () => ({ s: ids[index] }) }),
          setMultiplyColorByRGBA,
          setScreenColorByRGBA,
          setOverrideFlagForDrawableMultiplyColors,
          setOverrideFlagForDrawableScreenColors,
        },
      },
    };

    const result = applyLive2DVTubeArtMeshColors(model, [
      hairColor,
      { ...hairColor, id: 'MissingArtMesh' },
    ]);

    expect(result).toEqual({ supported: true, applied: 1, missingIds: ['MissingArtMesh'] });
    expect(setMultiplyColorByRGBA).toHaveBeenCalledWith(1, ...hairColor.multiply);
    expect(setScreenColorByRGBA).toHaveBeenCalledWith(1, ...hairColor.screen);
    expect(setOverrideFlagForDrawableMultiplyColors).toHaveBeenCalledWith(1, true);
    expect(setOverrideFlagForDrawableScreenColors).toHaveBeenCalledWith(1, true);
  });

  it('also supports the newer Cubism multiply/screen controller API', () => {
    const setDrawableMultiplyColorByRGBA = vi.fn();
    const setDrawableScreenColorByRGBA = vi.fn();
    const setDrawableMultiplyColorEnabled = vi.fn();
    const setDrawableScreenColorEnabled = vi.fn();
    const controller = {
      setDrawableMultiplyColorByRGBA,
      setDrawableScreenColorByRGBA,
      setDrawableMultiplyColorEnabled,
      setDrawableScreenColorEnabled,
    };
    const model = {
      internalModel: {
        coreModel: {
          _model: { drawables: { count: 1, ids: ['ArtMeshHair'] } },
          getDrawableCount: () => 1,
          getDrawableId: () => ({ getString: () => 'ArtMeshHair' }),
          getOverrideMultiplyAndScreenColor: () => controller,
        },
      },
    };

    expect(applyLive2DVTubeArtMeshColors(model, [hairColor])).toEqual({
      supported: true,
      applied: 1,
      missingIds: [],
    });
    expect(setDrawableMultiplyColorByRGBA).toHaveBeenCalledWith(0, ...hairColor.multiply);
    expect(setDrawableScreenColorByRGBA).toHaveBeenCalledWith(0, ...hairColor.screen);
    expect(setDrawableMultiplyColorEnabled).toHaveBeenCalledWith(0, true);
    expect(setDrawableScreenColorEnabled).toHaveBeenCalledWith(0, true);
  });

  it('keeps models without VTS color overrides untouched', () => {
    expect(applyLive2DVTubeArtMeshColors({}, undefined)).toEqual({
      supported: true,
      applied: 0,
      missingIds: [],
    });
  });
});

describe('enableCubism5HighPrecisionMasks', () => {
  const createMaskModel = (mocVersion: number, initiallyEnabled = false) => {
    let enabled = initiallyEnabled;
    const useHighPrecisionMask = vi.fn((value: boolean) => { enabled = value; });
    return {
      model: {
        internalModel: {
          coreModel: { __moc: { getMocVersion: () => mocVersion } },
          renderer: {
            isUsingHighPrecisionMask: () => enabled,
            useHighPrecisionMask,
          },
        },
      },
      useHighPrecisionMask,
    };
  };

  it.each([5, 6])('forces per-drawable masks for moc3 version %i', mocVersion => {
    const { model, useHighPrecisionMask } = createMaskModel(mocVersion);

    expect(enableCubism5HighPrecisionMasks(model)).toEqual({
      highPrecisionMaskEnabled: true,
      mocVersion,
    });
    expect(useHighPrecisionMask).toHaveBeenCalledWith(true);
  });

  it('keeps the adapter policy for pre-Cubism-5 models', () => {
    const { model, useHighPrecisionMask } = createMaskModel(4);

    expect(enableCubism5HighPrecisionMasks(model)).toEqual({
      highPrecisionMaskEnabled: false,
      mocVersion: 4,
    });
    expect(useHighPrecisionMask).not.toHaveBeenCalled();
  });

  it('safely keeps the adapter policy when the moc version is unavailable', () => {
    expect(enableCubism5HighPrecisionMasks({})).toEqual({
      highPrecisionMaskEnabled: false,
      mocVersion: null,
    });
  });

  it('does not report compatibility as enabled when the renderer hook is unavailable', () => {
    expect(enableCubism5HighPrecisionMasks({
      internalModel: { coreModel: { __moc: { getMocVersion: () => 6 } } },
    })).toEqual({
      highPrecisionMaskEnabled: false,
      mocVersion: 6,
    });
  });
});
