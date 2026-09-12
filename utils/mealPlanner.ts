import type { APIConfig } from '../types';
import { executeOpenAiChatPlan, resolveApiExecutionPlan } from './apiFailover';
import { extractContent } from './safeApi';

export type PantryCategory =
    | '主食'
    | '肉蛋'
    | '蔬菜'
    | '水果'
    | '奶豆'
    | '饮品'
    | '冷冻'
    | '速食'
    | '调味'
    | '其他';

export interface PantryItem {
    id: string;
    name: string;
    quantity: number;
    unit: string;
    category: PantryCategory;
    expiresAt?: string;
    note?: string;
}

export interface MealIngredient {
    name: string;
    quantity: number;
    unit: string;
    inventoryId?: string;
    fromStock: boolean;
}

export interface MealDish {
    name: string;
    portion: string;
    kcal: number;
    stockUsed: string[];
    ingredients: MealIngredient[];
}

export interface PlannedMeal {
    type: string;
    dishes: MealDish[];
    kcal: number;
    prepMinutes: number;
    tip: string;
}

export interface DailyMealPlan {
    id: string;
    date: string;
    title: string;
    meals: PlannedMeal[];
    totalKcal: number;
    shoppingList: string[];
    stockPriority: string[];
    note: string;
    createdAt: number;
    completedMeals?: string[];
}

export interface MealPlannerSettings {
    targetKcal: number;
    diners: number;
    mealsPerDay: 1 | 2 | 3;
    pushCharacterIds: string[];
    /** Morpho 旧版单选字段，仅作无损迁移。 */
    pushCharacterId?: string;
    goal: '正常吃' | '清淡点' | '控热量';
    dislikes: string;
    kitchenNote: string;
}

export interface MealPlannerState {
    version: 1;
    inventory: PantryItem[];
    plans: DailyMealPlan[];
    settings: MealPlannerSettings;
}

export const MEAL_PLANNER_STORAGE_KEY = 'sullyos_eat_state_v1';

export const DEFAULT_MEAL_SETTINGS: MealPlannerSettings = {
    targetKcal: 1600,
    diners: 1,
    mealsPerDay: 3,
    pushCharacterIds: [],
    goal: '正常吃',
    dislikes: '',
    kitchenNote: '普通家庭厨房，优先使用炒锅、电饭煲和蒸锅',
};

export const emptyMealPlannerState = (): MealPlannerState => ({
    version: 1,
    inventory: [],
    plans: [],
    settings: { ...DEFAULT_MEAL_SETTINGS },
});

const sanitizeStringList = (value: unknown, limit = 24): string[] =>
    (Array.isArray(value) ? value : [])
        .map(item => String(item ?? '').trim())
        .filter(Boolean)
        .slice(0, limit);

export const loadMealPlannerState = (): MealPlannerState => {
    try {
        const raw = localStorage.getItem(MEAL_PLANNER_STORAGE_KEY)
            // 兼容直接从 Morpho 迁过来的本机数据。
            || localStorage.getItem('morpho_eat_state_v1');
        if (!raw) return emptyMealPlannerState();
        const parsed = JSON.parse(raw);
        const savedSettings = parsed?.settings || {};
        const legacyCharacterId = typeof savedSettings.pushCharacterId === 'string'
            ? savedSettings.pushCharacterId.trim()
            : '';
        const pushCharacterIds = Array.isArray(savedSettings.pushCharacterIds)
            ? Array.from(new Set(savedSettings.pushCharacterIds
                .filter((id: unknown): id is string => typeof id === 'string' && Boolean(id.trim()))
                .map((id: string) => id.trim())))
            : (legacyCharacterId ? [legacyCharacterId] : []);
        return {
            version: 1,
            inventory: Array.isArray(parsed?.inventory) ? parsed.inventory : [],
            plans: Array.isArray(parsed?.plans) ? parsed.plans.slice(0, 14) : [],
            settings: {
                ...DEFAULT_MEAL_SETTINGS,
                ...savedSettings,
                pushCharacterIds,
            },
        };
    } catch {
        return emptyMealPlannerState();
    }
};

export const saveMealPlannerState = (state: MealPlannerState): void => {
    try {
        localStorage.setItem(MEAL_PLANNER_STORAGE_KEY, JSON.stringify({
            ...state,
            plans: state.plans.slice(0, 14),
        }));
    } catch {
        // 本地存储失败不应让页面崩溃，下一次编辑时仍可继续尝试。
    }
};

const clampInt = (value: unknown, min: number, max: number, fallback: number): number => {
    const number = Number(value);
    return Number.isFinite(number)
        ? Math.max(min, Math.min(max, Math.round(number)))
        : fallback;
};

const compactText = (value: unknown, fallback = '', max = 160): string => {
    const result = String(value ?? '').replace(/\s+/g, ' ').trim();
    return (result || fallback).slice(0, max);
};

export const extractJsonObject = (raw: string): any => {
    const cleaned = raw
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/```\s*$/i, '')
        .trim();
    try {
        return JSON.parse(cleaned);
    } catch {
        // 某些模型即使被要求只回 JSON，仍会在前后塞一句话；下面只截第一段完整对象。
    }
    const start = cleaned.indexOf('{');
    if (start < 0) throw new Error('模型没有返回饮食安排 JSON');
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (let i = start; i < cleaned.length; i += 1) {
        const char = cleaned[i];
        if (quoted) {
            if (escaped) escaped = false;
            else if (char === '\\') escaped = true;
            else if (char === '"') quoted = false;
            continue;
        }
        if (char === '"') quoted = true;
        else if (char === '{') depth += 1;
        else if (char === '}') {
            depth -= 1;
            if (depth === 0) return JSON.parse(cleaned.slice(start, i + 1));
        }
    }
    throw new Error('模型返回的饮食安排不完整');
};

const mealTypesFor = (mealsPerDay: 1 | 2 | 3): string[] =>
    mealsPerDay === 1
        ? ['一餐']
        : mealsPerDay === 2
            ? ['第一餐', '第二餐']
            : ['早餐', '午餐', '晚餐'];

export const buildMealPlannerPrompt = (
    inventory: PantryItem[],
    settings: MealPlannerSettings,
    date: string,
): string => {
    const stock = inventory.length
        ? inventory.map(item =>
            `- ${item.name}：${item.quantity}${item.unit}（库存ID：${item.id}；${item.category}`
            + `${item.expiresAt ? `，${item.expiresAt}到期` : ''}${item.note ? `，${item.note}` : ''}）`,
        ).join('\n')
        : '- 冰箱暂未录入存货';
    const mealTypes = mealTypesFor(settings.mealsPerDay);
    return `请为一位中国普通家庭用户安排 ${date} 的一天饮食。\n\n`
        + `冰箱存货：\n${stock}\n\n`
        + `人数：${settings.diners} 人\n`
        + `每日餐数：${settings.mealsPerDay} 餐（${mealTypes.join('、')}）\n`
        + `全天目标：约 ${settings.targetKcal} 千卡\n`
        + `饮食方向：${settings.goal}\n`
        + `不吃/忌口：${settings.dislikes || '无'}\n`
        + `厨房条件：${settings.kitchenNote || '普通家庭厨房'}\n\n`
        + `硬性要求：\n`
        + `1. 优先消耗现有存货和临期食材，缺少的只补常见、平价、容易买到的食材。\n`
        + `2. 菜谱必须是中国普通家庭日常会做的饭，不默认昂贵进口食材、健身水煮餐或宴席复杂菜。\n`
        + `3. 单餐尽量 35 分钟内完成；热量只做生活化估算，不宣称医学精确。\n`
        + `4. meals 数组严格按 ${mealTypes.join('、')} 排列，不额外添加加餐。\n`
        + `5. 每道菜列 ingredients。使用现有食材时 inventoryId 必须照抄库存ID，fromStock=true，quantity 和 unit 写实际会消耗的量；需要另买则 fromStock=false。\n`
        + `6. 只输出一个合法 JSON 对象，不要 markdown、注释或额外文字。\n\n`
        + `JSON 格式：`
        + `{"title":"今天吃得踏实一点","meals":[{"type":"${mealTypes[0]}","dishes":[{"name":"菜名","portion":"一人份用量","kcal":300,"ingredients":[{"name":"鸡蛋","quantity":2,"unit":"个","inventoryId":"food-123","fromStock":true}],"stockUsed":["鸡蛋"]}],"kcal":300,"prepMinutes":15,"tip":"一句简短做法或替换建议"}],"shoppingList":["需要补买的食材与大致数量"],"stockPriority":["应优先消耗的存货"],"note":"一句生活化提醒"}`;
};

const normalizedName = (value: unknown): string =>
    compactText(value, '', 80).replace(/[\s·，,。]/g, '').toLowerCase();

export const normalizeMealPlan = (
    raw: any,
    date: string,
    mealsPerDay: 1 | 2 | 3,
    inventory: PantryItem[],
): DailyMealPlan => {
    const expectedTypes = mealTypesFor(mealsPerDay);
    const rawMeals = raw?.meals ?? raw?.mealPlan ?? raw?.['餐次'];
    const meals: PlannedMeal[] = (Array.isArray(rawMeals) ? rawMeals : [])
        .slice(0, mealsPerDay)
        .map((meal: any, index: number) => {
            const rawDishes = meal?.dishes ?? meal?.['菜品'];
            const dishes: MealDish[] = (Array.isArray(rawDishes) ? rawDishes : [])
                .slice(0, 4)
                .map((dish: any) => {
                    let ingredients: MealIngredient[] = (Array.isArray(dish?.ingredients) ? dish.ingredients : [])
                        .map((ingredient: any) => {
                            const ingredientName = compactText(
                                typeof ingredient === 'string'
                                    ? ingredient
                                    : (ingredient?.name ?? ingredient?.['食材']),
                                '',
                                30,
                            );
                            const requestedId = compactText(ingredient?.inventoryId, '', 100) || undefined;
                            const matched = inventory.find(item => item.id === requestedId)
                                || inventory.find(item => normalizedName(item.name) === normalizedName(ingredientName));
                            return {
                                name: ingredientName || matched?.name || '食材',
                                quantity: Math.max(0, Number(ingredient?.quantity ?? ingredient?.['数量']) || (typeof ingredient === 'string' ? 1 : 0)),
                                unit: compactText(ingredient?.unit ?? ingredient?.['单位'], matched?.unit || '份', 12),
                                inventoryId: matched?.id,
                                fromStock: Boolean(ingredient?.fromStock ?? ingredient?.['使用库存'] ?? matched),
                            } satisfies MealIngredient;
                        })
                        .filter((ingredient: MealIngredient) => ingredient.name && ingredient.quantity > 0)
                        .slice(0, 12);
                    const stockUsed = sanitizeStringList(dish?.stockUsed, 8).map(item => compactText(item, '', 30));
                    if (!ingredients.length && stockUsed.length) {
                        ingredients = stockUsed.map(name => {
                            const key = normalizedName(name);
                            const matched = inventory.find(item => {
                                const inventoryKey = normalizedName(item.name);
                                return key.includes(inventoryKey) || inventoryKey.includes(key);
                            });
                            return {
                                name: matched?.name || name,
                                quantity: 1,
                                unit: matched?.unit || '份',
                                inventoryId: matched?.id,
                                fromStock: Boolean(matched),
                            };
                        });
                    }
                    return {
                        name: compactText(dish?.name ?? dish?.['菜名'], '家常菜', 40),
                        portion: compactText(dish?.portion ?? dish?.['份量'], '一人份', 60),
                        kcal: clampInt(dish?.kcal ?? dish?.['热量'], 0, 2000, 0),
                        stockUsed: stockUsed.length
                            ? stockUsed
                            : ingredients.filter(item => item.fromStock).map(item => item.name),
                        ingredients,
                    };
                });
            const dishKcal = dishes.reduce((sum, dish) => sum + dish.kcal, 0);
            return {
                type: expectedTypes[index] || compactText(meal?.type, `第${index + 1}餐`, 12),
                dishes,
                kcal: clampInt(meal?.kcal, 0, 3000, dishKcal),
                prepMinutes: clampInt(meal?.prepMinutes, 1, 180, 20),
                tip: compactText(meal?.tip, '', 120),
            };
        })
        .filter(meal => meal.dishes.length > 0);

    if (!meals.length) throw new Error('模型没有返回可用的一餐，请再试一次');
    return {
        id: `meal-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        date,
        title: compactText(raw?.title, '今天好好吃饭', 40),
        meals,
        totalKcal: meals.reduce((sum, meal) => sum + meal.kcal, 0),
        shoppingList: sanitizeStringList(raw?.shoppingList, 16).map(item => compactText(item, '', 60)),
        stockPriority: sanitizeStringList(raw?.stockPriority, 10).map(item => compactText(item, '', 40)),
        note: compactText(raw?.note, '热量为估算值，按实际用量调整。', 160),
        createdAt: Date.now(),
    };
};

export const formatMealPlanForChat = (plan: DailyMealPlan, userName = '你'): string => {
    const meals = plan.meals
        .map(meal => `${meal.type}：${meal.dishes.map(dish => `${dish.name}（${dish.portion}，约 ${dish.kcal} kcal）`).join('、')}`)
        .join('\n');
    const shopping = plan.shoppingList.length
        ? `\n要补买：${plan.shoppingList.join('、')}`
        : '';
    return `【吃了吗 · 今日饮食】\n${userName}今天准备这样吃：\n${meals}\n全天约 ${plan.totalKcal} kcal。${shopping}\n这是一张生活记录，不需要把热量当成医学精确值。`;
};

export const formatMealCompletionForChat = (
    plan: DailyMealPlan,
    mealType: string,
    userName = '你',
): string => {
    const meal = plan.meals.find(item => item.type === mealType);
    if (!meal) return `【吃了吗 · 用餐完成】\n${userName}刚刚吃完了 ${mealType}。`;
    const dishes = meal.dishes.map(dish => dish.name).join('、');
    return `【吃了吗 · 用餐完成】\n${userName}这顿已经好好吃完啦：${dishes}\n本餐约 ${meal.kcal} kcal。无需再担心或催促${userName}吃这一餐。`;
};

export const generateDailyMealPlan = async (
    api: APIConfig,
    inventory: PantryItem[],
    settings: MealPlannerSettings,
    date: string,
): Promise<DailyMealPlan> => {
    if (!api?.baseUrl?.trim() || !api?.model?.trim()) {
        throw new Error('请先在设置里配置可用的聊天 API');
    }
    const executionPlan = resolveApiExecutionPlan('chat', api, true);
    const response = await executeOpenAiChatPlan({
        plan: executionPlan,
        body: {
            model: api.model,
            stream: false,
            temperature: 0.55,
            messages: [
                {
                    role: 'system',
                    content: '你是生活化的家庭饮食规划助手。优先实用、便宜、能做出来；严格按用户要求返回 JSON。',
                },
                {
                    role: 'user',
                    content: buildMealPlannerPrompt(inventory, settings, date),
                },
            ],
        },
        forceStream: false,
    });
    const content = extractContent(response.value);
    if (!content.trim()) throw new Error('饮食规划模型没有返回正文');
    return normalizeMealPlan(extractJsonObject(content), date, settings.mealsPerDay, inventory);
};
