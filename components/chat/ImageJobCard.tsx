import React from 'react';
import {
    CheckCircle,
    ImageSquare,
    SpinnerGap,
    WarningCircle,
} from '@phosphor-icons/react';
import type { LocalImageJobCard } from '../../utils/imageJobCards';

interface ImageJobCardProps {
    card: LocalImageJobCard;
}

const statusText: Record<LocalImageJobCard['status'], string> = {
    queued: '排队中',
    running: '生成中',
    saving: '保存中',
    completed: '图片已保存',
    failed: '生图失败',
};

const ImageJobCard: React.FC<ImageJobCardProps> = ({ card }) => {
    const failed = card.status === 'failed';
    const completed = card.status === 'completed';
    const active = !failed && !completed;

    return (
        <div
            data-image-job-card={card.id}
            className="mx-4 my-2 flex justify-start"
            aria-live="polite"
        >
            <div className={`w-full max-w-[520px] rounded-2xl border px-4 py-3 shadow-sm backdrop-blur-sm ${
                failed
                    ? 'border-red-300/70 bg-red-50/90 text-red-950 dark:border-red-700/70 dark:bg-red-950/55 dark:text-red-100'
                    : completed
                        ? 'border-emerald-300/70 bg-emerald-50/90 text-emerald-950 dark:border-emerald-700/70 dark:bg-emerald-950/55 dark:text-emerald-100'
                        : 'border-sky-200/80 bg-white/90 text-slate-800 dark:border-sky-800/70 dark:bg-slate-900/85 dark:text-slate-100'
            }`}>
                <div className="flex items-start gap-3">
                    <div className="mt-0.5 shrink-0">
                        {active ? (
                            <SpinnerGap size={22} weight="bold" className="animate-spin text-sky-500" />
                        ) : failed ? (
                            <WarningCircle size={22} weight="fill" className="text-red-500" />
                        ) : (
                            <CheckCircle size={22} weight="fill" className="text-emerald-500" />
                        )}
                    </div>
                    <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                            <span className="font-semibold">
                                {failed ? '🎨 生图失败' : completed ? '🎨 图片已保存' : '🎨 图片生成中'}
                            </span>
                            <span className="rounded-full bg-black/5 px-2 py-0.5 text-xs dark:bg-white/10">
                                {statusText[card.status]}
                            </span>
                        </div>
                        <div className="mt-2 flex items-center gap-1.5 text-xs opacity-75">
                            <ImageSquare size={14} />
                            <span>{card.engineLabel}</span>
                        </div>
                        <p className="mt-1.5 break-words text-sm leading-5">
                            {card.promptPreview}
                        </p>
                        {failed && card.error ? (
                            <p className="mt-2 break-words text-xs leading-5 opacity-85">
                                原因：{card.error}
                            </p>
                        ) : null}
                    </div>
                </div>
            </div>
        </div>
    );
};

export default React.memo(ImageJobCard);