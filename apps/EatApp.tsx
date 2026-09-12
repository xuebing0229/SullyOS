import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
    ArrowLeft,
    BowlFood,
    CalendarBlank,
    Check,
    CookingPot,
    ForkKnife,
    GearSix,
    Minus,
    Plus,
    ShoppingBag,
    Snowflake,
    Sparkle,
    Trash,
    X,
} from '@phosphor-icons/react';
import { useOS } from '../context/OSContext';
import { DB } from '../utils/db';
import { getLocalDateKey } from '../utils/localDate';
import {
    DEFAULT_MEAL_SETTINGS,
    formatMealCompletionForChat,
    formatMealPlanForChat,
    generateDailyMealPlan,
    loadMealPlannerState,
    saveMealPlannerState,
    type DailyMealPlan,
    type MealPlannerState,
    type PantryCategory,
    type PantryItem,
} from '../utils/mealPlanner';

type Tab = 'today' | 'fridge' | 'settings';

const CATEGORIES: PantryCategory[] = [
    '主食', '肉蛋', '蔬菜', '水果', '奶豆', '饮品', '冷冻', '速食', '调味', '其他',
];

const CATEGORY_CLASS: Record<PantryCategory, string> = {
    主食: 'bg-amber-100 text-amber-700',
    肉蛋: 'bg-rose-100 text-rose-700',
    蔬菜: 'bg-emerald-100 text-emerald-700',
    水果: 'bg-orange-100 text-orange-700',
    奶豆: 'bg-yellow-100 text-yellow-700',
    饮品: 'bg-cyan-100 text-cyan-700',
    冷冻: 'bg-blue-100 text-blue-700',
    速食: 'bg-sky-100 text-sky-700',
    调味: 'bg-violet-100 text-violet-700',
    其他: 'bg-slate-100 text-slate-600',
};

const makeDraft = (): Omit<PantryItem, 'id'> => ({
    name: '',
    quantity: 1,
    unit: '份',
    category: '其他',
    expiresAt: '',
    note: '',
});

const EatApp: React.FC = () => {
    const {
        closeApp,
        apiConfig,
        addToast,
        characters,
        userProfile,
    } = useOS();
    const [state, setState] = useState<MealPlannerState>(() => loadMealPlannerState());
    const [tab, setTab] = useState<Tab>('today');
    const [date, setDate] = useState(() => getLocalDateKey());
    const [generating, setGenerating] = useState(false);
    const [showAdd, setShowAdd] = useState(false);
    const [draftItem, setDraftItem] = useState(makeDraft);
    const [mealActionType, setMealActionType] = useState('');
    const mealPressTimer = useRef<number | null>(null);

    useEffect(() => {
        saveMealPlannerState(state);
    }, [state]);

    useEffect(() => () => {
        if (mealPressTimer.current !== null) window.clearTimeout(mealPressTimer.current);
    }, []);

    const currentPlan = useMemo(
        () => state.plans.find(plan => plan.date === date),
        [date, state.plans],
    );

    const expiring = useMemo(() => {
        const end = new Date();
        end.setDate(end.getDate() + 3);
        const endKey = getLocalDateKey(end);
        return state.inventory.filter(item => item.expiresAt && item.expiresAt <= endKey).length;
    }, [state.inventory]);

    const pushCharacters = useMemo(() => {
        const selected = new Set(
            state.settings.pushCharacterIds
            || (state.settings.pushCharacterId ? [state.settings.pushCharacterId] : []),
        );
        return characters.filter(character => selected.has(character.id));
    }, [characters, state.settings.pushCharacterId, state.settings.pushCharacterIds]);

    const publishMealText = async (
        plan: DailyMealPlan,
        content: string,
        extraMetadata: Record<string, unknown> = {},
    ) => {
        if (!pushCharacters.length) return;
        await Promise.all(pushCharacters.map(async character => {
            await DB.saveMessage({
                charId: character.id,
                role: 'user',
                type: 'text',
                content,
                metadata: {
                    source: 'eat',
                    mealPlanId: plan.id,
                    mealPlanDate: plan.date,
                    ...extraMetadata,
                },
            } as any);
            window.dispatchEvent(new CustomEvent('active-msg-progress', {
                detail: { charId: character.id },
            }));
        }));
    };

    const handleGenerate = async () => {
        if (generating) return;
        setGenerating(true);
        try {
            const plan = await generateDailyMealPlan(
                apiConfig,
                state.inventory,
                state.settings,
                date,
            );
            setState(prev => ({
                ...prev,
                plans: [plan, ...prev.plans.filter(item => item.date !== date)].slice(0, 14),
            }));
            const userName = userProfile?.name?.trim() || '你';
            await publishMealText(plan, formatMealPlanForChat(plan, userName), {
                mealReceiptType: 'plan',
            });
            if (pushCharacters.length) {
                const target = pushCharacters.length <= 2
                    ? pushCharacters.map(character => character.name).join('、')
                    : `${pushCharacters.length} 位角色`;
                addToast(`今天的饭安排好了，也发给了${target}`, 'success');
            } else {
                addToast('今天的饭安排好了', 'success');
            }
        } catch (error: any) {
            addToast(error?.message || '饮食安排生成失败', 'error');
        } finally {
            setGenerating(false);
        }
    };

    const addInventory = () => {
        const name = draftItem.name.trim();
        if (!name) {
            addToast('先写食材名字', 'info');
            return;
        }
        const item: PantryItem = {
            ...draftItem,
            id: `food-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            name,
            quantity: Math.max(0, Number(draftItem.quantity) || 0),
            unit: draftItem.unit.trim() || '份',
            expiresAt: draftItem.expiresAt || undefined,
            note: draftItem.note?.trim() || undefined,
        };
        setState(prev => ({ ...prev, inventory: [item, ...prev.inventory] }));
        setDraftItem(makeDraft());
        setShowAdd(false);
    };

    const updateQuantity = (id: string, delta: number) => {
        setState(prev => ({
            ...prev,
            inventory: prev.inventory.map(item => item.id === id
                ? {
                    ...item,
                    quantity: Math.max(0, Math.round((item.quantity + delta) * 10) / 10),
                }
                : item),
        }));
    };

    const completeMeal = async (type: string) => {
        const plan = state.plans.find(item => item.date === date);
        const meal = plan?.meals.find(item => item.type === type);
        if (!plan || !meal || plan.completedMeals?.includes(type)) {
            setMealActionType('');
            return;
        }

        const usage = new Map<string, number>();
        for (const dish of meal.dishes) {
            const structured = dish.ingredients?.filter(item => item.fromStock && item.quantity > 0) || [];
            if (structured.length) {
                for (const ingredient of structured) {
                    const matched = state.inventory.find(item => item.id === ingredient.inventoryId)
                        || state.inventory.find(item => item.name.trim() === ingredient.name.trim());
                    if (matched && (!ingredient.unit || ingredient.unit === matched.unit)) {
                        usage.set(matched.id, (usage.get(matched.id) || 0) + ingredient.quantity);
                    }
                }
            } else {
                for (const name of dish.stockUsed || []) {
                    const matched = state.inventory.find(item => item.name.trim() === name.trim());
                    if (matched) usage.set(matched.id, (usage.get(matched.id) || 0) + 1);
                }
            }
        }

        setState(prev => ({
            ...prev,
            inventory: prev.inventory.map(item => usage.has(item.id)
                ? {
                    ...item,
                    quantity: Math.max(
                        0,
                        Math.round((item.quantity - (usage.get(item.id) || 0)) * 10) / 10,
                    ),
                }
                : item),
            plans: prev.plans.map(item => item.id === plan.id
                ? { ...item, completedMeals: [...(item.completedMeals || []), type] }
                : item),
        }));
        setMealActionType('');

        try {
            const completedAt = Date.now();
            const userName = userProfile?.name?.trim() || '你';
            await publishMealText(
                plan,
                formatMealCompletionForChat(plan, type, userName),
                {
                    mealReceiptType: 'completed',
                    completedMealType: type,
                    completedAt,
                },
            );
        } catch {
            addToast('这餐已经记下了，但完成回执没发出去', 'error');
            return;
        }

        addToast(
            usage.size ? `${type}完成，已扣除用掉的存货` : `${type}已标记完成`,
            'success',
        );
    };

    const deleteMeal = (type: string) => {
        setState(prev => ({
            ...prev,
            plans: prev.plans.flatMap(plan => {
                if (plan.date !== date) return [plan];
                const meals = plan.meals.filter(meal => meal.type !== type);
                if (!meals.length) return [];
                return [{
                    ...plan,
                    meals,
                    totalKcal: meals.reduce((sum, meal) => sum + meal.kcal, 0),
                    completedMeals: (plan.completedMeals || []).filter(item => item !== type),
                }];
            }),
        }));
        setMealActionType('');
        addToast(`已删除${type}，冰箱存货没有变化`, 'success');
    };

    const startMealPress = (type: string) => {
        if (mealPressTimer.current !== null) window.clearTimeout(mealPressTimer.current);
        mealPressTimer.current = window.setTimeout(() => {
            setMealActionType(type);
            mealPressTimer.current = null;
            if ('vibrate' in navigator) navigator.vibrate(25);
        }, 520);
    };

    const cancelMealPress = () => {
        if (mealPressTimer.current !== null) window.clearTimeout(mealPressTimer.current);
        mealPressTimer.current = null;
    };

    const setSettings = (patch: Partial<MealPlannerState['settings']>) => {
        setState(prev => ({
            ...prev,
            settings: { ...prev.settings, ...patch },
        }));
    };

    return (
        <div
            className="h-full w-full flex flex-col bg-[#f8f5ed] text-[#344038] animate-fade-in"
            style={{ paddingTop: 'var(--safe-top)' }}
        >
            <header className="shrink-0 px-4 pt-2 pb-3 border-b border-[#dfe6d8] bg-[#f8f5ed]/95 backdrop-blur-xl z-20">
                <div className="flex items-center justify-between gap-3">
                    <button
                        onClick={closeApp}
                        className="w-10 h-10 rounded-full grid place-items-center bg-white/70 border border-[#e6e1d4] active:scale-90"
                        aria-label="返回"
                    >
                        <ArrowLeft size={23} />
                    </button>
                    <div className="text-center min-w-0">
                        <p className="text-[9px] tracking-[0.32em] text-[#7e927c] font-bold">SULLY KITCHEN</p>
                        <h1 className="text-xl font-black tracking-tight">吃了吗</h1>
                    </div>
                    <button
                        onClick={() => setShowAdd(true)}
                        className="w-10 h-10 rounded-full grid place-items-center bg-[#71866e] text-white shadow-sm active:scale-90"
                        aria-label="添加存货"
                    >
                        <Plus size={22} weight="bold" />
                    </button>
                </div>
                <nav className="mt-3 grid grid-cols-3 p-1 rounded-2xl bg-[#e9eadf] text-xs font-bold">
                    {([
                        ['today', '今日', BowlFood],
                        ['fridge', '冰箱', Snowflake],
                        ['settings', '偏好', GearSix],
                    ] as const).map(([id, label, Icon]) => (
                        <button
                            key={id}
                            onClick={() => setTab(id)}
                            className={`py-2 rounded-xl flex items-center justify-center gap-1.5 transition ${tab === id ? 'bg-white text-[#52664f] shadow-sm' : 'text-[#82907f]'}`}
                        >
                            <Icon size={15} weight={tab === id ? 'fill' : 'regular'} />
                            {label}
                        </button>
                    ))}
                </nav>
            </header>

            <main className="flex-1 overflow-y-auto px-4 py-4 pb-[calc(var(--safe-bottom)+24px)]">
                {tab === 'today' && (
                    <div className="space-y-4">
                        <section
                            className="rounded-[1.8rem] p-5 text-white overflow-hidden relative shadow-[0_18px_40px_-24px_rgba(67,87,65,.8)]"
                            style={{ background: 'linear-gradient(135deg,#53694f 0%,#7f9679 62%,#a9b79a 100%)' }}
                        >
                            <div className="absolute w-36 h-36 rounded-full bg-white/10 -right-10 -top-12" />
                            <div className="relative">
                                <div className="flex items-center justify-between gap-3">
                                    <div>
                                        <p className="text-[10px] tracking-[0.22em] font-bold text-white/70">TODAY</p>
                                        <h2 className="mt-1 text-2xl font-black">{currentPlan?.title || '今天吃点什么？'}</h2>
                                    </div>
                                    <BowlFood size={38} weight="duotone" className="text-white/85" />
                                </div>
                                <div className="mt-4 flex items-center gap-2 rounded-2xl bg-white/12 px-3 py-2">
                                    <CalendarBlank size={17} />
                                    <input
                                        type="date"
                                        value={date}
                                        onChange={event => setDate(event.target.value)}
                                        className="min-w-0 flex-1 bg-transparent text-sm font-bold outline-none [color-scheme:dark]"
                                    />
                                </div>
                                <div className="mt-4 grid grid-cols-3 gap-2 text-center">
                                    <div className="rounded-2xl bg-white/10 px-2 py-2"><b className="block text-lg">{state.inventory.length}</b><span className="text-[9px] text-white/70">库存</span></div>
                                    <div className="rounded-2xl bg-white/10 px-2 py-2"><b className="block text-lg">{expiring}</b><span className="text-[9px] text-white/70">三天内到期</span></div>
                                    <div className="rounded-2xl bg-white/10 px-2 py-2"><b className="block text-lg">{currentPlan?.totalKcal || '—'}</b><span className="text-[9px] text-white/70">全天 kcal</span></div>
                                </div>
                            </div>
                        </section>

                        {!currentPlan ? (
                            <button
                                type="button"
                                onClick={() => void handleGenerate()}
                                disabled={generating}
                                className="w-full rounded-[1.6rem] border border-[#dce4d8] bg-white px-5 py-5 text-left shadow-sm active:scale-[.99] disabled:opacity-60"
                            >
                                <div className="flex items-center gap-3">
                                    <span className="w-11 h-11 rounded-2xl grid place-items-center bg-[#edf2e9] text-[#678063]"><Sparkle size={24} weight="fill" /></span>
                                    <span className="min-w-0 flex-1">
                                        <b className="block text-sm">{generating ? '正在看冰箱安排今天的饭…' : '按冰箱现有东西安排一天'}</b>
                                        <span className="mt-1 block text-[10px] text-[#879286]">走当前聊天线路和故障转移，不单独绑死模型</span>
                                    </span>
                                </div>
                            </button>
                        ) : (
                            <div className="space-y-3">
                                {currentPlan.meals.map(meal => {
                                    const completed = currentPlan.completedMeals?.includes(meal.type);
                                    return (
                                        <article
                                            key={meal.type}
                                            onPointerDown={() => startMealPress(meal.type)}
                                            onPointerUp={cancelMealPress}
                                            onPointerLeave={cancelMealPress}
                                            onPointerCancel={cancelMealPress}
                                            className="rounded-[1.5rem] border border-[#e1e5da] bg-white p-4 shadow-sm"
                                        >
                                            <div className="flex items-start gap-3">
                                                <span className={`mt-0.5 w-9 h-9 rounded-xl grid place-items-center ${completed ? 'bg-emerald-100 text-emerald-700' : 'bg-[#f0eee4] text-[#6f806b]'}`}>
                                                    {completed ? <Check size={20} weight="bold" /> : <ForkKnife size={19} />}
                                                </span>
                                                <div className="min-w-0 flex-1">
                                                    <div className="flex items-center justify-between gap-2">
                                                        <h3 className="font-black text-sm">{meal.type}</h3>
                                                        <span className="text-[9px] text-[#9aa294]">约 {meal.kcal} kcal · {meal.prepMinutes} min</span>
                                                    </div>
                                                    <div className="mt-2 space-y-2">
                                                        {meal.dishes.map((dish, index) => (
                                                            <div key={`${dish.name}-${index}`} className="rounded-xl bg-[#f8f7f2] px-3 py-2">
                                                                <b className="text-xs">{dish.name}</b>
                                                                <span className="ml-2 text-[9px] text-[#90998d]">{dish.portion}</span>
                                                                {dish.stockUsed.length > 0 && <p className="mt-1 text-[9px] text-[#73836f]">用库存：{dish.stockUsed.join('、')}</p>}
                                                            </div>
                                                        ))}
                                                    </div>
                                                    {meal.tip && <p className="mt-2 text-[10px] leading-5 text-[#7c8779]">{meal.tip}</p>}
                                                    <button
                                                        type="button"
                                                        disabled={completed}
                                                        onClick={() => void completeMeal(meal.type)}
                                                        className="mt-3 rounded-full bg-[#73866f] px-3 py-1.5 text-[10px] font-bold text-white disabled:bg-[#d8ddd4] disabled:text-[#8d958a]"
                                                    >
                                                        {completed ? '这餐吃完啦' : '我吃完了'}
                                                    </button>
                                                </div>
                                            </div>
                                        </article>
                                    );
                                })}

                                {(currentPlan.shoppingList.length > 0 || currentPlan.stockPriority.length > 0) && (
                                    <section className="grid gap-3 sm:grid-cols-2">
                                        {currentPlan.stockPriority.length > 0 && <div className="rounded-[1.4rem] bg-[#eef3e9] p-4"><b className="flex items-center gap-2 text-xs text-[#657961]"><CookingPot size={16} />优先吃掉</b><p className="mt-2 text-[10px] leading-5 text-[#778673]">{currentPlan.stockPriority.join('、')}</p></div>}
                                        {currentPlan.shoppingList.length > 0 && <div className="rounded-[1.4rem] bg-[#fff3df] p-4"><b className="flex items-center gap-2 text-xs text-[#9b7643]"><ShoppingBag size={16} />顺手补买</b><p className="mt-2 text-[10px] leading-5 text-[#9c8058]">{currentPlan.shoppingList.join('、')}</p></div>}
                                    </section>
                                )}

                                <button
                                    type="button"
                                    disabled={generating}
                                    onClick={() => void handleGenerate()}
                                    className="w-full rounded-2xl border border-dashed border-[#b8c4b3] py-3 text-xs font-bold text-[#657461] disabled:opacity-50"
                                >
                                    {generating ? '重新安排中…' : '重新安排这一天'}
                                </button>
                            </div>
                        )}
                    </div>
                )}

                {tab === 'fridge' && (
                    <div className="space-y-3">
                        <div className="rounded-[1.8rem] bg-gradient-to-b from-[#eaf1ee] to-[#dce8e3] p-4 border border-white shadow-inner">
                            <div className="flex items-center justify-between"><div><p className="text-[9px] font-bold tracking-[.2em] text-[#799088]">FRIDGE</p><h2 className="text-lg font-black">我的冰箱</h2></div><Snowflake size={30} weight="duotone" className="text-[#6d8f88]" /></div>
                            <p className="mt-2 text-[10px] leading-5 text-[#73827c]">把现实里大概有什么记下来就行。生成菜单会优先消耗这里，标记吃完后按模型给出的实际用量扣库存。</p>
                        </div>

                        {state.inventory.length === 0 ? (
                            <button onClick={() => setShowAdd(true)} className="w-full rounded-[1.5rem] bg-white border border-[#e3e4dd] p-8 text-center text-[#879084]"><Plus size={26} className="mx-auto" /><b className="mt-2 block text-sm">冰箱还是空的</b><span className="mt-1 block text-[10px]">先放几样常吃的东西进去</span></button>
                        ) : state.inventory.map(item => (
                            <div key={item.id} className="flex items-center gap-3 rounded-[1.3rem] border border-[#e4e4dc] bg-white p-3 shadow-sm">
                                <span className={`shrink-0 rounded-full px-2 py-1 text-[9px] font-bold ${CATEGORY_CLASS[item.category]}`}>{item.category}</span>
                                <div className="min-w-0 flex-1"><b className="block truncate text-xs">{item.name}</b><p className="mt-1 truncate text-[9px] text-[#90978e]">{item.expiresAt ? `${item.expiresAt} 到期` : '未填保质期'}{item.note ? ` · ${item.note}` : ''}</p></div>
                                <div className="flex items-center gap-1 rounded-full bg-[#f3f3ee] p-1"><button onClick={() => updateQuantity(item.id, -1)} className="w-7 h-7 grid place-items-center rounded-full active:bg-white"><Minus size={13} /></button><span className="min-w-[44px] text-center text-[10px] font-bold">{item.quantity}{item.unit}</span><button onClick={() => updateQuantity(item.id, 1)} className="w-7 h-7 grid place-items-center rounded-full active:bg-white"><Plus size={13} /></button></div>
                                <button onClick={() => setState(prev => ({ ...prev, inventory: prev.inventory.filter(row => row.id !== item.id) }))} className="w-8 h-8 grid place-items-center rounded-full text-rose-400 active:bg-rose-50"><Trash size={15} /></button>
                            </div>
                        ))}
                    </div>
                )}

                {tab === 'settings' && (
                    <div className="space-y-4">
                        <section className="rounded-[1.5rem] border border-[#e1e3da] bg-white p-4 shadow-sm">
                            <h2 className="font-black text-sm">吃饭偏好</h2>
                            <div className="mt-4 grid grid-cols-2 gap-3">
                                <label className="text-[10px] font-bold text-[#788474]">每天几餐<select value={state.settings.mealsPerDay} onChange={event => setSettings({ mealsPerDay: Number(event.target.value) as 1 | 2 | 3 })} className="mt-1 w-full rounded-xl bg-[#f4f4ef] px-3 py-2 text-xs outline-none"><option value={1}>1 餐</option><option value={2}>2 餐</option><option value={3}>3 餐</option></select></label>
                                <label className="text-[10px] font-bold text-[#788474]">吃几个人<select value={state.settings.diners} onChange={event => setSettings({ diners: Math.max(1, Math.min(12, Number(event.target.value) || 1)) })} className="mt-1 w-full rounded-xl bg-[#f4f4ef] px-3 py-2 text-xs outline-none">{Array.from({ length: 8 }, (_, index) => index + 1).map(value => <option key={value} value={value}>{value} 人</option>)}</select></label>
                            </div>
                            <label className="mt-3 block text-[10px] font-bold text-[#788474]">全天大概热量<input type="number" min={800} max={5000} step={50} value={state.settings.targetKcal} onChange={event => setSettings({ targetKcal: Math.max(800, Math.min(5000, Number(event.target.value) || DEFAULT_MEAL_SETTINGS.targetKcal)) })} className="mt-1 w-full rounded-xl bg-[#f4f4ef] px-3 py-2 text-xs outline-none" /></label>
                            <label className="mt-3 block text-[10px] font-bold text-[#788474]">饮食方向<select value={state.settings.goal} onChange={event => setSettings({ goal: event.target.value as MealPlannerState['settings']['goal'] })} className="mt-1 w-full rounded-xl bg-[#f4f4ef] px-3 py-2 text-xs outline-none"><option>正常吃</option><option>清淡点</option><option>控热量</option></select></label>
                            <label className="mt-3 block text-[10px] font-bold text-[#788474]">不吃 / 忌口<textarea value={state.settings.dislikes} onChange={event => setSettings({ dislikes: event.target.value })} placeholder="比如：不吃香菜，花生过敏" className="mt-1 min-h-20 w-full resize-none rounded-xl bg-[#f4f4ef] px-3 py-2 text-xs outline-none" /></label>
                            <label className="mt-3 block text-[10px] font-bold text-[#788474]">厨房条件<textarea value={state.settings.kitchenNote} onChange={event => setSettings({ kitchenNote: event.target.value })} className="mt-1 min-h-20 w-full resize-none rounded-xl bg-[#f4f4ef] px-3 py-2 text-xs outline-none" /></label>
                        </section>

                        <section className="rounded-[1.5rem] border border-[#e1e3da] bg-white p-4 shadow-sm">
                            <h2 className="font-black text-sm">把饮食记录告诉谁</h2>
                            <p className="mt-1 text-[10px] leading-5 text-[#8a9387]">生成计划和“我吃完了”会作为正常聊天文本写进这些角色的对话，不用特殊卡片格式，角色上下文也能直接看见。</p>
                            <div className="mt-3 space-y-2">
                                {characters.map(character => {
                                    const selected = state.settings.pushCharacterIds.includes(character.id);
                                    return <button key={character.id} type="button" onClick={() => setSettings({ pushCharacterIds: selected ? state.settings.pushCharacterIds.filter(id => id !== character.id) : [...state.settings.pushCharacterIds, character.id] })} className={`w-full flex items-center gap-3 rounded-xl border px-3 py-2 text-left ${selected ? 'border-[#7c9277] bg-[#edf3e9]' : 'border-[#e4e5de] bg-white'}`}><span className="min-w-0 flex-1 truncate text-xs font-bold">{character.name}</span>{selected && <Check size={16} weight="bold" className="text-[#6b8267]" />}</button>;
                                })}
                                {characters.length === 0 && <p className="py-4 text-center text-[10px] text-[#9aa197]">还没有角色可以接收饮食记录</p>}
                            </div>
                        </section>
                    </div>
                )}
            </main>

            {showAdd && (
                <div className="fixed inset-0 z-[250] flex items-end bg-black/35" onClick={() => setShowAdd(false)}>
                    <div className="w-full rounded-t-[2rem] bg-[#faf8f2] p-5 pb-[calc(var(--safe-bottom)+18px)] shadow-2xl" onClick={event => event.stopPropagation()}>
                        <div className="flex items-center justify-between"><div><p className="text-[9px] font-bold tracking-[.2em] text-[#80907c]">PANTRY</p><h2 className="text-lg font-black">放进冰箱</h2></div><button onClick={() => setShowAdd(false)} className="w-9 h-9 grid place-items-center rounded-full bg-white"><X size={18} /></button></div>
                        <div className="mt-4 grid grid-cols-2 gap-3">
                            <label className="col-span-2 text-[10px] font-bold text-[#7b8678]">食材<input autoFocus value={draftItem.name} onChange={event => setDraftItem(prev => ({ ...prev, name: event.target.value }))} placeholder="鸡蛋、番茄、米饭……" className="mt-1 w-full rounded-xl bg-white px-3 py-2.5 text-sm outline-none border border-[#e6e5df]" /></label>
                            <label className="text-[10px] font-bold text-[#7b8678]">数量<input type="number" min={0} step={0.5} value={draftItem.quantity} onChange={event => setDraftItem(prev => ({ ...prev, quantity: Number(event.target.value) }))} className="mt-1 w-full rounded-xl bg-white px-3 py-2.5 text-sm outline-none border border-[#e6e5df]" /></label>
                            <label className="text-[10px] font-bold text-[#7b8678]">单位<input value={draftItem.unit} onChange={event => setDraftItem(prev => ({ ...prev, unit: event.target.value }))} className="mt-1 w-full rounded-xl bg-white px-3 py-2.5 text-sm outline-none border border-[#e6e5df]" /></label>
                            <label className="text-[10px] font-bold text-[#7b8678]">分类<select value={draftItem.category} onChange={event => setDraftItem(prev => ({ ...prev, category: event.target.value as PantryCategory }))} className="mt-1 w-full rounded-xl bg-white px-3 py-2.5 text-sm outline-none border border-[#e6e5df]">{CATEGORIES.map(category => <option key={category}>{category}</option>)}</select></label>
                            <label className="text-[10px] font-bold text-[#7b8678]">到期日<input type="date" value={draftItem.expiresAt || ''} onChange={event => setDraftItem(prev => ({ ...prev, expiresAt: event.target.value }))} className="mt-1 w-full rounded-xl bg-white px-3 py-2.5 text-sm outline-none border border-[#e6e5df]" /></label>
                            <label className="col-span-2 text-[10px] font-bold text-[#7b8678]">备注<input value={draftItem.note || ''} onChange={event => setDraftItem(prev => ({ ...prev, note: event.target.value }))} placeholder="比如：已经切半、今晚优先吃" className="mt-1 w-full rounded-xl bg-white px-3 py-2.5 text-sm outline-none border border-[#e6e5df]" /></label>
                        </div>
                        <button onClick={addInventory} className="mt-4 w-full rounded-2xl bg-[#71866e] py-3 text-sm font-black text-white shadow-sm">放进去</button>
                    </div>
                </div>
            )}

            {mealActionType && (
                <div className="fixed inset-0 z-[255] flex items-end bg-black/25" onClick={() => setMealActionType('')}>
                    <div className="w-full rounded-t-[1.8rem] bg-white p-5 pb-[calc(var(--safe-bottom)+18px)]" onClick={event => event.stopPropagation()}>
                        <p className="text-center text-xs font-bold text-slate-500">{mealActionType}</p>
                        <button onClick={() => void completeMeal(mealActionType)} className="mt-4 w-full rounded-2xl bg-[#71866e] py-3 text-sm font-black text-white">标记吃完并扣库存</button>
                        <button onClick={() => deleteMeal(mealActionType)} className="mt-2 w-full rounded-2xl bg-rose-50 py-3 text-sm font-bold text-rose-600">删除这一餐</button>
                    </div>
                </div>
            )}
        </div>
    );
};

export default EatApp;
