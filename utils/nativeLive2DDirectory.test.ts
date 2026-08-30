import { beforeEach, describe, expect, it, vi } from 'vitest';

const { convertFileSrc } = vi.hoisted(() => ({
  convertFileSrc: vi.fn((uri: string) => `https://localhost/_capacitor_file_/${uri}`),
}));
vi.mock('@capacitor/core', () => ({
  Capacitor: {
    convertFileSrc,
    getPlatform: () => 'android',
    isPluginAvailable: () => true,
  },
  registerPlugin: () => ({
    pickDirectory: vi.fn(),
    clearImport: vi.fn(),
  }),
}));

import { loadNativeLive2DDirectoryEntries } from './nativeLive2DDirectory';

describe('Android Live2D 目录桥接', () => {
  beforeEach(() => convertFileSrc.mockClear());

  it('逐个读取暂存文件并保持 SAF 目录的完整相对路径', async () => {
    const fetchBlob = vi.fn(async (url: string) => new Blob([url]));
    const entries = await loadNativeLive2DDirectoryEntries({
      cancelled: false,
      sessionId: '12345678-1234-1234-1234-123456789abc',
      directoryName: 'mowang',
      files: [
        { relativePath: 'mowang.model3.json', uri: 'file:///cache/model.json', size: 10 },
        { relativePath: 'mowang.8192/texture_00.png', uri: 'file:///cache/mowang.8192/texture_00.png', size: 20 },
        { relativePath: 'expressions/happy.exp3.json', uri: 'file:///cache/expressions/happy.exp3.json', size: 30 },
      ],
    }, fetchBlob);

    expect(entries.map(entry => entry.path)).toEqual([
      'mowang.model3.json',
      'mowang.8192/texture_00.png',
      'expressions/happy.exp3.json',
    ]);
    expect(fetchBlob).toHaveBeenCalledTimes(3);
    expect(convertFileSrc).toHaveBeenCalledTimes(3);
  });
});
