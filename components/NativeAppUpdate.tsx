import React, { useEffect, useState } from 'react';
import { APP_RELEASE_VERSION } from '../utils/buildInfo';
import {
    type AppRelease,
    checkForAppUpdate,
    downloadAndInstallAppUpdate,
    isAndroidApp,
    snoozeAppUpdate,
} from '../utils/appUpdate';

const sizeLabel = (bytes: number): string => bytes > 0 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : 'APK';

const UpdateCard: React.FC<{ release: AppRelease; onClose?: () => void; compact?: boolean }> = ({ release, onClose, compact }) => {
    const [status, setStatus] = useState('');
    const [busy, setBusy] = useState(false);

    const install = async () => {
        setBusy(true);
        setStatus('正在准备下载…');
        try {
            const result = await downloadAndInstallAppUpdate(release);
            if (result === 'permission_required') {
                setStatus('请在系统页面允许“安装未知应用”，返回后再点一次更新。');
            } else {
                setStatus('正在后台下载，完成后会自动弹出安装页面。');
            }
        } catch (error: any) {
            setStatus(error?.message || '下载失败，请稍后重试。');
        } finally {
            setBusy(false);
        }
    };

    const content = (
        <div className={compact ? 'w-full rounded-2xl border border-violet-100 bg-violet-50/70 p-3' : 'relative w-full max-w-sm rounded-[2rem] border border-white/40 bg-white/95 p-6 shadow-2xl'}>
            <div className="flex items-start justify-between gap-3">
                <div>
                    <div className="text-sm font-extrabold text-slate-800">发现新版本 v{release.version}</div>
                    <div className="mt-1 text-[10px] text-slate-400">当前 v{APP_RELEASE_VERSION} · {sizeLabel(release.apkSize)}</div>
                </div>
                {onClose && (
                    <button type="button" onClick={onClose} className="text-lg leading-none text-slate-300" aria-label="暂不更新">×</button>
                )}
            </div>
            {release.notes && <p className="mt-3 max-h-28 overflow-auto whitespace-pre-wrap text-[11px] leading-relaxed text-slate-600">{release.notes}</p>}
            {status && <p className="mt-3 rounded-xl bg-white/80 px-3 py-2 text-[10px] leading-relaxed text-violet-600">{status}</p>}
            <button type="button" disabled={busy} onClick={install} className="mt-4 w-full rounded-2xl bg-violet-500 py-3 text-xs font-bold text-white shadow-md shadow-violet-200 active:scale-95 disabled:opacity-60">
                {busy ? '请稍候…' : '下载并更新'}
            </button>
            <p className="mt-2 text-center text-[9px] text-slate-400">Android 会显示系统安装确认；应用数据不会被清除。</p>
        </div>
    );

    if (compact) return content;
    return <div className="fixed inset-0 z-[9999] flex items-center justify-center p-5"><div className="absolute inset-0 bg-black/60 backdrop-blur-md" />{content}</div>;
};

export const NativeAppUpdateController: React.FC<{ blocked?: boolean }> = ({ blocked }) => {
    const [release, setRelease] = useState<AppRelease | null>(null);
    useEffect(() => {
        if (blocked || !isAndroidApp()) return;
        let cancelled = false;
        const timer = window.setTimeout(() => {
            void checkForAppUpdate({ respectSnooze: true }).then((next) => {
                if (!cancelled) setRelease(next);
            }).catch(() => { /* 启动检查失败不打扰用户 */ });
        }, 3500);
        return () => { cancelled = true; window.clearTimeout(timer); };
    }, [blocked]);
    if (!release || blocked) return null;
    return <UpdateCard release={release} onClose={() => { snoozeAppUpdate(release.tag); setRelease(null); }} />;
};

export const NativeAppUpdateSettingsCard: React.FC = () => {
    const [release, setRelease] = useState<AppRelease | null>(null);
    const [status, setStatus] = useState('');
    const [busy, setBusy] = useState(false);
    if (!isAndroidApp()) return null;

    const check = async () => {
        setBusy(true);
        setStatus('正在检查…');
        try {
            const next = await checkForAppUpdate({ force: true });
            setRelease(next);
            setStatus(next ? '' : '已经是最新版');
        } catch (error: any) {
            setStatus(error?.message || '检查失败，请稍后重试');
        } finally {
            setBusy(false);
        }
    };

    if (release) return <UpdateCard release={release} compact />;
    return (
        <div className="mb-2 flex w-full max-w-[280px] items-center justify-between rounded-xl border border-violet-100 bg-violet-50/60 px-3 py-2">
            <div className="min-w-0 text-left">
                <div className="text-[11px] font-semibold text-violet-600">应用更新</div>
                <div className="mt-0.5 text-[9px] text-slate-400">{status || `安装版 v${APP_RELEASE_VERSION}`}</div>
            </div>
            <button type="button" disabled={busy} onClick={check} className="shrink-0 rounded-lg bg-violet-500 px-3 py-1.5 text-[10px] font-bold text-white disabled:opacity-60">
                {busy ? '检查中' : '检查更新'}
            </button>
        </div>
    );
};
