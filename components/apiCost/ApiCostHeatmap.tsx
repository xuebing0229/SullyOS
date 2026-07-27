import React, {
  useEffect,
  useMemo,
  useRef,
} from 'react';

import type {
  ApiCostDailySummary,
} from '../../types';

import {
  compareMicros,
  formatYuan,
} from '../../utils/apiPricing';

interface Props {
  summaries:
    ApiCostDailySummary[];
  selectedDateKey?:
    string;
  onSelect:
    (
      summary:
        ApiCostDailySummary
        | null,
      dateKey: string,
    ) => void;
}

interface DayCell {
  dateKey: string;
  date: Date;
  summary:
    ApiCostDailySummary
    | null;
}

const pad = (
  value: number,
): string =>
  String(value)
    .padStart(2, '0');

const dateKey = (
  date: Date,
): string =>
  [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
  ].join('-');

const addDays = (
  date: Date,
  amount: number,
): Date => {
  const next = new Date(date);
  next.setDate(
    next.getDate() + amount,
  );
  next.setHours(12, 0, 0, 0);
  return next;
};

const quantile = (
  sorted: bigint[],
  ratio: number,
): bigint => {
  if (sorted.length === 0) {
    return 0n;
  }

  const index =
    Math.min(
      sorted.length - 1,
      Math.max(
        0,
        Math.floor(
          (
            sorted.length - 1
          ) * ratio,
        ),
      ),
    );

  return sorted[index];
};

const COLORS = [
  'rgba(148,163,184,0.12)',
  'rgba(16,185,129,0.22)',
  'rgba(16,185,129,0.38)',
  'rgba(16,185,129,0.56)',
  'rgba(5,150,105,0.76)',
  'rgba(4,120,87,0.96)',
];

const ApiCostHeatmap:
React.FC<Props> = ({
  summaries,
  selectedDateKey,
  onSelect,
}) => {
  const scrollRef =
    useRef<HTMLDivElement>(
      null,
    );

  const summaryMap =
    useMemo(
      () =>
        new Map(
          summaries.map(
            summary => [
              summary.dateKey,
              summary,
            ],
          ),
        ),
      [summaries],
    );

  const days =
    useMemo<DayCell[]>(
      () => {
        const today =
          new Date();

        today.setHours(
          12,
          0,
          0,
          0,
        );

        const start =
          addDays(
            today,
            -364,
          );

        return Array.from(
          {
            length: 365,
          },
          (_, index) => {
            const date =
              addDays(
                start,
                index,
              );

            const key =
              dateKey(date);

            return {
              dateKey: key,
              date,
              summary:
                summaryMap.get(key)
                ?? null,
            };
          },
        );
      },
      [summaryMap],
    );

  const thresholds =
    useMemo(
      () => {
        const positive =
          summaries
            .map(summary => {
              try {
                return BigInt(
                  summary
                    .totalCostMicros
                  || '0',
                );
              } catch {
                return 0n;
              }
            })
            .filter(
              value => value > 0n,
            )
            .sort(
              (a, b) =>
                a < b
                  ? -1
                  : a > b
                    ? 1
                    : 0,
            );

        return [
          quantile(
            positive,
            0.2,
          ),
          quantile(
            positive,
            0.4,
          ),
          quantile(
            positive,
            0.6,
          ),
          quantile(
            positive,
            0.8,
          ),
        ];
      },
      [summaries],
    );

  const levelFor = (
    summary:
      ApiCostDailySummary
      | null,
  ): number => {
    if (!summary) return 0;

    let cost = 0n;

    try {
      cost =
        BigInt(
          summary
            .totalCostMicros
          || '0',
        );
    } catch {}

    if (cost <= 0n) return 0;
    if (cost <= thresholds[0]) return 1;
    if (cost <= thresholds[1]) return 2;
    if (cost <= thresholds[2]) return 3;
    if (cost <= thresholds[3]) return 4;
    return 5;
  };

  useEffect(() => {
    const node =
      scrollRef.current;

    if (!node) return;

    requestAnimationFrame(
      () => {
        node.scrollLeft =
          node.scrollWidth;
      },
    );
  }, []);

  /*
   * CSS grid 按列流动：
   * 7 行 = 星期；
   * 新日期继续向右生成列。
   */
  return (
    <div className="space-y-2">
      <div
        ref={scrollRef}
        className="overflow-x-auto pb-2 no-scrollbar"
      >
        <div
          className="grid w-max gap-[3px]"
          style={{
            gridTemplateRows:
              'repeat(7, 12px)',
            gridAutoColumns:
              '12px',
            gridAutoFlow:
              'column',
          }}
        >
          {days.map(day => {
            const level =
              levelFor(
                day.summary,
              );

            const selected =
              day.dateKey
              === selectedDateKey;

            return (
              <button
                key={day.dateKey}
                type="button"
                title={
                  `${day.dateKey} · `
                  + (
                    day.summary
                      ? formatYuan(
                          day.summary
                            .totalCostMicros,
                        )
                      : '¥0.00'
                  )
                }
                onClick={() =>
                  onSelect(
                    day.summary,
                    day.dateKey,
                  )
                }
                className={`h-3 w-3 rounded-[3px] transition-transform active:scale-125 ${
                  selected
                    ? 'ring-2 ring-emerald-500 ring-offset-1'
                    : ''
                }`}
                style={{
                  background:
                    COLORS[level],
                }}
                aria-label={
                  `${day.dateKey} `
                  + (
                    day.summary
                      ? formatYuan(
                          day.summary
                            .totalCostMicros,
                        )
                      : '无消费'
                  )
                }
              />
            );
          })}
        </div>
      </div>

      <div className="flex items-center justify-end gap-1 text-[9px] text-slate-400">
        <span>少</span>

        {COLORS.map(
          (color, index) => (
            <span
              key={index}
              className="h-2.5 w-2.5 rounded-[3px]"
              style={{
                background: color,
              }}
            />
          ),
        )}

        <span>多</span>
      </div>
    </div>
  );
};

export default ApiCostHeatmap;
