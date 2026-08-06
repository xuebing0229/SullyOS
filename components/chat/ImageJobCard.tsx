import React, { useRef } from 'react';
import { Check, CheckCircle, ImageSquare, SpinnerGap, WarningCircle } from '@phosphor-icons/react';
import type { LocalImageJobCard } from '../../utils/imageJobCards';

interface ImageJobCardProps {
    card: LocalImageJobCard;
    selectable?: boolean;
    selectionMode?: boolean;
    selected?: boolean;
    onLongPress?: () => void;
    onToggleSelect?: () => void;
}

const statusText: Record<LocalImageJobCard['status'], string> = {
    queued: '排队中', running: '生成中', saving: '保存中', completed: '图片已保存', failed: '生图失败',
};

const ImageJobCard: React.FC<ImageJobCardProps> = ({
    card, selectable = false, selectionMode = false, selected = false, onLongPress, onToggleSelect,
}) => {
    const failed = card.status === 'failed';
    const completed = card.status === 'completed';
    const active = !failed && !completed;
    const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const activePointerId = useRef<number | null>(null);
    const startPos = useRef({ x: 0, y: 0 });
    const suppressNextClickRef = useRef(false);

    const clearLongPress = () => {
        if (!longPressTimer.current) return;
        clearTimeout(longPressTimer.current);
        longPressTimer.current = null;
    };
    const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
        if (!selectable || selectionMode || event.button !== 0) return;
        activePointerId.current = event.pointerId;
        startPos.current = { x: event.clientX, y: event.clientY };
        suppressNextClickRef.current = false;
        clearLongPress();
        longPressTimer.current = setTimeout(() => {
            longPressTimer.current = null;
            activePointerId.current = null;
            suppressNextClickRef.current = true;
            try { navigator.vibrate?.(20); } catch { /* optional */ }
            onLongPress?.();
        }, 600);
    };
    const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
        if (activePointerId.current !== event.pointerId) return;
        if (Math.abs(event.clientX - startPos.current.x) > 10 || Math.abs(event.clientY - startPos.current.y) > 10) {
            clearLongPress();
            activePointerId.current = null;
        }
    };
    const handlePointerEnd = (event: React.PointerEvent<HTMLDivElement>) => {
        if (activePointerId.current !== event.pointerId) return;
        clearLongPress();
        activePointerId.current = null;
    };
    const handleClick = (event: React.MouseEvent<HTMLDivElement>) => {
        if (suppressNextClickRef.current) {
            suppressNextClickRef.current = false;
            event.preventDefault();
            event.stopPropagation();
            return;
        }
        if (!selectionMode || !selectable) return;
        event.preventDefault();
        event.stopPropagation();
        onToggleSelect?.();
    };

    return (
        <div
            data-image-job-card={card.id}
            data-image-job-selectable={selectable ? 'true' : 'false'}
            data-image-job-selected={selected ? 'true' : 'false'}
            className="mx-4 my-2 flex justify-start"
            aria-live="polite"
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerEnd}
            onPointerCancel={handlePointerEnd}
            onContextMenu={event => {
                if (!selectable || selectionMode) return;
                event.preventDefault();
                clearLongPress();
                onLongPress?.();
            }}
            onClick={handleClick}
        >
            <div className={`relative w-full max-w-[520px] rounded-2xl border px-4 py-3 shadow-sm backdrop-blur-sm transition ${
                failed
                    ? 'border-red-300/70 bg-red-50/90 text-red-950 dark:border-red-700/70 dark:bg-red-950/55 dark:text-red-100'
                    : completed
                        ? 'border-emerald-300/70 bg-emerald-50/90 text-emerald-950 dark:border-emerald-700/70 dark:bg-emerald-950/55 dark:text-emerald-100'
                        : 'border-sky-200/80 bg-white/90 text-slate-800 dark:border-sky-800/70 dark:bg-slate-900/85 dark:text-slate-100'
            } ${selected ? 'ring-2 ring-blue-500 ring-offset-2 dark:ring-offset-slate-950' : ''}`}>
                {selectionMode && selectable ? (
                    <span className={`absolute left-2 top-2 z-10 flex h-6 w-6 items-center justify-center rounded-full border-2 ${
                        selected ? 'border-blue-500 bg-blue-500 text-white' : 'border-slate-400 bg-white/90 text-transparent dark:bg-slate-900'
                    }`}>
                        <Check size={15} weight="bold" />
                    </span>
                ) : null}
                {selected ? <div className="pointer-events-none absolute inset-0 rounded-2xl bg-blue-500/10" /> : null}
                <div className="flex items-start gap-3">
                    <div className="mt-0.5 shrink-0">
                        {active ? <SpinnerGap size={22} weight="bold" className="animate-spin text-sky-500" />
                            : failed ? <WarningCircle size={22} weight="fill" className="text-red-500" />
                                : <CheckCircle size={22} weight="fill" className="text-emerald-500" />}
                    </div>
                    <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                            <span className="font-semibold">
                                {failed ? '🎨 生图失败' : completed ? '🎨 图片已保存' : '🎨 图片生成中'}
                            </span>
                            <span className="rounded-full bg-black/5 px-2 py-0.5 text-xs dark:bg-white/10">{statusText[card.status]}</span>
                        </div>
                        <div className="mt-2 flex items-center gap-1.5 text-xs opacity-75">
                            <ImageSquare size={14} /><span>{card.engineLabel}</span>
                        </div>
                        <p className="mt-1.5 break-words text-sm leading-5">{card.promptPreview}</p>
                        {failed && card.error ? <p className="mt-2 break-words text-xs leading-5 opacity-85">原因：{card.error}</p> : null}
                    </div>
                </div>
            </div>
        </div>
    );
};

export default React.memo(ImageJobCard);
