import React, { useMemo, useState } from 'react';
import { Archive, ArrowLeft, MagnifyingGlass, X } from '@phosphor-icons/react';
import type { Message } from '../../../types';

interface Props {
    title: string;
    messages: Message[];
    archivedIds: Set<number>;
    onClose: () => void;
    onJump: (message: Message) => void;
}

const storyHistoryPlainText = (value: string): string => String(value || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const storyHistorySnippet = (value: string, query: string): string => {
    const text = storyHistoryPlainText(value) || '[空内容]';
    const needle = query.trim();
    if (!needle) return text;

    const matchIndex = text.toLocaleLowerCase().indexOf(needle.toLocaleLowerCase());
    if (matchIndex < 0) return text;

    const start = Math.max(0, matchIndex - 24);
    const end = Math.min(text.length, Math.max(matchIndex + needle.length + 56, start + 96));
    return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
};

const HighlightedSnippet: React.FC<{ text: string; query: string }> = ({ text, query }) => {
    const needle = query.trim();
    if (!needle) return <>{text}</>;

    const lowerText = text.toLocaleLowerCase();
    const lowerNeedle = needle.toLocaleLowerCase();
    const nodes: React.ReactNode[] = [];
    let cursor = 0;
    let index = lowerText.indexOf(lowerNeedle, cursor);

    while (index >= 0) {
        if (index > cursor) nodes.push(text.slice(cursor, index));
        nodes.push(<mark key={`${index}-${nodes.length}`} className='rounded bg-amber-200/80 px-0.5 text-slate-900'>{text.slice(index, index + needle.length)}</mark>);
        cursor = index + needle.length;
        index = lowerText.indexOf(lowerNeedle, cursor);
    }
    if (cursor < text.length) nodes.push(text.slice(cursor));
    return <>{nodes}</>;
};

const StoryHistoryPreview: React.FC<Props> = ({ title, messages, archivedIds, onClose, onJump }) => {
    const [query, setQuery] = useState('');
    const results = useMemo(() => {
        const needle = query.trim().toLocaleLowerCase();
        return messages
            .map((message, index) => ({ message, index, text: storyHistoryPlainText(message.content) }))
            .filter(item => !needle || item.text.toLocaleLowerCase().includes(needle));
    }, [messages, query]);

    return <div className='fixed inset-0 z-[90] flex flex-col bg-stone-100 text-slate-800'>
        <header className='story-safe-header shrink-0 border-b border-slate-200 bg-stone-100/95 backdrop-blur'>
            <div className='h-14 px-3 flex items-center gap-2'>
                <button type='button' onClick={onClose} className='w-9 h-9 shrink-0 rounded-full grid place-items-center' aria-label='返回剧情正文'><ArrowLeft size={20} /></button>
                <div className='min-w-0 flex-1'>
                    <div className='truncate font-serif text-[15px] font-semibold text-slate-800'>历史剧情</div>
                    <div className='mt-0.5 truncate text-[9px] text-slate-400'>{title} · {messages.length} 条内容</div>
                </div>
            </div>
        </header>

        <div className='shrink-0 px-4 py-3 border-b border-slate-200 bg-stone-100'>
            <label className='h-11 flex items-center gap-2 rounded-full border border-slate-300 bg-white px-4 shadow-sm'>
                <MagnifyingGlass size={18} className='shrink-0 text-slate-400' />
                <input
                    value={query}
                    onChange={event => setQuery(event.target.value)}
                    className='min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-slate-400'
                    placeholder='搜索历史剧情'
                    aria-label='搜索历史剧情'
                />
                {query && <button type='button' onClick={() => setQuery('')} className='w-7 h-7 shrink-0 rounded-full grid place-items-center text-slate-400' aria-label='清空搜索'><X size={14} /></button>}
            </label>
            <div className='mt-2 px-1 text-[9px] text-slate-400'>点击任意缩略内容，直接回到正文对应楼层</div>
        </div>

        <div className='story-page-scroll flex-1 overflow-y-auto px-4 py-4'>
            <div className='mx-auto w-full max-w-2xl space-y-2'>
                {results.length === 0 ? <div className='py-16 text-center text-xs text-slate-400'>没有找到匹配内容</div> : results.map(({ message, index, text }) => {
                    const isUser = message.role === 'user';
                    const archived = archivedIds.has(message.id);
                    const snippet = storyHistorySnippet(text, query);
                    return <button
                        key={message.id}
                        type='button'
                        onClick={() => onJump(message)}
                        className={`block max-w-[94%] rounded-2xl border px-3 py-2.5 text-left shadow-sm active:scale-[.99] transition-transform ${isUser ? 'ml-auto border-violet-200 bg-violet-100/80' : 'mr-auto border-slate-200 bg-white'}`}
                    >
                        <div className='mb-1 flex items-center gap-2 text-[8px] font-bold text-slate-400'>
                            <span>第 {index + 1} 楼 · {isUser ? '你的推进' : '剧场正文'}</span>
                            {archived && <span className='inline-flex items-center gap-1 text-violet-500'><Archive size={10} />已归档</span>}
                        </div>
                        <div className='truncate text-[12px] leading-5 text-slate-700'>
                            <HighlightedSnippet text={snippet} query={query} />
                        </div>
                    </button>;
                })}
            </div>
        </div>
    </div>;
};

export default StoryHistoryPreview;
