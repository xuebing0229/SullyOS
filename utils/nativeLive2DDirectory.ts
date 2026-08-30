import { Capacitor, registerPlugin } from '@capacitor/core';

export interface NativeLive2DDirectoryFile {
  relativePath: string;
  uri: string;
  size: number;
  mimeType?: string;
}

export interface NativeLive2DDirectorySelection {
  cancelled: boolean;
  sessionId?: string;
  directoryName?: string;
  totalBytes?: number;
  files?: NativeLive2DDirectoryFile[];
}

interface SullyLive2DDirectoryPlugin {
  pickDirectory(): Promise<NativeLive2DDirectorySelection>;
  clearImport(options: { sessionId: string }): Promise<void>;
}

const NativeLive2DDirectory = registerPlugin<SullyLive2DDirectoryPlugin>('SullyLive2DDirectory');

export const canPickNativeLive2DDirectory = (): boolean => (
  isNativeAndroidLive2DDirectoryPlatform()
  && Capacitor.isPluginAvailable('SullyLive2DDirectory')
);

export const isNativeAndroidLive2DDirectoryPlatform = (): boolean => Capacitor.getPlatform() === 'android';

export const pickNativeLive2DDirectory = async (): Promise<NativeLive2DDirectorySelection> => (
  NativeLive2DDirectory.pickDirectory()
);

export const loadNativeLive2DDirectoryEntries = async (
  selection: NativeLive2DDirectorySelection,
  fetchBlob: (url: string) => Promise<Blob> = async url => {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`读取暂存模型文件失败：HTTP ${response.status}`);
    return response.blob();
  },
): Promise<Array<{ path: string; blob: Blob }>> => {
  const files = selection.files || [];
  const entries: Array<{ path: string; blob: Blob }> = [];
  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    const localUrl = Capacitor.convertFileSrc(file.uri);
    const blob = await fetchBlob(localUrl);
    entries.push({ path: file.relativePath, blob });
  }
  return entries;
};

export const clearNativeLive2DDirectoryImport = async (sessionId?: string): Promise<void> => {
  if (!sessionId) return;
  await NativeLive2DDirectory.clearImport({ sessionId });
};
