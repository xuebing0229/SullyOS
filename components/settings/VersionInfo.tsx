import React, { useEffect, useRef, useState } from 'react';
import { querySwVersion } from '../../utils/swVersion';
import { APP_VERSION, BUILD_LABEL } from '../../utils/buildInfo';
import { NativeAppUpdateSettingsCard } from '../NativeAppUpdate';
import {
    isDevDebugAvailable,
    readDevDebugEntryEnabled,
    setDevDebugEntryEnabled,
    subscribeDevDebugAvailability,
    subscribeDevDebugEntryEnabled,
    unlockDevDebug,
} from '../../utils/devDebug';

/**
 * Settings 底部的版本信息脚注。
 *
 * 右下角 BuildBadge 已停止挂载；这里在所有构建（含正式版）里低调显示，
 * 方便用户截图报障时附带版本上下文：
 *   - APP_VERSION：手工维护的产品版本名（之前硬编码的 v2.2）
 *   - build：vite.config 注入的 __BUILD_BRANCH__@__BUILD_COMMIT__
 *   - sw：运行时向 Service Worker 查询的 SW_VERSION
 *
 * 构建全局（__BUILD_BRANCH__ 等）由 vite define 始终注入，prod 也有值，
 * 所以无需任何 dev 条件判断。SW 未注册 / 未响应时 sw 显示 '?'。
 *
 * 兼容彩蛋：连点 APP_VERSION 5 下仍可会话级解锁 DevDebug 面板；
 * 正式版主要入口是上方的持久“调试工具”开关。
 * 面板已可用时（非 prod / 已解锁）再点不计数。
 */

const UNLOCK_TAP_COUNT = 5;
const TAP_RESET_MS = 2000;
const isProductionBuild = typeof __BUILD_BADGE_VISIBLE__ === 'undefined' || !__BUILD_BADGE_VISIBLE__;

const VersionInfo: React.FC = () => {
    const [swVersion, setSwVersion] = useState<string>('…');
    // available = 面板当前是否可用（非 prod 默认 true；prod 解锁后 true；强制关闭后 false）。
    const [available, setAvailable] = useState<boolean>(() => isDevDebugAvailable());
    const [entryEnabled, setEntryEnabledState] = useState<boolean>(() => readDevDebugEntryEnabled());
    const [hint, setHint] = useState<string | null>(null);
    const tapCountRef = useRef(0);
    const tapTimerRef = useRef<number | null>(null);
    const hintTimerRef = useRef<number | null>(null);

    useEffect(() => {
        let cancelled = false;
        querySwVersion().then((v) => { if (!cancelled) setSwVersion(v); });
        return () => { cancelled = true; };
    }, []);

    useEffect(() => subscribeDevDebugAvailability(setAvailable), []);
    useEffect(() => subscribeDevDebugEntryEnabled(setEntryEnabledState), []);

    // 卸载时清掉计时器，避免内存泄漏 / 卸载后 setState。
    useEffect(() => () => {
        if (tapTimerRef.current) window.clearTimeout(tapTimerRef.current);
        if (hintTimerRef.current) window.clearTimeout(hintTimerRef.current);
    }, []);

    const showHint = (text: string, ms: number) => {
        setHint(text);
        if (hintTimerRef.current) window.clearTimeout(hintTimerRef.current);
        hintTimerRef.current = window.setTimeout(() => setHint(null), ms);
    };

    const handleVersionTap = () => {
        if (available) return; // 面板已经开着（非 prod 或已解锁），不用再数
        if (tapTimerRef.current) window.clearTimeout(tapTimerRef.current);
        tapCountRef.current += 1;
        const remaining = UNLOCK_TAP_COUNT - tapCountRef.current;

        if (remaining <= 0) {
            tapCountRef.current = 0;
            unlockDevDebug();
            showHint('🔧 调试面板已解锁（刷新即关闭）', 2600);
            return;
        }
        if (remaining <= 2) showHint(`还差 ${remaining} 下…`, TAP_RESET_MS);
        // 间隔超过 TAP_RESET_MS 没继续点就重置计数。
        tapTimerRef.current = window.setTimeout(() => { tapCountRef.current = 0; }, TAP_RESET_MS);
    };

    return (
        <div className="flex flex-col items-center gap-1.5 pt-2 pb-8 select-none">
            <NativeAppUpdateSettingsCard />
            {isProductionBuild && (
                <div className="mt-1 mb-2 flex w-full max-w-[280px] items-center justify-between rounded-xl border border-slate-200/70 bg-white/60 px-3 py-2">
                    <div className="min-w-0 text-left">
                        <div className="text-[11px] font-semibold text-slate-500">调试工具</div>
                        <div className="mt-0.5 text-[9px] text-slate-400">显示现有悬浮扳手</div>
                    </div>
                    <button
                        type="button"
                        role="switch"
                        aria-checked={entryEnabled}
                        onClick={() => {
                            const next = !entryEnabled;
                            setEntryEnabledState(setDevDebugEntryEnabled(next));
                        }}
                        className={`relative h-6 w-11 shrink-0 rounded-full border transition-colors ${
                            entryEnabled
                                ? 'border-amber-300/70 bg-amber-300/80'
                                : 'border-slate-200 bg-slate-200'
                        }`}
                    >
                        <span
                            className={`absolute left-1 top-1/2 h-4 w-4 -translate-y-1/2 rounded-full bg-white shadow-sm transition-transform ${
                                entryEnabled ? 'translate-x-5' : 'translate-x-0'
                            }`}
                        />
                    </button>
                </div>
            )}
            <button
                type="button"
                onClick={handleVersionTap}
                className="text-[10px] text-slate-300 font-mono tracking-widest uppercase"
            >
                {APP_VERSION}
            </button>
            <div className="flex items-center gap-1.5 text-[9px] font-mono text-slate-400/80">
                <span className="px-1.5 py-0.5 rounded-md bg-slate-100 tracking-wide">
                    build&nbsp;<span className="text-slate-500">{BUILD_LABEL}</span>
                </span>
                <span className="px-1.5 py-0.5 rounded-md bg-slate-100 tracking-wide">
                    sw&nbsp;<span className="text-slate-500">{swVersion}</span>
                </span>
            </div>
            {hint && (
                <div className="text-[9px] font-mono text-amber-500/80 tracking-normal normal-case">
                    {hint}
                </div>
            )}
        </div>
    );
};

export default VersionInfo;
