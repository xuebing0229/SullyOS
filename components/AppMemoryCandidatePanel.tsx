import React, { useMemo, useState } from 'react';
import type {
  AppMemoryCandidate,
  CharacterProfile,
  UserProfile,
} from '../types';
import {
  commitAppMemoryCandidate,
  dismissAppMemoryCandidate,
  mergeAppMemoryCandidates,
  updateAppMemoryCandidate,
} from '../utils/appMemoryBridge';

interface Props {
  candidates: AppMemoryCandidate[];
  char: CharacterProfile;
  characters?: CharacterProfile[];
  userProfile: UserProfile;
  memoryPalaceConfig: any;
  remoteVectorConfig?: any;
  updateCharacter: any;
  onChange: (items: AppMemoryCandidate[]) => void;
  onClose: () => void;
  addToast: (message: string, type?: any) => void;
}

const roomLabel: Record<string, string> = {
  living_room: '客厅',
  bedroom: '卧室',
  study: '书房',
  user_room: '用户房间',
  self_room: '自我房间',
  attic: '阁楼',
  windowsill: '窗台',
};

const AppMemoryCandidatePanel: React.FC<Props> = ({
  candidates,
  char,
  characters,
  userProfile,
  memoryPalaceConfig,
  remoteVectorConfig,
  updateCharacter,
  onChange,
  onClose,
  addToast,
}) => {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const pending = useMemo(
    () => candidates.filter((v) => v.status === 'pending'),
    [candidates],
  );

  const replace = (next: AppMemoryCandidate) => {
    onChange(candidates.map((v) => (v.id === next.id ? next : v)));
  };

  const patch = async (
    card: AppMemoryCandidate,
    updates: Partial<AppMemoryCandidate>,
  ) => replace(await updateAppMemoryCandidate(card, updates));

  const commitSelected = async () => {
    const rows = pending.filter((v) => selected.has(v.id));
    if (rows.length === 0) {
      addToast('请先勾选要写入主记忆的卡片');
      return;
    }
    setBusy(true);
    try {
      const committed: AppMemoryCandidate[] = [];
      for (const candidate of rows) {
        const targetChar =
          candidate.charId === char.id
            ? char
            : characters?.find((item) => item.id === candidate.charId);
        if (!targetChar) {
          throw new Error(`找不到记忆卡对应的角色（${candidate.charId}）`);
        }
        committed.push(
          await commitAppMemoryCandidate({
            candidate,
            char: targetChar,
            userProfile,
            memoryPalaceConfig,
            remoteVectorConfig,
            updateCharacter,
          }),
        );
      }
      const map = new Map(committed.map((v) => [v.id, v]));
      onChange(candidates.map((v) => map.get(v.id) || v));
      setSelected(new Set());
      addToast(`已写入 ${committed.length} 张主记忆卡`, 'success');
    } catch (error: any) {
      addToast(error?.message || '写入主记忆失败', 'error');
    } finally {
      setBusy(false);
    }
  };

  const mergeSelected = async () => {
    const rows = pending.filter((v) => selected.has(v.id));
    if (rows.length < 2) {
      addToast('至少勾选两张卡片');
      return;
    }
    if (new Set(rows.map((item) => item.charId)).size > 1) {
      addToast('不同角色的记忆卡不能合并', 'info');
      return;
    }
    setBusy(true);
    try {
      const merged = await mergeAppMemoryCandidates(rows);
      const oldIds = new Set(rows.map((v) => v.id));
      onChange([
        ...candidates.map((v) =>
          oldIds.has(v.id) ? { ...v, status: 'dismissed' as const } : v,
        ),
        merged,
      ]);
      setSelected(new Set([merged.id]));
      addToast('已合并，可继续编辑后写入');
    } catch (error: any) {
      addToast(error?.message || '合并失败', 'error');
    } finally {
      setBusy(false);
    }
  };

  const dismiss = async (card: AppMemoryCandidate) => {
    replace(await dismissAppMemoryCandidate(card));
    setSelected((prev) => {
      const next = new Set(prev);
      next.delete(card.id);
      return next;
    });
  };

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 80,
        background: 'rgba(15,23,42,.58)',
        backdropFilter: 'blur(10px)',
        display: 'flex',
        alignItems: 'flex-end',
      }}
    >
      <div
        style={{
          width: '100%',
          maxHeight: '88%',
          overflow: 'auto',
          background: '#fffdf8',
          borderRadius: '22px 22px 0 0',
          padding: '18px 16px calc(18px + var(--safe-bottom))',
          boxShadow: '0 -18px 50px rgba(15,23,42,.2)',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <div>
            <div style={{ fontSize: 18, fontWeight: 800 }}>整理记忆卡片</div>
            <div style={{ fontSize: 12, color: '#78716c', marginTop: 4 }}>
              只有你确认的卡片才进入主聊天和主记忆
            </div>
          </div>
          <button onClick={onClose} disabled={busy}>关闭</button>
        </div>

        {pending.length === 0 ? (
          <div style={{ padding: '42px 0', textAlign: 'center', color: '#78716c' }}>
            没有待处理卡片
          </div>
        ) : (
          <div style={{ display: 'grid', gap: 12, marginTop: 16 }}>
            {pending.map((card) => {
              const targetName =
                card.charId === char.id
                  ? char.name
                  : characters?.find((item) => item.id === card.charId)?.name;
              return (
              <div
                key={card.id}
                style={{
                  border: selected.has(card.id)
                    ? '2px solid #7c3aed'
                    : '1px solid #e7e5e4',
                  borderRadius: 16,
                  padding: 12,
                  background: '#fff',
                }}
              >
                <label style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                  <input
                    type="checkbox"
                    checked={selected.has(card.id)}
                    onChange={(e) => {
                      setSelected((prev) => {
                        const next = new Set(prev);
                        e.target.checked ? next.add(card.id) : next.delete(card.id);
                        return next;
                      });
                    }}
                  />
                  <input
                    value={card.title}
                    onChange={(e) =>
                      onChange(
                        candidates.map((v) =>
                          v.id === card.id ? { ...v, title: e.target.value } : v,
                        ),
                      )
                    }
                    onBlur={(e) => patch(card, { title: e.target.value.trim() })}
                    style={{
                      flex: 1,
                      fontSize: 15,
                      fontWeight: 700,
                      border: 0,
                      borderBottom: '1px solid #e7e5e4',
                      padding: '4px 0',
                    }}
                  />
                </label>
                {characters && characters.length > 1 && targetName && (
                  <div style={{ marginTop: 7, fontSize: 11, color: '#6d28d9', fontWeight: 700 }}>
                    写给 {targetName}
                  </div>
                )}
                <textarea
                  value={card.summary}
                  onChange={(e) =>
                    onChange(
                      candidates.map((v) =>
                        v.id === card.id ? { ...v, summary: e.target.value } : v,
                      ),
                    )
                  }
                  onBlur={(e) => patch(card, { summary: e.target.value.trim() })}
                  style={{
                    width: '100%',
                    minHeight: 96,
                    marginTop: 10,
                    padding: 10,
                    resize: 'vertical',
                    border: '1px solid #e7e5e4',
                    borderRadius: 10,
                    lineHeight: 1.65,
                  }}
                />
                <div
                  style={{
                    display: 'flex',
                    gap: 8,
                    alignItems: 'center',
                    flexWrap: 'wrap',
                    marginTop: 8,
                    fontSize: 12,
                    color: '#78716c',
                  }}
                >
                  <span>{roomLabel[card.room] || card.room}</span>
                  <span>重要度 {card.importance}/10</span>
                  {card.tags.map((tag) => (
                    <span
                      key={tag}
                      style={{
                        padding: '2px 7px',
                        borderRadius: 999,
                        background: '#f5f3ff',
                        color: '#6d28d9',
                      }}
                    >
                      {tag}
                    </span>
                  ))}
                  <button
                    onClick={() => dismiss(card)}
                    disabled={busy}
                    style={{ marginLeft: 'auto', color: '#b91c1c' }}
                  >
                    不保存
                  </button>
                </div>
              </div>
              );
            })}
          </div>
        )}

        {pending.length > 0 && (
          <div
            style={{
              position: 'sticky',
              bottom: 0,
              display: 'flex',
              gap: 10,
              paddingTop: 16,
              background: 'linear-gradient(transparent,#fffdf8 28%)',
            }}
          >
            <button
              disabled={busy}
              onClick={mergeSelected}
              style={{ flex: 1, padding: 12, borderRadius: 12 }}
            >
              合并所选
            </button>
            <button
              disabled={busy}
              onClick={commitSelected}
              style={{
                flex: 1.4,
                padding: 12,
                borderRadius: 12,
                background: '#6d28d9',
                color: 'white',
                fontWeight: 700,
              }}
            >
              {busy ? '处理中…' : '写入主记忆'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

export default AppMemoryCandidatePanel;
