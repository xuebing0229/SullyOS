import React, { useEffect, useMemo, useState } from 'react';
import type { ApiCostUnresolvedEntry } from '../../types';
import { DB } from '../../utils/db';
import { apiUnpricedReasonLabel } from '../../utils/apiCostFailurePolicy';
import { yuanStringToMicros } from '../../utils/apiPricing';

type Filter = 'all' | 'usage_missing' | 'pricing_not_configured' | 'preset' | 'legacy_unknown';
const filters: Array<[Filter, string]> = [
  ['all', '全部'],
  ['usage_missing', '无 Token 用量'],
  ['pricing_not_configured', '未配置价格'],
  ['preset', '未匹配预设'],
  ['legacy_unknown', '历史遗留'],
];
const matches = (entry: ApiCostUnresolvedEntry, filter: Filter) =>
  filter === 'all'
  || entry.reason === filter
  || (filter === 'preset'
    && (entry.reason === 'preset_not_found' || entry.reason === 'preset_ambiguous'));

const UnpricedCostResolver: React.FC<{
  entries: ApiCostUnresolvedEntry[];
  onUpdated: () => void | Promise<void>;
}> = ({ entries, onUpdated }) => {
  const [filter, setFilter] = useState<Filter>('all');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [amount, setAmount] = useState('');
  const [error, setError] = useState('');
  const [confirmBatch, setConfirmBatch] = useState(false);
  const [busy, setBusy] = useState(false);
  const visible = useMemo(
    () => entries.filter(entry => matches(entry, filter)),
    [entries, filter],
  );
  const visibleCalls = visible.reduce(
    (sum, entry) => sum + Math.max(1, entry.callCount),
    0,
  );
  useEffect(() => {
    if (!confirmBatch) return;
    const timer = window.setTimeout(() => setConfirmBatch(false), 5000);
    return () => window.clearTimeout(timer);
  }, [confirmBatch]);
  const ignore = async (id: string) => {
    setBusy(true);
    try {
      await DB.resolveApiCostUnpriced(id, { kind: 'ignore_zero' });
      await onUpdated();
    } finally {
      setBusy(false);
    }
  };
  const saveManual = async (entry: ApiCostUnresolvedEntry) => {
    setError('');
    try {
      const costMicros = yuanStringToMicros(amount);
      setBusy(true);
      await DB.resolveApiCostUnpriced(entry.id, { kind: 'manual_cost', costMicros });
      setEditingId(null);
      setAmount('');
      await onUpdated();
    } catch (cause: any) {
      setError(cause?.message || '请输入最多 6 位小数的非负金额');
    } finally {
      setBusy(false);
    }
  };
  const archiveVisible = async () => {
    if (!confirmBatch) {
      setConfirmBatch(true);
      return;
    }
    setBusy(true);
    try {
      await DB.resolveApiCostUnpricedBatch(
        visible.map(entry => entry.id),
        { kind: 'ignore_zero' },
      );
      setConfirmBatch(false);
      await onUpdated();
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="rounded-3xl border border-amber-200 bg-amber-50 p-4 shadow-sm" data-testid="unpriced-cost-resolver">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-black text-amber-900">待处理花费</h2>
          <p className="text-[10px] text-amber-700">不保存请求正文、Key 或 Token</p>
        </div>
        <button
          type="button"
          disabled={busy || visible.length === 0}
          onClick={() => void archiveVisible()}
          className="rounded-xl bg-amber-600 px-3 py-2 text-[10px] font-bold text-white disabled:opacity-40"
        >
          {confirmBatch ? `确认归档当前 ${visibleCalls} 次？` : '全部按 ¥0 归档'}
        </button>
      </div>
      <div className="mt-3 flex gap-1 overflow-x-auto no-scrollbar">
        {filters.map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => setFilter(key)}
            className={`shrink-0 rounded-full px-3 py-1 text-[10px] font-bold ${filter === key ? 'bg-amber-600 text-white' : 'bg-white text-amber-700'}`}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="mt-3 space-y-2">
        {visible.map(entry => (
          <div key={entry.id} className="rounded-2xl bg-white p-3 text-[10px] text-slate-500">
            <div className="flex justify-between gap-2">
              <b className="truncate text-xs text-slate-700">{entry.presetName}</b>
              <span>{new Date(entry.timestamp).toLocaleString('zh-CN', { hour12: false })}</span>
            </div>
            <div className="mt-1">
              {entry.model || '模型未知'} · {entry.appName || '其他 App'} / {entry.purpose || '未标注用途'}
            </div>
            {entry.charName && <div>角色：{entry.charName}</div>}
            <div className="mt-1 font-bold text-amber-700">
              {apiUnpricedReasonLabel(entry.reason)}
              {entry.callCount > 1 ? ` · 历史遗留 ${entry.callCount} 次` : ''}
            </div>
            {editingId === entry.id ? (
              <div className="mt-2 rounded-xl bg-slate-50 p-2">
                <label className="block text-[9px] font-bold text-slate-400">人民币金额</label>
                <input
                  value={amount}
                  onChange={event => setAmount(event.target.value)}
                  placeholder="0.000000"
                  inputMode="decimal"
                  className="mt-1 w-full rounded-lg border px-2 py-2 text-xs"
                />
                {entry.callCount > 1 && (
                  <p className="mt-1 text-[9px] text-amber-700">
                    该金额是这 {entry.callCount} 次调用的合计金额
                  </p>
                )}
                {error && <p className="mt-1 text-[9px] text-rose-500">{error}</p>}
                <div className="mt-2 flex gap-2">
                  <button type="button" disabled={busy} onClick={() => void saveManual(entry)} className="rounded-lg bg-emerald-600 px-3 py-1.5 font-bold text-white">保存金额</button>
                  <button type="button" onClick={() => { setEditingId(null); setError(''); }} className="rounded-lg bg-slate-200 px-3 py-1.5 font-bold">取消</button>
                </div>
              </div>
            ) : (
              <div className="mt-2 flex gap-2">
                <button type="button" disabled={busy} onClick={() => void ignore(entry.id)} className="rounded-lg bg-slate-800 px-3 py-1.5 font-bold text-white">按 ¥0 归档</button>
                <button type="button" onClick={() => { setEditingId(entry.id); setAmount(''); setError(''); }} className="rounded-lg bg-emerald-100 px-3 py-1.5 font-bold text-emerald-700">填写金额</button>
              </div>
            )}
          </div>
        ))}
        {visible.length === 0 && (
          <div className="py-5 text-center text-xs text-amber-500">当前筛选没有待处理项</div>
        )}
      </div>
    </section>
  );
};
export default UnpricedCostResolver;
