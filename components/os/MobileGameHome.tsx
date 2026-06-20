import React, { useEffect, useMemo, useState } from 'react';
import { useOS } from '../../context/OSContext';
import { Icons, INSTALLED_APPS } from '../../constants';
import { AppID, CharacterProfile } from '../../types';
import { DB } from '../../utils/db';
import AppIcon from './AppIcon';
import { isDevDebugAvailable, subscribeDevDebugAvailability } from '../../utils/devDebug';

// ===== 手游主题（mobilegame skin）=====
// 二次元手游首页风格的桌面：顶部角色卡 + 等级经验条 + 货币栏、大时钟、公告卡、
// 快捷入口、网格 App 卡、底部 dock。整页自渲染，不复用 default/动森 的启动器布局。
// 设计参考：紫粉赛博 + 玻璃拟态。所有等级 / 经验 / 货币为装饰性数值（按角色 id 稳定派生）。

// 稳定的字符串哈希 —— 让同一个角色每次都显示一致的「等级 / 货币」装饰数值。
const hashStr = (s: string): number => {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return h >>> 0;
};

// 顶部快捷入口（圆形图标）
const QUICK_ENTRIES: { id: AppID; cn: string }[] = [
    { id: AppID.Character, cn: '神经链接' },
    { id: AppID.MemoryPalace, cn: '记忆宫殿' },
    { id: AppID.Call, cn: '电话' },
    { id: AppID.Room, cn: '小小窝' },
];

// 主网格大卡（中文名 + 英文副标）
const GRID_CARDS: { id: AppID; cn: string; en: string }[] = [
    { id: AppID.CheckPhone, cn: '查手机', en: 'PHONE' },
    { id: AppID.Date, cn: '见面', en: 'CONTACTS' },
    { id: AppID.User, cn: '档案', en: 'ARCHIVES' },
    { id: AppID.Bank, cn: '存钱罐', en: 'PIGGYBANK' },
    { id: AppID.Schedule, cn: '日程', en: 'SCHEDULE' },
    { id: AppID.Settings, cn: '设置', en: 'SETTINGS' },
];

const DAYS = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'];
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

const renderGlyph = (iconKey: string, className: string) => {
    const Comp = Icons[iconKey] || Icons.Settings;
    return <Comp className={className} />;
};

const MobileGameHome: React.FC = () => {
    const { openApp, characters, activeCharacterId, virtualTime, unreadMessages, isDataLoaded, lastMsgTimestamp } = useOS();

    const [widgetChar, setWidgetChar] = useState<CharacterProfile | null>(null);
    const [lastMessage, setLastMessage] = useState<string>('');
    const [drawerOpen, setDrawerOpen] = useState(false);

    const [devDebugVisible, setDevDebugVisible] = useState(() => isDevDebugAvailable());
    useEffect(() => subscribeDevDebugAvailability(setDevDebugVisible), []);

    // 载入当前角色 + 最近一条消息（公告卡 / 角色卡用）
    useEffect(() => {
        if (!isDataLoaded) return;
        if (!characters || characters.length === 0) {
            setWidgetChar(null);
            setLastMessage('');
            return;
        }
        const target = characters.find(c => c.id === activeCharacterId) || characters[0];
        setWidgetChar(target);
        DB.getMessagesByCharId(target.id).then(msgs => {
            const visible = msgs.filter(m => m.role !== 'system');
            if (visible.length > 0) {
                const last = visible[visible.length - 1];
                const clean = last.content.replace(/\[.*?\]/g, '').trim();
                setLastMessage(clean || (last.type === 'image' ? '[图片]' : '[消息]'));
            } else {
                setLastMessage(target.description || '');
            }
        }).catch(() => {});
    }, [activeCharacterId, lastMsgTimestamp, isDataLoaded, characters]);

    const totalUnread = useMemo(
        () => Object.values(unreadMessages).reduce((a, b) => a + b, 0),
        [unreadMessages]
    );

    // 装饰性等级 / 经验 / 货币 —— 按角色 id 稳定派生
    const stats = useMemo(() => {
        const seed = hashStr(widgetChar?.id || 'sullyos');
        const level = 1 + (seed % 60);
        const expMax = 1200 + level * 200;
        const exp = 800 + ((seed >> 3) % (expMax - 800));
        const gems = 500 + ((seed >> 5) % 9000);
        const stars = 20 + ((seed >> 7) % 480);
        return { level, exp, expMax, gems, stars };
    }, [widgetChar?.id]);

    const greeting = virtualTime.hours < 5 ? 'Good Night'
        : virtualTime.hours < 12 ? 'Good Morning'
        : virtualTime.hours < 18 ? 'Good Afternoon'
        : 'Good Evening';
    const hh = virtualTime.hours.toString().padStart(2, '0');
    const mm = virtualTime.minutes.toString().padStart(2, '0');
    const now = new Date();
    const dayName = DAYS[now.getDay()];
    const monthName = MONTHS[now.getMonth()];
    const dateNum = now.getDate();

    const charName = widgetChar?.name || 'SullyOS';
    const tagline = (widgetChar?.description || '「彼方 · 娱乐室」的舞台，永不落幕。').slice(0, 40);
    const announcement = lastMessage || widgetChar?.description || '一切如常，等待新的故事发生。';

    const expPct = Math.min(100, Math.round((stats.exp / stats.expMax) * 100));

    const drawerApps = useMemo(
        () => INSTALLED_APPS.filter(a => a.id !== AppID.CharCreatorDev || devDebugVisible),
        [devDebugVisible]
    );

    // ---- 视觉常量 ----
    const cardBg = 'linear-gradient(150deg, rgba(72,46,120,0.42), rgba(120,52,110,0.30))';
    const cardBorder = '1px solid rgba(214,188,255,0.30)';
    const cardShadow = '0 8px 28px rgba(40,12,70,0.35), inset 0 1px 0 rgba(255,255,255,0.12)';

    const Pill: React.FC<{ icon: React.ReactNode; value: string }> = ({ icon, value }) => (
        <div className="flex items-center gap-1.5 pl-1.5 pr-2 py-1 rounded-full"
            style={{ background: 'rgba(30,16,54,0.5)', border: '1px solid rgba(214,188,255,0.3)' }}>
            {icon}
            <span className="text-[12px] font-extrabold tabular-nums text-white drop-shadow">{value}</span>
            <span className="w-4 h-4 rounded-full flex items-center justify-center text-[11px] font-bold leading-none text-white"
                style={{ background: 'rgba(255,255,255,0.18)' }}>+</span>
        </div>
    );

    return (
        <div
            className="h-full w-full relative z-10 overflow-hidden font-sans select-none"
            style={{ color: '#ffffff' }}
        >
            {/* 压暗 / 染色层：保证文字在任意壁纸上可读，并统一紫粉氛围 */}
            <div className="absolute inset-0 pointer-events-none"
                style={{ background: 'linear-gradient(180deg, rgba(28,12,52,0.55) 0%, rgba(36,14,58,0.25) 35%, rgba(26,10,48,0.6) 100%)' }} />
            <div className="absolute -top-24 -right-16 w-72 h-72 rounded-full pointer-events-none"
                style={{ background: 'radial-gradient(circle, rgba(244,114,182,0.25), transparent 70%)' }} />
            <div className="absolute top-1/3 -left-20 w-72 h-72 rounded-full pointer-events-none"
                style={{ background: 'radial-gradient(circle, rgba(129,140,248,0.22), transparent 70%)' }} />

            <div
                className="relative h-full overflow-y-auto no-scrollbar px-5"
                style={{ paddingTop: 'calc(var(--safe-top, 0px) + 1rem)', paddingBottom: '7.5rem' }}
            >
                {/* ===== 顶部角色卡 ===== */}
                <div className="flex items-start gap-3 animate-fade-in">
                    {/* 头像 + 等级 */}
                    <div className="relative shrink-0" onClick={() => openApp(AppID.Character)}>
                        <div className="w-[68px] h-[68px] rounded-full p-[2.5px] cursor-pointer active:scale-95 transition-transform"
                            style={{ background: 'linear-gradient(135deg, #f0abfc, #818cf8, #67e8f9)', boxShadow: '0 0 16px rgba(192,132,252,0.55)' }}>
                            <div className="w-full h-full rounded-full overflow-hidden bg-[#2a1840] border-2 border-[#1c0f33]">
                                {widgetChar?.avatar
                                    ? <img src={widgetChar.avatar} className="w-full h-full object-cover" alt="char" loading="lazy" />
                                    : <div className="w-full h-full flex items-center justify-center text-2xl">✦</div>}
                            </div>
                        </div>
                        <div className="absolute -bottom-1 left-1/2 -translate-x-1/2 px-2 py-[1px] rounded-full text-[10px] font-black tracking-wide whitespace-nowrap"
                            style={{ background: 'linear-gradient(135deg,#fbbf24,#f59e0b)', color: '#3a1d00', boxShadow: '0 2px 6px rgba(0,0,0,0.3)' }}>
                            Lv.{stats.level}
                        </div>
                    </div>

                    {/* 名字 + 标语 + 经验条 */}
                    <div className="flex-1 min-w-0 pt-0.5">
                        <div className="flex items-center gap-2">
                            <h2 className="text-lg font-black truncate drop-shadow-md">{charName}</h2>
                            <span className="flex items-center gap-1 px-1.5 py-px rounded-full text-[8px] font-bold tracking-[0.12em]"
                                style={{ background: 'rgba(74,222,128,0.2)', border: '1px solid rgba(74,222,128,0.4)' }}>
                                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" style={{ boxShadow: '0 0 6px #4ade80' }} />
                                ONLINE
                            </span>
                        </div>
                        <p className="text-[11px] leading-snug mt-0.5 line-clamp-2 opacity-80">{tagline}</p>
                        {/* EXP */}
                        <div className="flex items-center gap-2 mt-2">
                            <span className="text-[9px] font-black tracking-widest opacity-70">EXP</span>
                            <div className="flex-1 h-2 rounded-full overflow-hidden" style={{ background: 'rgba(20,10,38,0.6)', border: '1px solid rgba(214,188,255,0.25)' }}>
                                <div className="h-full rounded-full" style={{ width: `${expPct}%`, background: 'linear-gradient(90deg,#f472b6,#a78bfa,#67e8f9)', boxShadow: '0 0 8px rgba(167,139,250,0.7)' }} />
                            </div>
                            <span className="text-[9px] font-bold tabular-nums opacity-75">{stats.exp}/{stats.expMax}</span>
                        </div>
                    </div>
                </div>

                {/* ===== 货币栏 + 菜单 ===== */}
                <div className="flex items-center justify-end gap-2 mt-3 animate-fade-in">
                    <Pill
                        icon={<svg viewBox="0 0 24 24" className="w-3.5 h-3.5"><path d="M6 3h12l3 5-9 13L3 8z" fill="#67e8f9" stroke="#22d3ee" strokeWidth="1" strokeLinejoin="round" /></svg>}
                        value={stats.gems.toLocaleString()}
                    />
                    <Pill
                        icon={<svg viewBox="0 0 24 24" className="w-3.5 h-3.5"><path d="M12 2l2.9 6.3 6.9.7-5.2 4.6 1.5 6.8L12 17.8 5.9 20.4l1.5-6.8L2.2 9l6.9-.7z" fill="#fbbf24" stroke="#f59e0b" strokeWidth="0.8" strokeLinejoin="round" /></svg>}
                        value={stats.stars.toString()}
                    />
                    <button onClick={() => openApp(AppID.Appearance)} aria-label="菜单"
                        className="w-9 h-9 rounded-full flex flex-col items-center justify-center gap-[3px] active:scale-90 transition-transform"
                        style={{ background: 'rgba(30,16,54,0.5)', border: '1px solid rgba(214,188,255,0.3)' }}>
                        <span className="w-4 h-[2px] rounded-full bg-white/85" />
                        <span className="w-4 h-[2px] rounded-full bg-white/85" />
                        <span className="w-4 h-[2px] rounded-full bg-white/85" />
                    </button>
                </div>

                {/* ===== 时钟 ===== */}
                <div className="flex items-end justify-between mt-5 animate-fade-in">
                    <div>
                        <div className="text-[5.5rem] leading-[0.8] font-black tracking-tighter drop-shadow-2xl"
                            style={{ fontFamily: `'Space Grotesk','SF Pro Display',sans-serif`, fontFeatureSettings: '"tnum"' }}>
                            {hh}<span className="opacity-50 animate-pulse mx-0.5">:</span>{mm}
                        </div>
                        <div className="text-[1.4rem] -mt-1 font-semibold italic"
                            style={{ fontFamily: `'Brush Script MT','Segoe Script',cursive`, color: '#f0abfc', textShadow: '0 0 12px rgba(240,171,252,0.5)' }}>
                            {greeting}
                        </div>
                    </div>
                    <div className="text-right pb-2">
                        <div className="text-[11px] font-bold tracking-[0.18em] opacity-85">{dayName}</div>
                        <div className="text-[2.6rem] leading-none font-black" style={{ fontFamily: `'Space Grotesk',sans-serif` }}>{dateNum}</div>
                        <div className="text-[11px] font-bold tracking-[0.2em] opacity-70">{monthName}</div>
                    </div>
                </div>

                {/* ===== 最新公告 ===== */}
                <button onClick={() => openApp(AppID.HotNews)}
                    className="w-full text-left mt-5 rounded-2xl p-4 flex items-center gap-3 active:scale-[0.99] transition-transform animate-fade-in"
                    style={{ background: cardBg, border: cardBorder, boxShadow: cardShadow, backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)' }}>
                    <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5 mb-1.5">
                            <span className="text-[#67e8f9]">✦</span>
                            <span className="text-[13px] font-extrabold">最新公告</span>
                            <span className="px-1.5 py-px rounded text-[8px] font-black tracking-wider"
                                style={{ background: 'linear-gradient(135deg,#f472b6,#fb7185)', color: '#fff' }}>NEW</span>
                        </div>
                        <p className="text-[11px] leading-relaxed opacity-80 line-clamp-2">{announcement}</p>
                    </div>
                    <div className="w-7 h-7 shrink-0 rounded-full flex items-center justify-center"
                        style={{ background: 'rgba(255,255,255,0.1)', border: '1px solid rgba(255,255,255,0.18)' }}>
                        <svg viewBox="0 0 24 24" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2.5"><path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" /></svg>
                    </div>
                </button>

                {/* ===== 快捷入口 ===== */}
                <div className="mt-4 rounded-2xl p-4 animate-fade-in"
                    style={{ background: cardBg, border: cardBorder, boxShadow: cardShadow, backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)' }}>
                    <div className="flex items-center gap-1.5 mb-3">
                        <span className="text-[#f0abfc]">✦</span>
                        <span className="text-[13px] font-extrabold">快捷入口</span>
                    </div>
                    <div className="grid grid-cols-4 gap-2">
                        {QUICK_ENTRIES.map(e => (
                            <button key={e.id} onClick={() => openApp(e.id)}
                                className="flex flex-col items-center gap-1.5 active:scale-90 transition-transform">
                                <div className="w-12 h-12 rounded-full flex items-center justify-center"
                                    style={{ background: 'radial-gradient(circle at 30% 25%, rgba(167,139,250,0.55), rgba(76,40,120,0.6))', border: '1px solid rgba(214,188,255,0.4)', boxShadow: '0 4px 14px rgba(60,20,100,0.4)' }}>
                                    <div className="w-6 h-6 text-white">{renderGlyph(INSTALLED_APPS.find(a => a.id === e.id)?.icon || 'Settings', 'w-full h-full')}</div>
                                </div>
                                <span className="text-[10px] font-bold opacity-90">{e.cn}</span>
                            </button>
                        ))}
                    </div>
                </div>

                {/* ===== App 网格卡 ===== */}
                <div className="grid grid-cols-2 gap-3 mt-4">
                    {GRID_CARDS.map(card => (
                        <button key={card.id} onClick={() => openApp(card.id)}
                            className="relative h-24 rounded-2xl p-3.5 flex flex-col justify-between text-left overflow-hidden active:scale-[0.97] transition-transform animate-fade-in"
                            style={{ background: cardBg, border: cardBorder, boxShadow: cardShadow, backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)' }}>
                            <div className="absolute -right-3 -bottom-3 w-16 h-16 opacity-25 rotate-12 text-white pointer-events-none">
                                {renderGlyph(INSTALLED_APPS.find(a => a.id === card.id)?.icon || 'Settings', 'w-full h-full')}
                            </div>
                            <div className="absolute top-2 right-2 w-1.5 h-1.5 rounded-full" style={{ background: '#67e8f9', boxShadow: '0 0 8px #67e8f9' }} />
                            <div className="relative">
                                <div className="text-[17px] font-black drop-shadow">{card.cn}</div>
                                <div className="text-[9px] font-bold tracking-[0.2em] opacity-55 mt-0.5">{card.en}</div>
                            </div>
                            <div className="relative w-7 h-7 rounded-lg flex items-center justify-center"
                                style={{ background: 'rgba(255,255,255,0.12)', border: '1px solid rgba(255,255,255,0.18)' }}>
                                <div className="w-4 h-4 text-white">{renderGlyph(INSTALLED_APPS.find(a => a.id === card.id)?.icon || 'Settings', 'w-full h-full')}</div>
                            </div>
                        </button>
                    ))}
                </div>
            </div>

            {/* ===== 底部 Dock ===== */}
            <div className="absolute bottom-0 left-0 w-full px-4 z-30 pointer-events-none"
                style={{ paddingBottom: 'calc(var(--safe-bottom, 0px) + 0.75rem)' }}>
                <div className="relative pointer-events-auto rounded-[1.75rem] px-3 py-2.5 flex items-end justify-between"
                    style={{ background: 'linear-gradient(180deg, rgba(48,24,82,0.6), rgba(30,14,54,0.75))', border: '1px solid rgba(214,188,255,0.3)', boxShadow: '0 -4px 30px rgba(20,6,46,0.5), inset 0 1px 0 rgba(255,255,255,0.1)', backdropFilter: 'blur(18px)', WebkitBackdropFilter: 'blur(18px)' }}>
                    <DockItem id={AppID.Chat} cn="消息" badge={totalUnread} onClick={() => openApp(AppID.Chat)} />
                    <DockItem id={AppID.Character} cn="好友" badge={characters?.length || 0} badgeColor="#a78bfa" onClick={() => openApp(AppID.Character)} />
                    {/* 中央罗盘 —— 打开「全部应用」抽屉 */}
                    <button onClick={() => setDrawerOpen(true)} aria-label="全部应用"
                        className="-mt-7 w-16 h-16 rounded-full flex items-center justify-center active:scale-95 transition-transform shrink-0"
                        style={{ background: 'linear-gradient(135deg,#f0abfc,#818cf8,#67e8f9)', boxShadow: '0 6px 22px rgba(129,140,248,0.6), inset 0 2px 6px rgba(255,255,255,0.4)' }}>
                        <div className="w-12 h-12 rounded-full flex items-center justify-center" style={{ background: 'rgba(28,12,52,0.45)' }}>
                            <svg viewBox="0 0 24 24" className="w-7 h-7" fill="#fff">
                                <path d="M12 2l2 7 7-2-5 5 5 5-7-2-2 7-2-7-7 2 5-5-5-5 7 2z" opacity="0.95" />
                                <circle cx="12" cy="12" r="2" fill="#67e8f9" />
                            </svg>
                        </div>
                    </button>
                    <DockItem id={AppID.Social} cn="动态" onClick={() => openApp(AppID.Social)} />
                    <DockItem id={AppID.ThemeMaker} cn="商城" onClick={() => openApp(AppID.ThemeMaker)} />
                </div>
            </div>

            {/* ===== 全部应用抽屉 ===== */}
            {drawerOpen && (
                <div className="absolute inset-0 z-40 flex flex-col animate-fade-in"
                    style={{ background: 'rgba(18,8,36,0.82)', backdropFilter: 'blur(24px)', WebkitBackdropFilter: 'blur(24px)' }}
                    onClick={() => setDrawerOpen(false)}>
                    <div className="flex items-center justify-between px-6"
                        style={{ paddingTop: 'calc(var(--safe-top, 0px) + 1.25rem)', paddingBottom: '0.5rem' }}>
                        <h2 className="text-base font-black tracking-wide">全部应用</h2>
                        <button onClick={(e) => { e.stopPropagation(); setDrawerOpen(false); }} aria-label="关闭"
                            className="w-9 h-9 rounded-full flex items-center justify-center active:scale-90 transition-transform"
                            style={{ background: 'rgba(255,255,255,0.12)', border: '1px solid rgba(255,255,255,0.2)' }}>
                            <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none" stroke="#fff" strokeWidth="2.5"><path strokeLinecap="round" d="M6 6l12 12M18 6L6 18" /></svg>
                        </button>
                    </div>
                    <div className="flex-1 overflow-y-auto no-scrollbar px-5 pb-8" onClick={(e) => e.stopPropagation()}>
                        <div className="grid grid-cols-4 gap-y-5 gap-x-2 place-items-center">
                            {drawerApps.map(app => (
                                <AppIcon key={app.id} app={app} size="md" onClick={() => { setDrawerOpen(false); openApp(app.id); }} />
                            ))}
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};

// 底部 dock 单项
const DockItem: React.FC<{ id: AppID; cn: string; badge?: number; badgeColor?: string; onClick: () => void }> = ({ id, cn, badge = 0, badgeColor = '#fb7185', onClick }) => {
    const iconKey = INSTALLED_APPS.find(a => a.id === id)?.icon || 'Settings';
    return (
        <button onClick={onClick} className="relative flex flex-col items-center gap-1 w-14 active:scale-90 transition-transform">
            <div className="relative w-7 h-7 text-white/90">
                {renderGlyph(iconKey, 'w-full h-full')}
                {badge > 0 && (
                    <span className="absolute -top-1.5 -right-2 min-w-[16px] h-4 px-1 rounded-full flex items-center justify-center text-[9px] font-bold text-white border border-white/30"
                        style={{ background: badgeColor }}>
                        {badge > 99 ? '99+' : badge}
                    </span>
                )}
            </div>
            <span className="text-[10px] font-bold opacity-85">{cn}</span>
        </button>
    );
};

export default MobileGameHome;
