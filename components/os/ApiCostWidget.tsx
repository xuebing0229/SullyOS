import React, {
  useCallback,
  useEffect,
  useState,
} from 'react';

import type {
  ApiCostOverview,
} from '../../types';

import { DB } from '../../utils/db';

import {
  API_COST_UPDATED_EVENT,
} from '../../utils/apiCostEvents';

import {
  formatYuan,
} from '../../utils/apiPricing';

interface Props {
  onClick: () => void;
  contentColor: string;
  paper?: boolean;
  acnh?: boolean;
  compact?: boolean;
}

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

const ApiCostWidget:
React.FC<Props> = ({
  onClick,
  contentColor,
  paper = false,
  acnh = false,
  compact = false,
}) => {
  const [
    overview,
    setOverview,
  ] = useState<
    ApiCostOverview
  >(EMPTY);

  const load =
    useCallback(async () => {
      try {
        setOverview(
          await DB
            .getApiCostOverview(),
        );
      } catch {
        setOverview(EMPTY);
      }
    }, []);

  useEffect(() => {
    void load();

    const refresh = () => {
      void load();
    };

    window.addEventListener(
      API_COST_UPDATED_EVENT,
      refresh,
    );

    window.addEventListener(
      'focus',
      refresh,
    );

    const onVisibility = () => {
      if (
        document.visibilityState
        === 'visible'
      ) {
        refresh();
      }
    };

    document.addEventListener(
      'visibilitychange',
      onVisibility,
    );

    /*
     * 前台跨过 0 点时刷新。
     * 每分钟检查一次只做本地日期字符串比较，开销可忽略。
     */
    let dateKey =
      new Date()
        .toDateString();

    const timer =
      window.setInterval(
        () => {
          const next =
            new Date()
              .toDateString();

          if (next !== dateKey) {
            dateKey = next;
            refresh();
          }
        },
        60_000,
      );

    return () => {
      window.removeEventListener(
        API_COST_UPDATED_EVENT,
        refresh,
      );

      window.removeEventListener(
        'focus',
        refresh,
      );

      document.removeEventListener(
        'visibilitychange',
        onVisibility,
      );

      window.clearInterval(timer);
    };
  }, [load]);

  const style =
    paper
      ? {
          background:
            'rgba(224,221,215,0.40)',
          border:
            '1px solid rgba(91,72,51,0.07)',
          boxShadow:
            '0 5px 16px rgba(91,72,51,0.055)',
        }
      : acnh
        ? {
            background:
              '#FFFBF2',
            border:
              '2px solid #ece0c8',
            boxShadow:
              '0 4px 12px -5px rgba(120,90,40,0.25)',
          }
        : {
            background:
              'rgba(255,255,255,0.10)',
            border:
              '1px solid rgba(255,255,255,0.14)',
            boxShadow:
              '0 8px 24px rgba(0,0,0,0.12), inset 0 1px 0 rgba(255,255,255,0.08)',
            backdropFilter:
              'blur(18px) saturate(1.25)',
            WebkitBackdropFilter:
              'blur(18px) saturate(1.25)',
          };

  return (
    <button
      type="button"
      onClick={onClick}
      className={`mb-3 w-full cursor-pointer overflow-hidden rounded-3xl text-left transition-transform active:scale-[0.985] ${
        compact
          ? 'px-3 py-2.5'
          : 'px-4 py-3'
      }`}
      style={{
        ...style,
        color: contentColor,
      }}
      aria-label="查看 API 花费详情"
    >
      <div className="flex items-center gap-3">
        <div
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl text-lg"
          style={{
            background:
              paper
                ? 'rgba(120,131,105,0.12)'
                : acnh
                  ? '#eaf5dc'
                  : 'rgba(255,255,255,0.12)',
          }}
        >
          ¥
        </div>

        <div className="min-w-0 flex-1">
          <div className="mb-1 flex items-center justify-between gap-2">
            <span className="text-[10px] font-bold uppercase tracking-[0.18em] opacity-55">
              API 花费
            </span>

            {overview
              .todayUnpricedCalls
              > 0 && (
              <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[9px] font-bold text-amber-600">
                {overview
                  .todayUnpricedCalls}
                次未计价
              </span>
            )}
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <div className="text-[9px] opacity-45">
                今日
              </div>

              <div className="truncate text-[17px] font-black tabular-nums">
                {formatYuan(
                  overview
                    .todayCostMicros,
                  {
                    compact: true,
                  },
                )}
              </div>
            </div>

            <div>
              <div className="text-[9px] opacity-45">
                累计
              </div>

              <div className="truncate text-[17px] font-black tabular-nums">
                {formatYuan(
                  overview
                    .totalCostMicros,
                  {
                    compact: true,
                  },
                )}
              </div>
            </div>
          </div>
        </div>

        <span className="shrink-0 text-xl opacity-35">
          ›
        </span>
      </div>
    </button>
  );
};

export default React.memo(
  ApiCostWidget,
);
