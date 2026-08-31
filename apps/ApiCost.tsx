import React, {
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react';

import { useOS }
  from '../context/OSContext';

import type {
  ApiCostBucket,
  ApiCostDailySummary,
  ApiCostOverview,
  ApiCostUnresolvedEntry,
} from '../types';

import { DB }
  from '../utils/db';

import {
  API_COST_UPDATED_EVENT,
  emitApiCostUpdated,
} from '../utils/apiCostEvents';

import {
  formatYuan,
} from '../utils/apiPricing';

import ApiCostHeatmap
  from '../components/apiCost/ApiCostHeatmap';
import UnpricedCostResolver
  from '../components/apiCost/UnpricedCostResolver';
import { migrateApiCostUnresolvedV1 }
  from '../utils/apiCostUnresolvedMigration';
import { backfillUnpricedCallsByPresetIdentity }
  from '../utils/apiCostBackfill';

import ApiCallLogModal
  from '../components/settings/ApiCallLogModal';

type RangeKey =
  | 'today'
  | '7d'
  | 'month'
  | 'all';

type Dimension =
  | 'preset'
  | 'app'
  | 'purpose';

const EMPTY:
ApiCostOverview = {
  todayCostMicros: '0',
  monthCostMicros: '0',
  totalCostMicros: '0',
  todayPricedCalls: 0,
  todayFreeCalls: 0,
  todayUnpricedCalls: 0,
  totalUnpricedCalls: 0,
};

const pad = (
  value: number,
) =>
  String(value)
    .padStart(2, '0');

const localDateKey = (
  date: Date,
) =>
  [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
  ].join('-');

const dateDaysAgo = (
  amount: number,
) => {
  const date = new Date();

  date.setDate(
    date.getDate() - amount,
  );

  return localDateKey(date);
};

const sumMicros = (
  values: string[],
): string =>
  values.reduce(
    (sum, value) => {
      try {
        return (
          BigInt(sum)
          + BigInt(value || '0')
        ).toString();
      } catch {
        return sum;
      }
    },
    '0',
  );

const ApiCost:
React.FC = () => {
  const {
    closeApp,
    apiPresets,
  } = useOS();

  const [
    summaries,
    setSummaries,
  ] = useState<
    ApiCostDailySummary[]
  >([]);

  const [
    overview,
    setOverview,
  ] = useState<
    ApiCostOverview
  >(EMPTY);
  const [unresolved, setUnresolved] = useState<ApiCostUnresolvedEntry[]>([]);
  const [showResolver, setShowResolver] = useState(false);

  const [
    range,
    setRange,
  ] = useState<RangeKey>(
    'month',
  );

  const [
    dimension,
    setDimension,
  ] = useState<Dimension>(
    'preset',
  );

  const [
    selectedDateKey,
    setSelectedDateKey,
  ] = useState<string>(
    localDateKey(
      new Date(),
    ),
  );

  const [
    showLog,
    setShowLog,
  ] = useState(false);

  const load =
    useCallback(async () => {
      const [
        nextSummaries,
        nextOverview,
        nextUnresolved,
      ] = await Promise.all([
        DB.getApiCostDailySummaries(),
        DB.getApiCostOverview(),
        DB.getApiCostUnresolvedEntries(),
      ]);

      setSummaries(
        nextSummaries,
      );

      setOverview(
        nextOverview,
      );
      setUnresolved(nextUnresolved);
    }, []);

  useEffect(() => {
    void migrateApiCostUnresolvedV1()
      .catch(error => console.warn('[API Cost] unresolved migration failed', error))
      .then(() => backfillUnpricedCallsByPresetIdentity(apiPresets))
      .catch(error => console.warn('[API Cost] preset identity backfill failed', error))
      .finally(() => void load());

    const refresh = () => {
      void load();
    };

    window.addEventListener(
      API_COST_UPDATED_EVENT,
      refresh,
    );

    return () => {
      window.removeEventListener(
        API_COST_UPDATED_EVENT,
        refresh,
      );
    };
  }, [apiPresets, load]);

  const selectedSummary =
    useMemo(
      () =>
        summaries.find(
          item =>
            item.dateKey
            === selectedDateKey,
        )
        ?? null,
      [
        summaries,
        selectedDateKey,
      ],
    );

  const filtered =
    useMemo(
      () => {
        const today =
          localDateKey(
            new Date(),
          );

        const month =
          today.slice(0, 7);

        return summaries.filter(
          summary => {
            if (
              range === 'today'
            ) {
              return (
                summary.dateKey
                === today
              );
            }

            if (
              range === '7d'
            ) {
              return (
                summary.dateKey
                >= dateDaysAgo(6)
              );
            }

            if (
              range === 'month'
            ) {
              return (
                summary.dateKey
                  .startsWith(
                    month,
                  )
              );
            }

            return true;
          },
        );
      },
      [
        summaries,
        range,
      ],
    );

  const rangeTotal =
    useMemo(
      () =>
        sumMicros(
          filtered.map(
            summary =>
              summary
                .totalCostMicros,
          ),
        ),
      [filtered],
    );

  const buckets =
    useMemo(
      () => {
        const map =
          new Map<
            string,
            ApiCostBucket
          >();

        for (
          const summary
          of filtered
        ) {
          const source =
            dimension === 'preset'
              ? summary.byPreset
              : dimension === 'app'
                ? summary.byApp
                : summary.byPurpose;

          for (
            const bucket
            of source
          ) {
            const current =
              map.get(
                bucket.key,
              );

            if (!current) {
              map.set(
                bucket.key,
                {
                  ...bucket,
                },
              );
              continue;
            }

            map.set(
              bucket.key,
              {
                ...current,
                label:
                  bucket.label
                  || current.label,
                costMicros:
                  sumMicros([
                    current
                      .costMicros,
                    bucket
                      .costMicros,
                  ]),
                callCount:
                  current.callCount
                  + bucket.callCount,
              },
            );
          }
        }

        return [
          ...map.values(),
        ].sort(
          (a, b) => {
            try {
              const left =
                BigInt(
                  a.costMicros
                  || '0',
                );

              const right =
                BigInt(
                  b.costMicros
                  || '0',
                );

              return left > right
                ? -1
                : left < right
                  ? 1
                  : 0;
            } catch {
              return 0;
            }
          },
        );
      },
      [
        filtered,
        dimension,
      ],
    );

  const rangeLabel =
    range === 'today'
      ? '今天'
      : range === '7d'
        ? '近 7 天'
        : range === 'month'
          ? '本月'
          : '累计';

  const clearHistory =
    async () => {
      if (
        !window.confirm(
          '确定清空全部 API 花费历史吗？最近 5 天调用明细不会被删除。',
        )
      ) {
        return;
      }

      await DB
        .clearApiCostHistory();

      await load();
    };

  return (
    <div className="flex h-full flex-col bg-[#f7f5f2] text-slate-700">
      <header className="flex items-center gap-3 px-5 pb-3 pt-[calc(var(--safe-top)+1rem)]">
        <button
          type="button"
          onClick={closeApp}
          className="flex h-10 w-10 items-center justify-center rounded-full bg-white text-2xl shadow-sm active:scale-95"
          aria-label="返回"
        >
          ‹
        </button>

        <div>
          <h1 className="text-xl font-black">
            API 花费
          </h1>

          <p className="text-[10px] text-slate-400">
            人民币 · 本地统计
          </p>
        </div>
      </header>

      <main className="flex-1 space-y-4 overflow-y-auto px-5 pb-[calc(var(--safe-bottom)+1.5rem)] no-scrollbar">
        <section className="grid grid-cols-3 gap-2">
          {[
            [
              '今日',
              overview
                .todayCostMicros,
            ],
            [
              '本月',
              overview
                .monthCostMicros,
            ],
            [
              '累计',
              overview
                .totalCostMicros,
            ],
          ].map(
            ([label, value]) => (
              <div
                key={label}
                className="rounded-2xl bg-white px-3 py-3 shadow-sm"
              >
                <div className="text-[10px] text-slate-400">
                  {label}
                </div>

                <div className="mt-1 truncate text-sm font-black tabular-nums text-emerald-700">
                  {formatYuan(
                    value,
                    {
                      compact: true,
                    },
                  )}
                </div>
              </div>
            ),
          )}
        </section>

        {overview.totalUnpricedCalls > 0 && (
          <div className="flex items-center justify-between gap-3 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-[11px] text-amber-700">
            <div>
              <div>今天有 <b>{overview.todayUnpricedCalls}</b> 次待处理</div>
              <div>累计待处理 <b>{overview.totalUnpricedCalls}</b> 次</div>
            </div>
            <button
              type="button"
              onClick={() => setShowResolver(value => !value)}
              className="rounded-xl bg-amber-600 px-3 py-2 font-bold text-white"
            >
              {showResolver ? '收起' : '去处理'}
            </button>
          </div>
        )}

        {showResolver && (
          <UnpricedCostResolver
            entries={unresolved}
            onUpdated={() => emitApiCostUpdated()}
          />
        )}

        <section className="rounded-3xl bg-white p-4 shadow-sm">
          <div className="mb-3 flex items-center justify-between">
            <div>
              <h2 className="text-sm font-black">
                每日花费
              </h2>

              <p className="text-[10px] text-slate-400">
                最近 365 天
              </p>
            </div>
          </div>

          <ApiCostHeatmap
            summaries={summaries}
            selectedDateKey={
              selectedDateKey
            }
            onSelect={(
              _summary,
              key,
            ) =>
              setSelectedDateKey(
                key,
              )
            }
          />

          <div className="mt-4 rounded-2xl bg-slate-50 px-4 py-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-[10px] text-slate-400">
                  {selectedDateKey}
                </div>

                <div className="mt-0.5 text-lg font-black text-emerald-700">
                  {formatYuan(
                    selectedSummary
                      ?.totalCostMicros,
                  )}
                </div>
              </div>

              <div className="text-right text-[10px] leading-relaxed text-slate-400">
                <div>
                  计价
                  {' '}
                  {selectedSummary
                    ?.pricedCallCount
                    ?? 0}
                  {' '}
                  次
                </div>

                <div>
                  待处理
                  {' '}
                  {selectedSummary
                    ?.unpricedCallCount
                    ?? 0}
                  {' '}
                  次
                </div>
                {(selectedSummary?.ignoredCallCount ?? 0) > 0 && (
                  <div>
                    已归档 {selectedSummary?.ignoredCallCount ?? 0} 次
                  </div>
                )}
              </div>
            </div>
          </div>
        </section>

        <section className="rounded-3xl bg-white p-4 shadow-sm">
          <div className="mb-3 flex gap-1 overflow-x-auto rounded-xl bg-slate-100 p-1 no-scrollbar">
            {[
              ['today', '今天'],
              ['7d', '近7天'],
              ['month', '本月'],
              ['all', '累计'],
            ].map(
              ([key, label]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() =>
                    setRange(
                      key as RangeKey,
                    )
                  }
                  className={`shrink-0 flex-1 rounded-lg px-3 py-1.5 text-[10px] font-bold ${
                    range === key
                      ? 'bg-white text-emerald-700 shadow-sm'
                      : 'text-slate-400'
                  }`}
                >
                  {label}
                </button>
              ),
            )}
          </div>

          <div className="mb-4 flex gap-2">
            {[
              ['preset', '按 API'],
              ['app', '按 App'],
              ['purpose', '按用途'],
            ].map(
              ([key, label]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() =>
                    setDimension(
                      key as Dimension,
                    )
                  }
                  className={`rounded-full px-3 py-1 text-[10px] font-bold ${
                    dimension === key
                      ? 'bg-emerald-100 text-emerald-700'
                      : 'bg-slate-100 text-slate-400'
                  }`}
                >
                  {label}
                </button>
              ),
            )}
          </div>

          <div className="mb-3 flex items-end justify-between">
            <div>
              <div className="text-[10px] text-slate-400">
                {rangeLabel}花费
              </div>

              <div className="text-xl font-black text-slate-700">
                {formatYuan(
                  rangeTotal,
                )}
              </div>
            </div>
          </div>

          <div className="space-y-2">
            {buckets.length > 0
              ? buckets.map(
                  bucket => (
                    <div
                      key={bucket.key}
                      className="flex items-center justify-between gap-3 rounded-2xl bg-slate-50 px-3 py-2.5"
                    >
                      <div className="min-w-0">
                        <div className="truncate text-xs font-bold">
                          {bucket.label}
                        </div>

                        <div className="text-[9px] text-slate-400">
                          {bucket.callCount}
                          {' '}
                          次计价调用
                        </div>
                      </div>

                      <div className="shrink-0 text-sm font-black tabular-nums text-emerald-700">
                        {formatYuan(
                          bucket
                            .costMicros,
                        )}
                      </div>
                    </div>
                  ),
                )
              : (
                <div className="py-8 text-center text-xs text-slate-300">
                  这个范围暂无已计价消费
                </div>
              )}
          </div>
        </section>

        <button
          type="button"
          onClick={() =>
            setShowLog(true)
          }
          className="w-full rounded-2xl bg-slate-800 py-3 text-sm font-bold text-white active:scale-[0.99]"
        >
          查看 API 调用明细
        </button>

        <button
          type="button"
          onClick={clearHistory}
          className="w-full py-2 text-[11px] font-bold text-rose-400"
        >
          清空花费历史
        </button>

        <p className="pb-2 text-center text-[9px] text-slate-300">
          累计自消费统计启用之日起
        </p>
      </main>

      <ApiCallLogModal
        isOpen={showLog}
        onClose={() =>
          setShowLog(false)
        }
      />
    </div>
  );
};

export default ApiCost;
