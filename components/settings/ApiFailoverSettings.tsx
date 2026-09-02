import React, { useEffect, useMemo, useState } from 'react';

import { useOS } from '../../context/OSContext';
import {
    createDefaultApiFailoverGroup,
    loadApiFailoverGroups,
    clearApiFailoverRouteCooldowns,
    normalizeApiFailoverGroup,
    saveApiFailoverGroups,
    type ApiFailoverGroup,
    type ApiFailoverScope,
} from '../../utils/apiFailover';
import { analyzeApiFailoverGroup, apiFailoverIssueLabel } from '../../utils/apiFailoverGroupAnalysis';
import {
    API_FAILOVER_ROUTE_COOLDOWN_EVENT,
    formatApiRouteCooldownRemaining,
    listActiveApiRouteCooldowns,
    type ApiRouteCooldownEntry,
} from '../../utils/apiFailoverRouteCooldown';
import { getApiPresetModelEntries } from '../../utils/apiPresetModels';

interface Props {
    addToast: (
        message: string,
        type?: 'success' | 'error' | 'info',
    ) => void;
}

const SCOPES: ApiFailoverScope[] = ['chat', 'story', 'emotion'];

interface RouteOption {
    key: string;
    presetId: string;
    presetName: string;
    model: string;
}

const routeChoiceValue = (presetId: string, model: string): string =>
    JSON.stringify([presetId, model]);

const parseRouteChoiceValue = (
    value: string,
): { presetId: string; model: string } | null => {
    try {
        const parsed = JSON.parse(value);
        if (!Array.isArray(parsed) || parsed.length !== 2) return null;
        const presetId = String(parsed[0] || '').trim();
        const model = String(parsed[1] || '').trim();
        return presetId && model ? { presetId, model } : null;
    } catch {
        return null;
    }
};

function initialGroups(): ApiFailoverGroup[] {
    const loaded = loadApiFailoverGroups();
    return SCOPES.map(scope => {
        const found = loaded.find(group => group.scope === scope);
        return normalizeApiFailoverGroup(
            found || createDefaultApiFailoverGroup(scope),
            scope,
        );
    });
}

const ApiFailoverSettings: React.FC<Props> = ({ addToast }) => {
    const { apiPresets } = useOS();
    const [groups, setGroups] = useState<ApiFailoverGroup[]>(
        initialGroups,
    );
    const [advancedScope, setAdvancedScope] =
        useState<ApiFailoverScope | null>(null);
    const [cooldowns, setCooldowns] = useState<ApiRouteCooldownEntry[]>(
        () => listActiveApiRouteCooldowns(),
    );

    useEffect(() => {
        const refresh = () => setCooldowns(listActiveApiRouteCooldowns());
        const timer = window.setInterval(refresh, 1000);
        window.addEventListener(API_FAILOVER_ROUTE_COOLDOWN_EVENT, refresh);
        return () => {
            window.clearInterval(timer);
            window.removeEventListener(
                API_FAILOVER_ROUTE_COOLDOWN_EVENT,
                refresh,
            );
        };
    }, []);

    const presetMap = useMemo(
        () => new Map(apiPresets.map(preset => [
            preset.id,
            preset,
        ])),
        [apiPresets],
    );

    const routeOptions = useMemo<RouteOption[]>(
        () => apiPresets.flatMap(preset =>
            getApiPresetModelEntries(preset).map(item => ({
                key: routeChoiceValue(preset.id, item.model),
                presetId: preset.id,
                presetName: preset.name || '未命名预设',
                model: item.model,
            })),
        ),
        [apiPresets],
    );

    const resolvedMemberModel = (
        presetId: string,
        model?: string,
    ): string => String(
        model
        || presetMap.get(presetId)?.config.model
        || '',
    ).trim();

    const memberRouteKey = (
        presetId: string,
        model?: string,
    ): string => routeChoiceValue(
        presetId,
        resolvedMemberModel(presetId, model),
    );

    const persist = (next: ApiFailoverGroup[]) => {
        const stamped = next.map(group => ({
            ...group,
            updatedAt: Date.now(),
        }));
        setGroups(stamped);
        saveApiFailoverGroups(stamped);
    };

    const updateGroup = (
        scope: ApiFailoverScope,
        update:
            | Partial<ApiFailoverGroup>
            | ((group: ApiFailoverGroup) => ApiFailoverGroup),
    ) => {
        persist(groups.map(group => {
            if (group.scope !== scope) return group;
            return typeof update === 'function'
                ? update(group)
                : { ...group, ...update };
        }));
    };

    const unusedRouteOptions = (group: ApiFailoverGroup) => {
        const used = new Set(
            group.members.map(member =>
                memberRouteKey(member.presetId, member.model),
            ),
        );
        return routeOptions.filter(option => !used.has(option.key));
    };

    const addRoute = (scope: ApiFailoverScope) => {
        const group = groups.find(item => item.scope === scope)!;
        const option = unusedRouteOptions(group)[0];
        if (!option) {
            addToast('没有可添加的其他预设模型线路', 'info');
            return;
        }

        updateGroup(scope, current => ({
            ...current,
            members: [
                ...current.members,
                {
                    presetId: option.presetId,
                    model: option.model,
                    enabled: true,
                },
            ],
        }));
    };

    const replaceRoute = (
        scope: ApiFailoverScope,
        index: number,
        value: string,
    ) => {
        const next = parseRouteChoiceValue(value);
        if (!next) return;
        updateGroup(scope, current => ({
            ...current,
            members: current.members.map((member, currentIndex) =>
                currentIndex === index
                    ? {
                        ...member,
                        presetId: next.presetId,
                        model: next.model,
                    }
                    : member
            ),
        }));
    };

    const removeRoute = (
        scope: ApiFailoverScope,
        index: number,
    ) => {
        updateGroup(scope, current => ({
            ...current,
            members: current.members.filter(
                (_, currentIndex) => currentIndex !== index,
            ),
            enabled:
                current.enabled
                && current.members.length - 1 >= 2,
        }));
    };

    const moveRoute = (
        scope: ApiFailoverScope,
        index: number,
        direction: -1 | 1,
    ) => {
        updateGroup(scope, current => {
            const target = index + direction;
            if (target < 0 || target >= current.members.length) {
                return current;
            }
            const members = [...current.members];
            [members[index], members[target]] =
                [members[target], members[index]];
            return { ...current, members };
        });
    };

    const toggleGroup = (
        scope: ApiFailoverScope,
        enabled: boolean,
    ) => {
        const group = groups.find(item => item.scope === scope)!;
        const analysis = analyzeApiFailoverGroup(group, apiPresets);

        if (enabled && !analysis.canEnable) {
            addToast(
                analysis.compatibleRouteCount === 1
                    ? '当前只有一条实际可用线路，会继续按单 API 直连；至少两条兼容线路才能开启回退'
                    : '没有足够的有效兼容线路，无法开启回退',
                'error',
            );
            return;
        }
        updateGroup(scope, { enabled });
    };

    return (
        <div className="space-y-3">
            <div className="rounded-2xl border border-slate-200/70 bg-white px-4 py-3 shadow-sm">
                <div className="text-[11px] font-bold text-slate-600">故障转移线路</div>
                <p className="mt-1 text-[10px] leading-relaxed text-slate-400">
                    主聊天、剧情文游、情绪评估各自保存线路；每一条线路都由“API 预设 + 具体模型”组成，同一个站点的不同模型可以分别加入并排序。
                </p>
            </div>

            <div className="rounded-2xl bg-slate-50/90 px-4 py-3 text-[10px] leading-relaxed text-slate-500">
                请求失败会先停止当前线路再切到下一条，失败线路冷却 3 分钟。主聊天和剧情都可以给每条线路单独设置首字等待；Instant Push 仍只使用主聊天第一线路。
            </div>

            {cooldowns.length > 0 && (
                <div className="space-y-1 rounded-xl border border-amber-100 bg-amber-50 p-2">
                    {cooldowns.map(item => (
                        <div
                            key={item.key}
                            className="flex justify-between gap-2 text-[10px] text-amber-700"
                        >
                            <span className="truncate">
                                {item.presetName} · {item.model}
                            </span>
                            <span className="shrink-0">
                                剩余 {formatApiRouteCooldownRemaining(item.blockedUntil)}
                            </span>
                        </div>
                    ))}
                </div>
            )}

            {groups.map(group => {
                const analysis = analyzeApiFailoverGroup(group, apiPresets);
                const effectiveEnabled = group.enabled && analysis.canEnable;
                const advanced = advancedScope === group.scope;

                return (
                    <section
                        key={group.scope}
                        className="rounded-[22px] border border-slate-200/80 bg-white p-4 shadow-sm space-y-3"
                    >
                        <div className="flex items-center justify-between gap-3">
                            <div className="min-w-0">
                                <div className="text-sm font-bold text-slate-700">
                                    {group.name}线路
                                </div>
                                <div className="mt-0.5 text-[10px] text-slate-400">
                                    {group.scope === 'story'
                                        ? analysis.compatibleRouteCount > 0
                                            ? effectiveEnabled
                                                ? `第一条为剧情专用主线路 · 回退已启用 ${analysis.compatibleRouteCount} 条`
                                                : '第一条为剧情专用主线路 · 回退未启用'
                                            : '未配置时沿用当前主 API'
                                        : <>
                                            按从上到下的顺序尝试
                                            {effectiveEnabled
                                                ? ` · 回退已启用 ${analysis.compatibleRouteCount} 条`
                                                : analysis.compatibleRouteCount === 1
                                                    ? ' · 单 API 直连'
                                                    : ' · 回退未启用'}
                                        </>}
                                </div>
                            </div>

                            <div className="flex shrink-0 items-center gap-2">
                                <span className="text-[9px] text-slate-400">
                                    {group.scope === 'story' ? '备用回退' : '回退'}
                                </span>
                                <button
                                    type="button"
                                    onClick={() =>
                                        toggleGroup(
                                            group.scope,
                                            !group.enabled,
                                        )
                                    }
                                    className="appearance-none border-0 bg-transparent p-0"
                                    aria-label={`${effectiveEnabled ? '关闭' : '开启'}${group.name}备用回退`}
                                    aria-pressed={effectiveEnabled}
                                >
                                    <span className={`flex h-6 w-10 items-center rounded-full p-1 transition-colors ${
                                        effectiveEnabled
                                            ? 'bg-emerald-500'
                                            : 'bg-slate-200'
                                    }`}>
                                        <span className={`h-4 w-4 rounded-full bg-white shadow-sm transition-transform ${
                                            effectiveEnabled
                                                ? 'translate-x-4'
                                                : ''
                                        }`} />
                                    </span>
                                </button>
                            </div>
                        </div>

                        {group.enabled && !analysis.canEnable && (
                            <div className="rounded-xl border border-amber-200 bg-amber-50 p-2 text-[10px] text-amber-700">
                                旧配置中的回退开关已失去足够线路，运行时会安全降级为单 API 直连，不会阻断聊天。
                            </div>
                        )}

                        <div className="space-y-2.5">
                            {group.members.map((member, index) => {
                                const preset = presetMap.get(member.presetId);
                                const memberAnalysis = analysis.members[index];
                                const issueLabel = apiFailoverIssueLabel(memberAnalysis?.issue);
                                const currentValue = memberRouteKey(
                                    member.presetId,
                                    member.model,
                                );
                                const usedByOtherRows = new Set(
                                    group.members
                                        .filter((_, currentIndex) => currentIndex !== index)
                                        .map(existing =>
                                            memberRouteKey(
                                                existing.presetId,
                                                existing.model,
                                            ),
                                        ),
                                );
                                const candidates = routeOptions.filter(
                                    option =>
                                        option.key === currentValue
                                        || !usedByOtherRows.has(option.key),
                                );
                                const currentIsKnown = routeOptions.some(
                                    option => option.key === currentValue,
                                );
                                const selectedModel = resolvedMemberModel(
                                    member.presetId,
                                    member.model,
                                );

                                return (
                                    <div
                                        key={`${member.presetId}-${selectedModel}-${index}`}
                                        className={`rounded-2xl border p-3 transition-colors ${
                                            index === 0
                                                ? 'border-primary/20 bg-primary/5'
                                                : 'border-slate-100 bg-slate-50/70'
                                        }`}
                                    >
                                        <div className="mb-2 flex items-center justify-between gap-2">
                                            <div className="flex min-w-0 items-center gap-2">
                                                <span className={`shrink-0 rounded-full px-2 py-0.5 text-[9px] font-bold ${
                                                    index === 0
                                                        ? 'bg-primary/10 text-primary'
                                                        : 'bg-white text-slate-400'
                                                }`}>
                                                    {index === 0 ? '主线路' : `备用 ${index}`}
                                                </span>
                                                <span className="truncate text-[10px] text-slate-400">
                                                    {preset?.name || '预设已缺失'}
                                                </span>
                                            </div>
                                            <div className="flex shrink-0 items-center gap-1">
                                                <button
                                                    type="button"
                                                    disabled={index === 0}
                                                    onClick={() => moveRoute(group.scope, index, -1)}
                                                    className="h-7 w-7 rounded-full bg-white text-[11px] text-slate-400 shadow-sm disabled:opacity-25"
                                                    aria-label="上移"
                                                >
                                                    ↑
                                                </button>
                                                <button
                                                    type="button"
                                                    disabled={index === group.members.length - 1}
                                                    onClick={() => moveRoute(group.scope, index, 1)}
                                                    className="h-7 w-7 rounded-full bg-white text-[11px] text-slate-400 shadow-sm disabled:opacity-25"
                                                    aria-label="下移"
                                                >
                                                    ↓
                                                </button>
                                                <button
                                                    type="button"
                                                    onClick={() => removeRoute(group.scope, index)}
                                                    className="h-7 w-7 rounded-full bg-white text-[12px] text-rose-400 shadow-sm"
                                                    aria-label="删除线路"
                                                >
                                                    ×
                                                </button>
                                            </div>
                                        </div>

                                        <div className="relative">
                                            <select
                                                value={currentValue}
                                                onChange={event =>
                                                    replaceRoute(
                                                        group.scope,
                                                        index,
                                                        event.target.value,
                                                    )
                                                }
                                                className={`w-full appearance-none rounded-xl border bg-white px-3 py-2.5 pr-8 text-[11px] font-medium outline-none transition-colors ${
                                                    preset && currentIsKnown
                                                        ? 'border-slate-200 text-slate-700 focus:border-primary/40'
                                                        : 'border-rose-200 bg-rose-50 text-rose-600'
                                                }`}
                                            >
                                                {!currentIsKnown && (
                                                    <option value={currentValue}>
                                                        {preset
                                                            ? `${preset.name} · ${selectedModel || '模型已缺失'}`
                                                            : `已缺失：${member.presetId}`}
                                                    </option>
                                                )}
                                                {candidates.map(option => (
                                                    <option
                                                        key={option.key}
                                                        value={option.key}
                                                    >
                                                        {option.presetName} · {option.model}
                                                    </option>
                                                ))}
                                            </select>
                                            <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[10px] text-slate-300">
                                                ▾
                                            </span>
                                        </div>

                                        {issueLabel && (
                                            <div className="mt-1.5 break-words text-[9px] leading-tight text-rose-500">
                                                {issueLabel}
                                            </div>
                                        )}

                                        {group.scope !== 'emotion' && (
                                            <label className="mt-2 flex items-center gap-1.5 text-[9px] text-slate-400">
                                                <span className="shrink-0">首字最多等</span>
                                                <input
                                                    type="number"
                                                    min={0}
                                                    max={300}
                                                    step={1}
                                                    value={Math.round((member.firstByteTimeoutMs || 0) / 1000)}
                                                    onChange={event => {
                                                        const seconds = Math.max(
                                                            0,
                                                            Math.min(
                                                                300,
                                                                Math.round(Number(event.target.value) || 0),
                                                            ),
                                                        );
                                                        updateGroup(
                                                            group.scope,
                                                            current => ({
                                                                ...current,
                                                                members: current.members.map((item, currentIndex) =>
                                                                    currentIndex === index
                                                                        ? {
                                                                            ...item,
                                                                            ...(seconds > 0
                                                                                ? { firstByteTimeoutMs: seconds * 1000 }
                                                                                : { firstByteTimeoutMs: undefined }),
                                                                        }
                                                                        : item
                                                                ),
                                                            }),
                                                        );
                                                    }}
                                                    className="w-14 rounded-lg border border-slate-200 bg-white px-1.5 py-1 text-center text-[10px] text-slate-600 outline-none focus:border-primary/30"
                                                    aria-label={`${preset?.name || '线路'}首字等待秒数`}
                                                />
                                                <span className="shrink-0">秒</span>
                                                <span className="text-[8px] text-slate-300">0 = 不限</span>
                                            </label>
                                        )}
                                    </div>
                                );
                            })}
                        </div>

                        <button
                            type="button"
                            onClick={() => addRoute(group.scope)}
                            disabled={unusedRouteOptions(group).length === 0}
                            className="w-full rounded-xl border border-dashed border-primary/25 bg-primary/5 py-2.5 text-[11px] font-bold text-primary transition-all active:scale-[0.99] disabled:border-slate-200 disabled:bg-slate-50 disabled:text-slate-300"
                        >
                            {group.members.length === 0 ? '+ 选择主线路' : '+ 添加备用线路'}
                        </button>

                        <button
                            type="button"
                            onClick={() =>
                                setAdvancedScope(
                                    advanced ? null : group.scope,
                                )
                            }
                            className="rounded-lg px-2 py-1 text-[10px] text-slate-400 transition-colors hover:bg-slate-50 hover:text-slate-500"
                        >
                            {advanced ? '收起高级策略 ↑' : '高级策略 ↓'}
                        </button>

                        {advanced && (
                            <div className="grid grid-cols-2 gap-3 rounded-2xl border border-slate-100 bg-slate-50/80 p-3">
                                <label className="col-span-2 text-[10px] text-slate-500">
                                    单次超时（秒）
                                    <input
                                        type="number"
                                        min={30}
                                        max={600}
                                        value={Math.round(
                                            group.policy.timeoutMs / 1000,
                                        )}
                                        onChange={event =>
                                            updateGroup(
                                                group.scope,
                                                current => ({
                                                    ...current,
                                                    policy: {
                                                        ...current.policy,
                                                        timeoutMs:
                                                            Number(
                                                                event.target.value,
                                                            ) * 1000,
                                                    },
                                                }),
                                            )
                                        }
                                        className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs outline-none focus:border-primary/30"
                                    />
                                </label>

                                {group.scope === 'chat' && (
                                    <label className="col-span-2 flex items-center justify-between gap-3 text-[10px] text-slate-500">
                                        <span>
                                            只允许同模型家族
                                            <span className="block text-[9px] text-slate-400">
                                                推荐保持开启，避免工具/思考参数不兼容
                                            </span>
                                        </span>
                                        <button
                                            type="button"
                                            onClick={() =>
                                                updateGroup(
                                                    group.scope,
                                                    current => ({
                                                        ...current,
                                                        policy: {
                                                            ...current.policy,
                                                            strictSameModel:
                                                                !current.policy.strictSameModel,
                                                        },
                                                    }),
                                                )
                                            }
                                            className="shrink-0 appearance-none border-0 bg-transparent p-0"
                                            aria-pressed={group.policy.strictSameModel}
                                            aria-label="只允许同模型家族"
                                        >
                                            <span className={`flex h-6 w-10 items-center rounded-full p-1 transition-colors ${
                                                group.policy.strictSameModel
                                                    ? 'bg-emerald-500'
                                                    : 'bg-slate-200'
                                            }`}>
                                                <span className={`h-4 w-4 rounded-full bg-white shadow-sm transition-transform ${
                                                    group.policy.strictSameModel
                                                        ? 'translate-x-4'
                                                        : ''
                                                }`} />
                                            </span>
                                        </button>
                                    </label>
                                )}
                            </div>
                        )}
                    </section>
                );
            })}

            <button
                type="button"
                onClick={() => {
                    clearApiFailoverRouteCooldowns();
                    setCooldowns([]);
                    addToast('已清除所有线路的三分钟冷却状态', 'success');
                }}
                className="w-full rounded-xl bg-slate-100/80 py-2.5 text-[11px] font-bold text-slate-500 transition-colors active:scale-[0.99]"
            >
                清除线路冷却状态
            </button>
        </div>
    );
};

export default ApiFailoverSettings;
