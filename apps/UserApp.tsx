
import React, { useRef } from 'react';
import { useOS } from '../context/OSContext';
import { processImage } from '../utils/file';

/* ── 装饰小组件 ───────────────────────────────────────── */

// 四角星 / 闪光
const Sparkle: React.FC<{ className?: string; style?: React.CSSProperties }> = ({ className, style }) => (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} style={style} aria-hidden>
        <path d="M12 0c.6 6.2 1.8 7.4 8 8-6.2.6-7.4 1.8-8 8-.6-6.2-1.8-7.4-8-8 6.2-.6 7.4-1.8 8-8Z" />
    </svg>
);

// 羽毛笔
const Feather: React.FC<{ className?: string; style?: React.CSSProperties }> = ({ className, style }) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" className={className} style={style} aria-hidden>
        <path d="M20.24 4c-3.4-.5-9.5.4-12.7 5.5-2 3.2-2 7-1.3 9.2" />
        <path d="M6.2 18.7C9.5 12 14.5 9.2 19 8.5" />
        <path d="M4 21l2-2.3" />
    </svg>
);

// 漂浮的小星点装饰层
const StarField: React.FC = () => {
    const stars = [
        { top: '8%', left: '12%', size: 10, delay: '0s', op: 0.7 },
        { top: '14%', left: '82%', size: 14, delay: '0.6s', op: 0.85 },
        { top: '30%', left: '6%', size: 8, delay: '1.2s', op: 0.5 },
        { top: '46%', left: '90%', size: 12, delay: '0.3s', op: 0.7 },
        { top: '63%', left: '10%', size: 9, delay: '0.9s', op: 0.6 },
        { top: '78%', left: '86%', size: 13, delay: '1.5s', op: 0.75 },
        { top: '88%', left: '20%', size: 8, delay: '0.45s', op: 0.5 },
    ];
    return (
        <div className="pointer-events-none absolute inset-0 overflow-hidden">
            {stars.map((s, i) => (
                <Sparkle
                    key={i}
                    className="absolute text-white animate-glow-pulse"
                    style={{ top: s.top, left: s.left, width: s.size, height: s.size, opacity: s.op, animationDelay: s.delay, filter: 'drop-shadow(0 0 4px rgba(255,255,255,0.9))' }}
                />
            ))}
        </div>
    );
};

/* ── 主组件 ──────────────────────────────────────────── */

const GOLD = 'linear-gradient(135deg, #f7ebc4 0%, #d9b66a 35%, #f3e2a8 60%, #c79f50 100%)';

const UserApp: React.FC = () => {
    const { closeApp, userProfile, updateUserProfile, addToast } = useOS();
    const fileInputRef = useRef<HTMLInputElement>(null);

    const handleAvatarChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (file) {
            try {
                const base64 = await processImage(file);
                updateUserProfile({ avatar: base64 });
                addToast('头像已更新', 'success');
            } catch (err: any) {
                addToast(err.message, 'error');
            }
        }
    };

    return (
        <div
            className="h-full w-full flex flex-col animate-fade-in relative overflow-hidden"
            style={{
                background:
                    'radial-gradient(120% 80% at 50% 0%, #9a8fd6 0%, #ab9fdd 22%, #c4b6e8 48%, #ddcfee 72%, #f0e6f5 100%)',
                fontFamily: "'ZCOOL XiaoWei', 'Noto Sans SC', serif",
            }}
        >
            {/* 星点装饰 */}
            <StarField />

            {/* ── 顶栏 ───────────────────────────── */}
            <div className="shrink-0 sticky top-0 z-20 relative" style={{ paddingTop: 'var(--safe-top)' }}>
                <div className="flex items-center justify-between px-4 py-3">
                    <button
                        onClick={closeApp}
                        className="w-10 h-10 flex items-center justify-center rounded-full active:scale-90 transition-transform"
                        style={{ background: 'rgba(255,255,255,0.25)', border: '1px solid rgba(247,235,196,0.6)', boxShadow: '0 2px 10px rgba(90,70,160,0.15)' }}
                    >
                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-5 h-5" style={{ color: '#6b5aa0' }}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5" />
                        </svg>
                    </button>

                    <h1 className="flex items-center gap-2 text-2xl tracking-[0.15em]" style={{ color: '#4f3f7e', textShadow: '0 1px 2px rgba(255,255,255,0.6)' }}>
                        <Sparkle className="w-4 h-4" style={{ color: '#cda64f' }} />
                        个人档案
                        <Sparkle className="w-4 h-4" style={{ color: '#cda64f' }} />
                    </h1>

                    <div
                        className="w-10 h-10 flex items-center justify-center rounded-full"
                        style={{ background: 'rgba(255,255,255,0.25)', border: '1px solid rgba(247,235,196,0.6)' }}
                    >
                        <Sparkle className="w-5 h-5" style={{ color: '#cda64f', filter: 'drop-shadow(0 0 4px rgba(205,166,79,0.7))' }} />
                    </div>
                </div>
                {/* 金色分隔线 */}
                <div className="px-6">
                    <div className="h-px w-full" style={{ background: 'linear-gradient(90deg, transparent, rgba(205,166,79,0.7), transparent)' }} />
                </div>
            </div>

            {/* ── 内容区 ─────────────────────────── */}
            <div className="profile-scroll flex-1 overflow-y-auto px-6 pb-10 pt-4 space-y-7 relative z-10">

                {/* 头像 */}
                <div className="flex flex-col items-center pt-2">
                    <div
                        onClick={() => fileInputRef.current?.click()}
                        className="relative w-36 h-36 cursor-pointer group"
                    >
                        {/* 光晕 */}
                        <div className="absolute -inset-2 rounded-full" style={{ background: 'radial-gradient(circle, rgba(199,178,255,0.55), transparent 70%)', filter: 'blur(6px)' }} />
                        {/* 金环 */}
                        <div className="relative w-full h-full rounded-full p-[3px]" style={{ background: GOLD, boxShadow: '0 8px 24px rgba(90,70,160,0.35)' }}>
                            <div className="w-full h-full rounded-full p-[4px]" style={{ background: 'rgba(255,255,255,0.85)' }}>
                                <div className="w-full h-full rounded-full p-[2px]" style={{ background: GOLD }}>
                                    <img src={userProfile.avatar} className="w-full h-full rounded-full object-cover group-hover:opacity-80 transition-opacity" />
                                </div>
                            </div>
                        </div>
                        {/* hover 提示 */}
                        <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                            <span className="text-xs px-3 py-1 rounded-full" style={{ color: '#4f3f7e', background: 'rgba(255,255,255,0.85)' }}>更换</span>
                        </div>
                        {/* 底部星形吊坠 */}
                        <div className="absolute left-1/2 -bottom-3 -translate-x-1/2 w-9 h-9 rounded-full flex items-center justify-center rotate-45" style={{ background: GOLD, boxShadow: '0 4px 12px rgba(90,70,160,0.4)', border: '2px solid rgba(255,255,255,0.7)' }}>
                            <Sparkle className="w-4 h-4 -rotate-45" style={{ color: '#5a4690' }} />
                        </div>
                    </div>
                    <input type="file" ref={fileInputRef} className="hidden" accept="image/*" onChange={handleAvatarChange} />
                </div>

                {/* 名字 */}
                <div className="space-y-2">
                    <div className="flex items-center gap-2 pl-1">
                        <span className="w-7 h-7 rounded-lg flex items-center justify-center" style={{ background: 'rgba(255,255,255,0.4)', border: '1px solid rgba(247,235,196,0.7)' }}>
                            <Feather className="w-4 h-4" style={{ color: '#8b76c4' }} />
                        </span>
                        <label className="text-base tracking-wide" style={{ color: '#4f3f7e' }}>你的名字</label>
                    </div>
                    <div className="rounded-2xl p-[1.5px]" style={{ background: GOLD, boxShadow: '0 6px 18px rgba(120,100,180,0.18)' }}>
                        <input
                            value={userProfile.name}
                            onChange={(e) => updateUserProfile({ name: e.target.value })}
                            className="w-full rounded-2xl px-5 py-4 text-2xl outline-none"
                            style={{ background: 'rgba(255,255,255,0.65)', color: '#3f3168', backdropFilter: 'blur(4px)' }}
                        />
                    </div>
                </div>

                {/* 关于我 */}
                <div className="space-y-2">
                    <div className="flex items-center gap-2 pl-1">
                        <span className="w-7 h-7 rounded-lg flex items-center justify-center" style={{ background: 'rgba(255,255,255,0.4)', border: '1px solid rgba(247,235,196,0.7)' }}>
                            <Sparkle className="w-4 h-4" style={{ color: '#8b76c4' }} />
                        </span>
                        <label className="text-base tracking-wide" style={{ color: '#4f3f7e' }}>关于我 / 设定</label>
                    </div>
                    <p className="text-xs pl-1" style={{ color: '#7d6da8' }}>这些信息会发送给 AI，以便它更好地了解你（例如：大学生、喜欢吃辣、性格内向）。</p>
                    <div className="rounded-2xl p-[1.5px]" style={{ background: GOLD, boxShadow: '0 6px 18px rgba(120,100,180,0.18)' }}>
                        <div className="relative rounded-2xl overflow-hidden" style={{ background: 'rgba(255,255,255,0.6)', backdropFilter: 'blur(4px)' }}>
                            {/* 角落罗盘装饰 */}
                            <Sparkle className="pointer-events-none absolute -right-6 -bottom-6 w-28 h-28" style={{ color: 'rgba(139,118,196,0.12)' }} />
                            <textarea
                                value={userProfile.bio}
                                onChange={(e) => updateUserProfile({ bio: e.target.value })}
                                className="relative w-full h-56 px-5 py-4 text-base leading-relaxed resize-none outline-none bg-transparent"
                                style={{ color: '#3f3168' }}
                                placeholder="描述你自己..."
                            />
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default UserApp;
