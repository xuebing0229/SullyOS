import React, { useEffect, useMemo, useState } from 'react';
import { useOS } from '../../context/OSContext';
import { Icons, INSTALLED_APPS } from '../../constants';
import { AppID, CharacterProfile } from '../../types';
import { DB } from '../../utils/db';
import AppIcon from './AppIcon';
import { isDevDebugAvailable, subscribeDevDebugAvailability } from '../../utils/devDebug';

// ===== 手游主题（mobilegame skin）=====
// 风格：「硝子色の街」浅色玻璃蓝灰 + 复古杂志排版（重返未来1999 风味）。
// 全宽杂志风：居中衬线标题、发丝分隔线、大量留白、目录编号卡片。
// 背景透出用户自设壁纸（默认铺浅玻璃渐变壁纸）。
// 等级 / 经验 / 货币为按角色 id 稳定派生的装饰数值。

// —— 调色板（硝子色の街）——
const PAL = {
    ink: '#243237',      // 主文字 · 深板岩
    steel: '#5f7682',    // 次文字 · 钢蓝
    steelSoft: '#81959f',
    sea: '#a5bec1',      // 海玻璃
    powder: '#c7d8df',   // 粉蓝
    pearl: '#dfeaeb',    // 冰珍珠
    rule: 'rgba(95,118,130,0.28)', // 发丝线
};

// 磨砂玻璃浅卡
const CARD = {
    background: 'linear-gradient(150deg, rgba(255,255,255,0.6), rgba(199,216,223,0.34))',
    border: '1px solid rgba(255,255,255,0.7)',
    boxShadow: '0 10px 26px rgba(36,50,55,0.1), inset 0 1px 0 rgba(255,255,255,0.65)',
    backdropFilter: 'blur(14px) saturate(1.1)',
    WebkitBackdropFilter: 'blur(14px) saturate(1.1)',
} as React.CSSProperties;

const FONT_SERIF = `'DM Serif Display', 'Shippori Mincho', serif`;
const FONT_CN = `'ZCOOL XiaoWei', 'Shippori Mincho', serif`;

const hashStr = (s: string): number => {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return h >>> 0;
};

const QUICK_ENTRIES: { id: AppID; cn: string }[] = [
    { id: AppID.Character, cn: '神经链接' },
    { id: AppID.MemoryPalace, cn: '记忆宫殿' },
    { id: AppID.Call, cn: '电话' },
    { id: AppID.Room, cn: '小小窝' },
];

const GRID_CARDS: { id: AppID; cn: string; en: string }[] = [
    { id: AppID.CheckPhone, cn: '查手机', en: 'PHONE' },
    { id: AppID.Date, cn: '见面', en: 'CONTACTS' },
    { id: AppID.User, cn: '档案', en: 'ARCHIVES' },
    { id: AppID.Bank, cn: '存钱罐', en: 'PIGGYBANK' },
    { id: AppID.Schedule, cn: '日程', en: 'SCHEDULE' },
    { id: AppID.Settings, cn: '设置', en: 'SETTINGS' },
];

const DAYS = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'];
const MONTHS = ['JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE', 'JULY', 'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER'];

const renderGlyph = (iconKey: string, className: string) => {
    const Comp = Icons[iconKey] || Icons.Settings;
    return <Comp className={className} />;
};

// 居中衬线分节标题（两侧发丝线）
const SectionLabel: React.FC<{ cn: string; en: string }> = ({ cn, en }) => (
    <div className="flex items-center gap-3.5 mt-8 mb-4">
        <div className="flex-1 h-px" style={{ background: `linear-gradient(90deg, transparent, ${PAL.rule})` }} />
        <div className="text-center leading-tight">
            <div className="text-[14px]" style={{ fontFamily: FONT_CN, color: PAL.ink, letterSpacing: '0.08em' }}>{cn}</div>
            <div className="text-[8px] font-bold mt-0.5" style={{ color: PAL.steel, letterSpacing: '0.34em' }}>{en}</div>
        </div>
        <div className="flex-1 h-px" style={{ background: `linear-gradient(90deg, ${PAL.rule}, transparent)` }} />
    </div>
);

const MobileGameHome: React.FC = () => {
    const { openApp, characters, activeCharacterId, virtualTime, unreadMessages, isDataLoaded, lastMsgTimestamp } = useOS();

    const [widgetChar, setWidgetChar] = useState<CharacterProfile | null>(null);
    const [lastMessage, setLastMessage] = useState<string>('');
    const [drawerOpen, setDrawerOpen] = useState(false);

    const [devDebugVisible, setDevDebugVisible] = useState(() => isDevDebugAvailable());
    useEffect(() => subscribeDevDebugAvailability(setDevDebugVisible), []);

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
    const tagline = (widgetChar?.description || '硝子色の街、静かに更ける夜。').slice(0, 36);
    const announcement = lastMessage || widgetChar?.description || '一切如常，等待新的故事发生。';
    const expPct = Math.min(100, Math.round((stats.exp / stats.expMax) * 100));

    const drawerApps = useMemo(
        () => INSTALLED_APPS.filter(a => a.id !== AppID.CharCreatorDev || devDebugVisible),
        [devDebugVisible]
    );

    const Pill: React.FC<{ icon: React.ReactNode; value: string }> = ({ icon, value }) => (
        <div className="flex items-center gap-1 pl-1.5 pr-1 py-[3px] rounded-full w-[92px]"
            style={{ background: 'rgba(255,255,255,0.55)', border: '1px solid rgba(255,255,255,0.8)', boxShadow: '0 3px 10px rgba(36,50,55,0.1)' }}>
            {icon}
            <span className="flex-1 text-right text-[12px] font-extrabold tabular-nums" style={{ color: PAL.ink }}>{value}</span>
            <span className="w-[18px] h-[18px] rounded-full flex items-center justify-center text-[12px] font-bold leading-none shrink-0"
                style={{ background: PAL.steel, color: '#fff' }}>+</span>
        </div>
    );

    return (
        <div
            className="h-full w-full relative z-10 overflow-hidden select-none"
            style={{ color: PAL.ink, fontFamily: FONT_CN }}
        >
            {/* 极淡叠层：顶部提亮 + 底部微沉（让 dock 可读），中段透明以透出壁纸 */}
            <div className="absolute inset-0 pointer-events-none"
                style={{ background: 'linear-gradient(180deg, rgba(255,255,255,0.3) 0%, rgba(255,255,255,0) 22%, rgba(255,255,255,0) 78%, rgba(95,118,130,0.16) 100%)' }} />

            <div
                className="relative h-full overflow-y-auto no-scrollbar px-6"
                style={{ paddingTop: 'calc(var(--safe-top, 0px) + 1rem)', paddingBottom: '7.5rem' }}
            >
                {/* ===== 报头 Masthead ===== */}
                <div className="flex items-center justify-between animate-fade-in">
                    <div className="flex items-center gap-2">
                        <span className="text-[10px]" style={{ color: PAL.sea }}>✦</span>
                        <span className="text-[9px] font-bold" style={{ color: PAL.steel, letterSpacing: '0.34em' }}>SULLYOS&nbsp;STATION</span>
                    </div>
                    <button onClick={() => openApp(AppID.Appearance)} aria-label="菜单"
                        className="flex flex-col items-end gap-[3px] py-2 active:opacity-60 transition-opacity">
                        <span className="w-5 h-[1.5px] rounded-full" style={{ background: PAL.steel }} />
                        <span className="w-3.5 h-[1.5px] rounded-full" style={{ background: PAL.steel }} />
                        <span className="w-5 h-[1.5px] rounded-full" style={{ background: PAL.steel }} />
                    </button>
                </div>
                <div className="h-px mt-2" style={{ background: PAL.rule }} />

                {/* ===== 角色档案 Profile ===== */}
                <div className="flex items-center gap-3.5 mt-4 animate-fade-in">
                    <div className="relative shrink-0" onClick={() => openApp(AppID.Character)}>
                        <div className="w-16 h-16 rounded-full p-[2px] cursor-pointer active:scale-95 transition-transform"
                            style={{ background: `linear-gradient(135deg, ${PAL.steel}, ${PAL.powder})`, boxShadow: '0 6px 16px rgba(36,50,55,0.2)' }}>
                            <div className="w-full h-full rounded-full overflow-hidden" style={{ border: '2px solid #fff' }}>
                                {widgetChar?.avatar
                                    ? <img src={widgetChar.avatar} className="w-full h-full object-cover" alt="char" loading="lazy" />
                                    : <div className="w-full h-full flex items-center justify-center text-2xl" style={{ background: PAL.pearl, color: PAL.steel }}>✦</div>}
                            </div>
                        </div>
                        <div className="absolute -bottom-1.5 left-1/2 -translate-x-1/2 px-2 py-[1px] rounded text-[9px] tracking-wide whitespace-nowrap"
                            style={{ background: PAL.ink, color: PAL.pearl, fontFamily: FONT_SERIF }}>
                            Lv.{stats.level}
                        </div>
                    </div>

                    <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                            <h2 className="text-[21px] truncate" style={{ fontFamily: FONT_CN, color: PAL.ink }}>{charName}</h2>
                            <span className="flex items-center gap-1 text-[8px] font-bold tracking-[0.16em] shrink-0" style={{ color: PAL.steel }}>
                                <span className="w-1.5 h-1.5 rounded-full" style={{ background: PAL.steel }} />ONLINE
                            </span>
                        </div>
                        <p className="text-[11px] leading-snug mt-0.5 truncate" style={{ color: PAL.steel }}>{tagline}</p>
                    </div>

                    <div className="flex flex-col items-end gap-1.5 shrink-0">
                        <Pill
                            icon={<svg viewBox="0 0 24 24" className="w-3.5 h-3.5 shrink-0"><path d="M6 3h12l3 5-9 13L3 8z" fill={PAL.sea} stroke={PAL.steel} strokeWidth="1" strokeLinejoin="round" /></svg>}
                            value={stats.gems.toLocaleString()}
                        />
                        <Pill
                            icon={<svg viewBox="0 0 24 24" className="w-3.5 h-3.5 shrink-0"><path d="M12 2l2.9 6.3 6.9.7-5.2 4.6 1.5 6.8L12 17.8 5.9 20.4l1.5-6.8L2.2 9l6.9-.7z" fill={PAL.steel} stroke={PAL.ink} strokeWidth="0.6" strokeLinejoin="round" /></svg>}
                            value={stats.stars.toString()}
                        />
                    </div>
                </div>

                {/* EXP 条（全宽）*/}
                <div className="flex items-center gap-2.5 mt-3.5 animate-fade-in">
                    <span className="text-[9px] font-bold tracking-[0.2em]" style={{ color: PAL.steel }}>EXP</span>
                    <div className="flex-1 h-[6px] rounded-full overflow-hidden" style={{ background: 'rgba(36,50,55,0.1)' }}>
                        <div className="h-full rounded-full" style={{ width: `${expPct}%`, background: `linear-gradient(90deg, ${PAL.ink}, ${PAL.steel}, ${PAL.sea})` }} />
                    </div>
                    <span className="text-[10px] tabular-nums whitespace-nowrap" style={{ fontFamily: FONT_SERIF, color: PAL.ink }}>{stats.exp} / {stats.expMax}</span>
                </div>

                {/* ===== 时钟 Hero（居中）===== */}
                <div className="text-center mt-9 mb-2 animate-fade-in">
                    <div className="text-[10px] font-bold" style={{ color: PAL.steel, letterSpacing: '0.32em' }}>{dayName} · {dateNum} {monthName}</div>
                    <div className="text-[5.6rem] leading-[0.9] mt-1" style={{ fontFamily: FONT_SERIF, color: PAL.ink, fontFeatureSettings: '"tnum"' }}>
                        {hh}<span style={{ color: PAL.steelSoft }}>:</span>{mm}
                    </div>
                    <div className="text-[1.8rem] italic -mt-1" style={{ fontFamily: FONT_SERIF, color: PAL.steel }}>{greeting}</div>
                </div>

                {/* ===== 最新公告 ===== */}
                <button onClick={() => openApp(AppID.HotNews)}
                    className="w-full text-left mt-4 rounded-2xl p-4 flex items-center gap-3 active:scale-[0.99] transition-transform animate-fade-in"
                    style={CARD}>
                    <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1.5">
                            <span className="text-[13px]" style={{ fontFamily: FONT_CN, color: PAL.ink }}>最新公告</span>
                            <span className="px-1.5 py-px rounded text-[8px] font-bold tracking-wider" style={{ background: PAL.ink, color: PAL.pearl }}>NEW</span>
                        </div>
                        <p className="text-[11px] leading-relaxed line-clamp-2" style={{ color: PAL.steel }}>{announcement}</p>
                    </div>
                    <div className="w-14 h-14 shrink-0 rounded-xl overflow-hidden" style={{ border: '1px solid rgba(255,255,255,0.8)', boxShadow: '0 3px 10px rgba(36,50,55,0.15)' }}>
                        {widgetChar?.avatar
                            ? <img src={widgetChar.avatar} className="w-full h-full object-cover" alt="" loading="lazy" />
                            : <div className="w-full h-full flex items-center justify-center text-base" style={{ background: PAL.pearl, color: PAL.steel }}>✦</div>}
                    </div>
                    <svg viewBox="0 0 24 24" className="w-4 h-4 shrink-0" fill="none" stroke={PAL.steel} strokeWidth="2.5"><path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" /></svg>
                </button>

                {/* ===== 快捷入口 ===== */}
                <SectionLabel cn="快捷入口" en="SHORTCUTS" />
                <div className="grid grid-cols-4 gap-2 animate-fade-in">
                    {QUICK_ENTRIES.map(e => (
                        <button key={e.id} onClick={() => openApp(e.id)}
                            className="flex flex-col items-center gap-2 active:scale-90 transition-transform">
                            <div className="w-14 h-14 rounded-full flex items-center justify-center"
                                style={{ background: 'linear-gradient(150deg, #ffffff, #c7d8df)', border: '1px solid rgba(255,255,255,0.9)', boxShadow: '0 5px 14px rgba(36,50,55,0.15), inset 0 1px 1px rgba(255,255,255,0.8)' }}>
                                <div className="w-6 h-6" style={{ color: PAL.ink }}>{renderGlyph(INSTALLED_APPS.find(a => a.id === e.id)?.icon || 'Settings', 'w-full h-full')}</div>
                            </div>
                            <span className="text-[10px]" style={{ fontFamily: FONT_CN, color: PAL.ink }}>{e.cn}</span>
                        </button>
                    ))}
                </div>

                {/* ===== 应用目录 ===== */}
                <SectionLabel cn="应用目录" en="INDEX" />
                <div className="grid grid-cols-2 gap-3">
                    {GRID_CARDS.map((card, i) => (
                        <button key={card.id} onClick={() => openApp(card.id)}
                            className="relative h-[6.75rem] rounded-2xl p-4 flex flex-col justify-center text-left overflow-hidden active:scale-[0.97] transition-transform animate-fade-in"
                            style={CARD}>
                            {/* 目录编号（杂志感）*/}
                            <span className="absolute top-2.5 left-3.5 text-[11px] tabular-nums" style={{ fontFamily: FONT_SERIF, color: PAL.steel, opacity: 0.7 }}>
                                {String(i + 1).padStart(2, '0')}
                            </span>
                            {/* 应用图标：正立、钢蓝、右侧居中 */}
                            <div className="absolute right-3 top-1/2 -translate-y-1/2 w-[3.5rem] h-[3.5rem] pointer-events-none" style={{ color: PAL.steelSoft, opacity: 0.85 }}>
                                {renderGlyph(INSTALLED_APPS.find(a => a.id === card.id)?.icon || 'Settings', 'w-full h-full')}
                            </div>
                            <div className="relative mt-2">
                                <div className="text-[20px] leading-tight" style={{ fontFamily: FONT_CN, color: PAL.ink }}>{card.cn}</div>
                                <div className="text-[9px] font-bold tracking-[0.28em] mt-1" style={{ color: PAL.steel }}>{card.en}</div>
                            </div>
                        </button>
                    ))}
                </div>
            </div>

            {/* ===== 底部 Dock ===== */}
            <div className="absolute bottom-0 left-0 w-full px-4 z-30 pointer-events-none"
                style={{ paddingBottom: 'calc(var(--safe-bottom, 0px) + 0.75rem)' }}>
                <div className="relative pointer-events-auto rounded-[1.75rem] px-3 py-2.5 flex items-end justify-between"
                    style={{ background: 'rgba(255,255,255,0.62)', border: '1px solid rgba(255,255,255,0.85)', boxShadow: '0 -6px 30px rgba(36,50,55,0.14), inset 0 1px 0 rgba(255,255,255,0.8)', backdropFilter: 'blur(18px)', WebkitBackdropFilter: 'blur(18px)' }}>
                    <DockItem id={AppID.Chat} cn="消息" badge={totalUnread} onClick={() => openApp(AppID.Chat)} />
                    <DockItem id={AppID.Character} cn="好友" badge={characters?.length || 0} onClick={() => openApp(AppID.Character)} />
                    <button onClick={() => setDrawerOpen(true)} aria-label="全部应用"
                        className="-mt-7 w-16 h-16 rounded-full flex items-center justify-center active:scale-95 transition-transform shrink-0"
                        style={{ background: `linear-gradient(135deg, #3a4f56, ${PAL.ink})`, boxShadow: '0 8px 22px rgba(36,50,55,0.4), inset 0 2px 6px rgba(255,255,255,0.2)' }}>
                        <div className="w-12 h-12 rounded-full flex items-center justify-center" style={{ border: `1px solid ${PAL.sea}` }}>
                            <svg viewBox="0 0 24 24" className="w-7 h-7">
                                <path d="M12 1.5 L13.7 10.3 L22.5 12 L13.7 13.7 L12 22.5 L10.3 13.7 L1.5 12 L10.3 10.3 Z" fill={PAL.pearl} />
                                <path d="M12 6 L12.9 11.1 L18 12 L12.9 12.9 L12 18 L11.1 12.9 L6 12 L11.1 11.1 Z" fill={PAL.sea} />
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
                    style={{ background: 'rgba(223,234,235,0.9)', backdropFilter: 'blur(24px)', WebkitBackdropFilter: 'blur(24px)' }}
                    onClick={() => setDrawerOpen(false)}>
                    <div className="flex items-center justify-between px-6" style={{ paddingTop: 'calc(var(--safe-top, 0px) + 1.25rem)', paddingBottom: '0.5rem' }}>
                        <h2 className="text-base tracking-wide" style={{ fontFamily: FONT_CN, color: PAL.ink }}>全部应用</h2>
                        <button onClick={(e) => { e.stopPropagation(); setDrawerOpen(false); }} aria-label="关闭"
                            className="w-9 h-9 rounded-full flex items-center justify-center active:scale-90 transition-transform"
                            style={{ background: 'rgba(255,255,255,0.6)', border: '1px solid rgba(255,255,255,0.85)' }}>
                            <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none" stroke={PAL.ink} strokeWidth="2.5"><path strokeLinecap="round" d="M6 6l12 12M18 6L6 18" /></svg>
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

const DockItem: React.FC<{ id: AppID; cn: string; badge?: number; onClick: () => void }> = ({ id, cn, badge = 0, onClick }) => {
    const iconKey = INSTALLED_APPS.find(a => a.id === id)?.icon || 'Settings';
    return (
        <button onClick={onClick} className="relative flex flex-col items-center gap-1 w-14 active:scale-90 transition-transform">
            <div className="relative w-7 h-7" style={{ color: PAL.ink }}>
                {renderGlyph(iconKey, 'w-full h-full')}
                {badge > 0 && (
                    <span className="absolute -top-1.5 -right-2 min-w-[16px] h-4 px-1 rounded-full flex items-center justify-center text-[9px] font-bold text-white"
                        style={{ background: PAL.steel, border: '1px solid #fff' }}>
                        {badge > 99 ? '99+' : badge}
                    </span>
                )}
            </div>
            <span className="text-[10px]" style={{ fontFamily: FONT_CN, color: PAL.ink }}>{cn}</span>
        </button>
    );
};

export default MobileGameHome;
