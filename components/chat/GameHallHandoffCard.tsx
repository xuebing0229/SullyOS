import React from 'react';
import type { Message } from '../../types';
import type { GameHallHandoffMeta } from '../../utils/gameHallTypes';

const GameHallHandoffCard: React.FC<{ message: Message; charName: string }> = ({ message, charName }) => {
  const meta = (message.metadata || {}) as unknown as GameHallHandoffMeta;
  const accounts = Array.isArray(meta.accountRefs) ? meta.accountRefs : [];
  const time = new Date(message.timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  return (
    <div className="w-72 overflow-hidden rounded-2xl border border-violet-300/35 bg-gradient-to-br from-[#251d4c] via-[#17152f] to-[#0e1022] shadow-[0_8px_28px_rgba(61,44,130,0.35)]">
      <div className="flex items-center gap-2 border-b border-white/10 px-3 py-2.5">
        <span className="text-lg">🎮</span>
        <div className="min-w-0 flex-1">
          <div className="text-[9px] font-bold tracking-[0.22em] text-violet-300/80">GAME HALL · 交接</div>
          <div className="truncate text-[12px] font-semibold text-white/95">{meta.title || '游戏厅'}</div>
        </div>
        <span className="text-[9px] text-white/35">{time}</span>
      </div>
      <div className="px-3 py-3">
        <p className="whitespace-pre-wrap text-[12px] leading-relaxed text-violet-50/90">
          {meta.summary || `${charName}从游戏厅回到主对话继续。`}
        </p>
        <div className="mt-2 rounded-xl bg-white/5 px-2.5 py-2 text-[9px] text-violet-100/60">
          已总结 {meta.sourceMessageCount || 0} 条游戏厅原文
          {meta.transferredImageCount ? ` · 带回 ${meta.transferredImageCount} 张图片` : ''}
        </div>
        {accounts.length > 0 && (
          <div className="mt-2 rounded-xl border border-emerald-300/15 bg-emerald-950/25 px-2.5 py-2">
            <div className="text-[9px] font-bold text-emerald-300">角色账号档案</div>
            {accounts.map(ref => <div key={ref} className="mt-1 break-all font-mono text-[9px] text-emerald-100/75">{ref}</div>)}
            <div className="mt-1 text-[9px] text-emerald-100/50">账号资料完整保存在档案中，可查看、复制和编辑</div>
          </div>
        )}
      </div>
      <div className="flex items-center justify-between border-t border-white/10 px-3 py-1.5 text-[9px] text-violet-300/60">
        <span>已进入主对话上下文</span><span className="font-bold text-amber-200/70">＋记忆</span>
      </div>
    </div>
  );
};

export default GameHallHandoffCard;
