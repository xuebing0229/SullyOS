import React, { useState } from 'react';
import ConfirmDialog from '../os/ConfirmDialog';
import { deleteOrphanBlobAssets, scanOrphanBlobAssets, type BlobGcScanResult } from '../../utils/blobGc';
import { formatBytes } from '../../utils/format';

interface Props { addToast: (message: string, type?: 'success' | 'error' | 'info' | 'warning') => void; }

const OrphanImageCleanupCard: React.FC<Props> = ({ addToast }) => {
    const [scan, setScan] = useState<BlobGcScanResult | null>(null);
    const [busy, setBusy] = useState(false);
    const [confirmOpen, setConfirmOpen] = useState(false);

    const handleScan = async () => {
        setBusy(true);
        try {
            const result = await scanOrphanBlobAssets();
            setScan(result);
            if (!result.candidates.length) addToast('没有发现可安全清理的孤儿图片', 'success');
        } catch (error) { addToast(error instanceof Error ? error.message : '扫描失败', 'error'); }
        finally { setBusy(false); }
    };
    const handleDelete = async () => {
        if (!scan) return;
        setConfirmOpen(false); setBusy(true);
        try {
            const result = await deleteOrphanBlobAssets(scan.candidates.map(item => item.id));
            addToast(`已清理 ${result.deletedCount} 张孤儿图片，释放 ${formatBytes(result.deletedBytes) || '0 B'}`, 'success');
            setScan(await scanOrphanBlobAssets());
        } catch (error) { addToast(error instanceof Error ? error.message : '清理失败', 'error'); }
        finally { setBusy(false); }
    };

    return <>
        <div className="mb-4 rounded-xl border border-sky-100 bg-sky-50/70 p-3.5">
            <div className="mb-1 flex items-center justify-between gap-3">
                <span className="text-xs font-bold text-slate-600">本机图片空间清理</span>
                <button disabled={busy} onClick={handleScan} className="rounded-lg bg-white px-3 py-1.5 text-[11px] font-bold text-sky-600 shadow-sm disabled:opacity-50">
                    {busy ? '处理中…' : scan ? '重新扫描' : '扫描孤儿图片'}
                </button>
            </div>
            <p className="text-[10px] leading-relaxed text-slate-400">只清理已不被聊天、相册、壁纸、主题或其他本机数据引用的 Blob。最近 10 分钟新建的图片会自动保护。</p>
            {scan && <div className="mt-3 rounded-lg bg-white/80 p-2.5 text-[10px] leading-5 text-slate-500">
                <div>图片 Blob：{scan.totalBlobCount} 个 · 已引用：{scan.referencedBlobCount} 个</div>
                <div>新图保护：{scan.protectedBlobCount} 个 · 可清理：{scan.candidates.length} 个（{formatBytes(scan.reclaimableBytes) || '0 B'}）</div>
                {scan.candidates.length > 0 && <button disabled={busy} onClick={() => setConfirmOpen(true)} className="mt-2 w-full rounded-lg bg-rose-500 py-2 text-[11px] font-bold text-white disabled:opacity-50">清理可回收图片</button>}
            </div>}
        </div>
        <ConfirmDialog isOpen={confirmOpen} title="清理孤儿图片？" message={`将删除 ${scan?.candidates.length || 0} 个未被引用的本机图片 Blob，预计释放 ${formatBytes(scan?.reclaimableBytes || 0) || '0 B'}。删除前会再次扫描引用，已重新被使用的图片不会删除。`} confirmText="确认清理" variant="danger" onConfirm={handleDelete} onCancel={() => setConfirmOpen(false)} />
    </>;
};
export default OrphanImageCleanupCard;
