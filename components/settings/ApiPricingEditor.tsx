import React from 'react';

import type {
  ApiPricing,
} from '../../types';

interface Props {
  value?: ApiPricing;
  onChange:
    (value: ApiPricing) => void;
  compact?: boolean;
}

const DEFAULT_PER_REQUEST:
ApiPricing = {
  mode: 'per_request',
  pricePerRequestYuan: '',
};

const DEFAULT_PER_TOKEN:
ApiPricing = {
  mode: 'per_token',
  inputYuanPerMillion: '',
  cacheWriteYuanPerMillion: '',
  cacheReadYuanPerMillion: '',
  outputYuanPerMillion: '',
};

const PriceField:
React.FC<{
  label: string;
  value: string;
  onChange:
    (value: string) => void;
  hint?: string;
}> = ({
  label,
  value,
  onChange,
  hint,
}) => (
  <label className="block">
    <span className="mb-1 flex items-center justify-between gap-2 text-[10px] font-bold text-slate-500">
      <span>{label}</span>
      {hint && (
        <span className="font-normal text-slate-300">
          {hint}
        </span>
      )}
    </span>

    <div className="flex items-center rounded-xl border border-slate-200 bg-white/80 px-3">
      <span className="text-sm font-bold text-slate-400">
        ¥
      </span>

      <input
        type="text"
        inputMode="decimal"
        value={value}
        onChange={event => {
          const next =
            event.target.value;

          if (
            next === ''
            || /^\d*(?:\.\d{0,6})?$/.test(
              next,
            )
          ) {
            onChange(next);
          }
        }}
        className="min-w-0 flex-1 bg-transparent px-2 py-2 text-sm text-slate-700 outline-none"
        placeholder="0.000000"
      />
    </div>
  </label>
);

const ApiPricingEditor:
React.FC<Props> = ({
  value,
  onChange,
  compact = false,
}) => {
  const current =
    value
    ?? DEFAULT_PER_REQUEST;

  const selectMode = (
    mode:
      | 'per_request'
      | 'per_token',
  ) => {
    if (mode === current.mode) {
      return;
    }

    onChange(
      mode === 'per_request'
        ? {
            ...DEFAULT_PER_REQUEST,
          }
        : {
            ...DEFAULT_PER_TOKEN,
          },
    );
  };

  return (
    <div className={`rounded-2xl border border-emerald-100 bg-emerald-50/60 ${compact ? 'p-3' : 'p-4'} space-y-3`}>
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-xs font-bold text-emerald-700">
            API 价格
          </div>

          <div className="mt-0.5 text-[10px] text-emerald-700/60">
            所有价格固定使用人民币
          </div>
        </div>

        <div className="flex rounded-xl bg-white/70 p-1">
          <button
            type="button"
            onClick={() =>
              selectMode(
                'per_request',
              )
            }
            className={`rounded-lg px-3 py-1.5 text-[11px] font-bold transition ${
              current.mode
                === 'per_request'
                ? 'bg-emerald-500 text-white shadow-sm'
                : 'text-slate-400'
            }`}
          >
            按次
          </button>

          <button
            type="button"
            onClick={() =>
              selectMode(
                'per_token',
              )
            }
            className={`rounded-lg px-3 py-1.5 text-[11px] font-bold transition ${
              current.mode
                === 'per_token'
                ? 'bg-emerald-500 text-white shadow-sm'
                : 'text-slate-400'
            }`}
          >
            按量
          </button>
        </div>
      </div>

      {current.mode
        === 'per_request'
        ? (
          <PriceField
            label="每次成功真实请求"
            value={
              current
                .pricePerRequestYuan
            }
            onChange={
              pricePerRequestYuan =>
                onChange({
                  mode:
                    'per_request',
                  pricePerRequestYuan,
                })
            }
          />
        )
        : (
          <div className="grid grid-cols-1 gap-2.5">
            <PriceField
              label="普通输入"
              hint="人民币 / 1M Token"
              value={
                current
                  .inputYuanPerMillion
              }
              onChange={
                inputYuanPerMillion =>
                  onChange({
                    ...current,
                    inputYuanPerMillion,
                  })
              }
            />

            <PriceField
              label="创建缓存 / 缓存未命中"
              hint="人民币 / 1M Token"
              value={
                current
                  .cacheWriteYuanPerMillion
              }
              onChange={
                cacheWriteYuanPerMillion =>
                  onChange({
                    ...current,
                    cacheWriteYuanPerMillion,
                  })
              }
            />

            <PriceField
              label="读取缓存 / 缓存命中"
              hint="人民币 / 1M Token"
              value={
                current
                  .cacheReadYuanPerMillion
              }
              onChange={
                cacheReadYuanPerMillion =>
                  onChange({
                    ...current,
                    cacheReadYuanPerMillion,
                  })
              }
            />

            <PriceField
              label="输出"
              hint="人民币 / 1M Token"
              value={
                current
                  .outputYuanPerMillion
              }
              onChange={
                outputYuanPerMillion =>
                  onChange({
                    ...current,
                    outputYuanPerMillion,
                  })
              }
            />
          </div>
        )}

      <p className="text-[10px] leading-relaxed text-slate-400">
        本地 AI 缓存、并发复用和失败请求不计费。按量请求若服务商没有返回 Token，将标记为未计价。
      </p>
    </div>
  );
};

export default ApiPricingEditor;
