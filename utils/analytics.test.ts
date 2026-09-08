import { describe, expect, it, vi } from 'vitest';
import {
  initAnalytics,
  isAnalyticsConfigured,
  isAnalyticsEnabled,
  isAnalyticsRequestUrl,
  trackEvent,
} from './analytics';

describe('二改版统计隐私护栏', () => {
  it('外发统计永久关闭，不受本地开关或构建变量影响', () => {
    expect(isAnalyticsEnabled()).toBe(false);
    expect(isAnalyticsConfigured()).toBe(false);
    expect(isAnalyticsRequestUrl('https://example.com/api/send')).toBe(false);
  });

  it('初始化不会注入任何 Umami script', () => {
    const createElement = vi.fn();
    const oldDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: { createElement, head: { appendChild: vi.fn() } },
    });
    try {
      initAnalytics();
      expect(createElement).not.toHaveBeenCalled();
    } finally {
      if (oldDocument) Object.defineProperty(globalThis, 'document', oldDocument);
      else Reflect.deleteProperty(globalThis, 'document');
    }
  });

  it('trackEvent 永远不会向 window.umami 发送事件', () => {
    const track = vi.fn();
    const oldWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { umami: { track } },
    });
    try {
      trackEvent('测试事件', { 模式: '固定枚举' });
      expect(track).not.toHaveBeenCalled();
    } finally {
      if (oldWindow) Object.defineProperty(globalThis, 'window', oldWindow);
      else Reflect.deleteProperty(globalThis, 'window');
    }
  });
});
