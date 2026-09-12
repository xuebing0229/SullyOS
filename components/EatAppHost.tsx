import React, { Suspense } from 'react';
import { useOS } from '../context/OSContext';

const EatApp = React.lazy(() => import('../apps/EatApp'));

/**
 * 「吃了吗」使用字符串 AppID 挂载，避免为了一个新入口重写庞大的 types.ts / PhoneShell。
 * Launcher 仍走标准 openApp 流程；这里仅在 activeApp === "eat" 时覆盖渲染独立 App。
 */
const EatAppHost: React.FC = () => {
    const { activeApp } = useOS();
    if (String(activeApp) !== 'eat') return null;

    return (
        <div className="fixed inset-0 z-[120] bg-[#f8f5ed]">
            <Suspense fallback={(
                <div className="h-full w-full grid place-items-center bg-[#f8f5ed] text-xs font-bold text-[#7e8b79]">
                    正在打开厨房…
                </div>
            )}>
                <EatApp />
            </Suspense>
        </div>
    );
};

export default EatAppHost;
