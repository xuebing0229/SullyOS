import { beforeEach, describe, expect, it, vi } from 'vitest';

const loadModule = async (buildEnabled: boolean) => {
    vi.resetModules();
    vi.stubGlobal('__BUILD_BADGE_VISIBLE__', buildEnabled);
    return import('./devDebug');
};

describe('production dev debug entry', () => {
    beforeEach(() => {
        localStorage.clear();
        vi.unstubAllGlobals();
        const fakeWindow = new EventTarget() as EventTarget & { localStorage: Storage };
        fakeWindow.localStorage = localStorage;
        vi.stubGlobal('window', fakeWindow);
    });

    it('正式构建默认关闭，并持久化开启和关闭', async () => {
        const debug = await loadModule(false);
        expect(debug.readDevDebugEntryEnabled()).toBe(false);
        expect(debug.isDevDebugAvailable()).toBe(false);
        expect(debug.setDevDebugEntryEnabled(true)).toBe(true);
        expect(localStorage.getItem(debug.DEV_DEBUG_ENTRY_STORAGE_KEY)).toBe('1');
        expect(debug.isDevDebugAvailable()).toBe(true);
        debug.closeDevDebug();
        expect(localStorage.getItem(debug.DEV_DEBUG_ENTRY_STORAGE_KEY)).toBe('0');
        expect(debug.isDevDebugAvailable()).toBe(false);
    });

    it('开发构建不受持久入口关闭影响，仍由构建 flag 默认可用', async () => {
        const debug = await loadModule(true);
        expect(debug.isDevDebugAvailable()).toBe(true);
        debug.setDevDebugEntryEnabled(false);
        expect(debug.isDevDebugAvailable()).toBe(true);
    });

    it('入口事件可即时通知设置页状态', async () => {
        const debug = await loadModule(false);
        const listener = vi.fn();
        const unsubscribe = debug.subscribeDevDebugEntryEnabled(listener);
        debug.setDevDebugEntryEnabled(true);
        expect(listener).toHaveBeenCalledWith(true);
        unsubscribe();
    });
});
