import React, { useState } from 'react';
import ConfirmDialog from '../os/ConfirmDialog';
import { runBlobGc } from '../../utils/blobGc';

interface Props { addToast: (message: string, type?: 'success' | 'error' | 'info') => void; }

const OrphanImageCleanupCard: React.FC<Props> = ({ addToast }) => {
    const [busy, setBusy] = useState(false);
    const [confirmOpen, setConfirmOpen] = useState(false);
    const handleDelete = async () => {
        setConfirmOpen(false); setBusy(true);
        try {
            const result = await runBlobGc();
            addToast(result.deleted > 0 ? `已清理 ${result.deleted} 张孤儿图片` : '没有发现可安全清理的孤儿图片', 'success');
        } catch (error) { addToast(error instanceof Error ? error.message : '清理失败', 'error'); }
        finally { setBusy(false); }
    };

    return <>
        <div className="mb-4 rounded-xl border border-sky-100 bg-sky-50/70 p-3.5">
            <div className="mb-1 flex items-center justify-between gap-3">
                <span className="text-xs font-bold text-slate-600">本机图片空间清理</span>
                <button disabled={busy} onClick={() => setConfirmOpen(true)} className="rounded-lg bg-white px-3 py-1.5 text-[11px] font-bold text-sky-600 shadow-sm disabled:opacity-50">
                    {busy ? '处理中…' : '清理孤儿图片'}
                </button>
            </div>
            <p className="text-[10px] leading-relaxed text-slate-400">只清理已不被聊天、相册、壁纸、主题或其他本机数据引用的 Blob。最近 10 分钟新建的图片会自动保护。</p>
        </div>
        <ConfirmDialog isOpen={confirmOpen} title="清理孤儿图片？" message="系统会扫描聊天、相册、壁纸、主题和其他本机数据，只删除无人引用且已过新图保护期的图片。" confirmText="确认清理" variant="danger" onConfirm={handleDelete} onCancel={() => setConfirmOpen(false)} />
    </>;
};
export default OrphanImageCleanupCard;
