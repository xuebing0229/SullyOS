import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import type { GameHallWebState } from './gameHallTypes';

interface Frame { x: number; y: number; width: number; height: number }
interface GameHallWebViewPlugin {
  create(options: { url: string; frame: Frame }): Promise<void>;
  setFrame(options: Frame): Promise<void>;
  loadUrl(options: { url: string }): Promise<void>;
  reload(): Promise<void>;
  goBack(): Promise<void>;
  setVisible(options: { visible: boolean }): Promise<void>;
  destroy(): Promise<void>;
  getState(): Promise<GameHallWebState>;
  addListener(eventName: 'stateChange', listener: (state: GameHallWebState) => void): Promise<PluginListenerHandle>;
}
const NativeGameHallWebView = registerPlugin<GameHallWebViewPlugin>('GameHallWebView');
export const isNativeGameHallWebViewAvailable = (): boolean => Capacitor.getPlatform() === 'android';
export const gameHallWebView = NativeGameHallWebView;
export const frameFromElement = (element: HTMLElement): Frame => {
  const rect = element.getBoundingClientRect();
  return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
};
