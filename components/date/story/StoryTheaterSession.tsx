import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Archive, ArrowBendDownRight, ArrowClockwise, ArrowLeft, ArrowUp, Broadcast, CaretDown, ChatCircleDots, Clock, Database, DownloadSimple, Eye, EyeSlash, FilmSlate, GearSix, GitBranch, HeartStraight, Key, MapPin, PencilSimple, SlidersHorizontal, Sparkle, SpinnerGap, Trash, X } from '@phosphor-icons/react';
import { useOS } from '../../../context/OSContext';
import TokenImg from '../../os/TokenImg';
import type { AppMemoryCandidate, CharacterProfile, Message, StoryTheaterEntry, StoryTheaterImageFrame, StoryTheaterMask, StoryTheaterPreset } from '../../../types';
import { DB } from '../../../utils/db';
import { ContextBuilder } from '../../../utils/context';
import { extractContent } from '../../../utils/safeApi';
import { executeOpenAiChatPlan, resolveApiExecutionPlan } from '../../../utils/apiFailover';
import {
    appendStoryAffinityInputs,
    appendStoryUserTurn,
    buildBareTheaterActorContext,
    buildStoryAffinityAwarenessReminder,
    buildStoryBackstageAftermathReminder,
    buildStoryActorMemoryEnvelope,
    buildStoryArchiveMemoryEnvelope,
    buildStoryMultiAffinityGuide,
    buildStoryHistory,
    buildStoryIdentityGuard,
    buildStoryMiniTheaterReminder,
    buildStoryTextToneFormatReminder,
    buildStoryWorldbookScanMessages,
    buildTheaterPersona,
    buildTheaterWorldbookSlots,
    compileStoryPreset,
    prepareStoryGenerationSettings,
    dedupeTheaterWorldbooks,
    describeEmptyStoryCompletion,
    estimateStoryTokens,
    formatActorRecentMessages,
    formatStoryTheaterExport,
    getActiveStoryMiniTheaterPrompt,
    getPendingStoryRetryInput,
    isStoryUserLastCompatibilityError,
    makeStoryTheaterId,
    makeStoryTheaterFileName,
    memoryTimestampForCharacter,
    parseStoryDisplayBlocks,
    STORY_DISPLAY_FIELD_LABELS,
    REAL_COMPANION_MEMORY_GUARD,
    RELATIONSHIP_TEXTURE_GUIDE,
    resolveStoryTheaterMask,
    resolveStoryPresetDocument,
    selectStoryArchiveBatch,
    storyTheaterMemoryRecipientIds,
    storyTheaterThreadId,
    type StoryAffinityInput,
    type StoryGenerationSettings,
} from '../../../utils/storyTheater';
import {
    getMemoryPalaceHighWaterMark,
    processMessageRange,
    retrieveMemories,
} from '../../../utils/memoryPalace/pipeline';
import { processNewMessagesWithAutoArchive } from '../../../utils/memoryPalace/autoArchive';
import { incrementDigestRound, runCognitiveDigestion } from '../../../utils/memoryPalace';
import StoryQuickPresetPanel from './StoryQuickPresetPanel';
import { StoryAppearanceButton, useStoryTheaterAppearance } from './StoryTheaterTheme';
import { shareOrDownloadFile } from '../../../utils/shareExport';
import { generateStoryTheaterImage, resolveStoryImagePlannerApiConfig } from '../../../utils/storyTheaterImage';
import StoryImageSettingsButton from './StoryImageSettings';
import AppMemoryCandidatePanel from '../../AppMemoryCandidatePanel';
import { generateAppMemoryCandidates } from '../../../utils/appMemoryBridge';
import {
    acquireNativeStoryKeepAlive,
    clearPendingNativeStoryJob,
    isNativeStoryBackgroundRuntime,
    releaseNativeStoryKeepAlive,
} from '../../../utils/nativeStoryBackground';
import { BACKGROUND_IMAGE_JOB_EVENT } from '../../../utils/backgroundImageJobs';
import {
    buildStoryContinueInstruction,
    MEETING_CONTINUE_DISPLAY_TEXT,
} from '../../../utils/meetingContinue';


interface Props {
    entry: StoryTheaterEntry;
    preset: StoryTheaterPreset;
    masks: StoryTheaterMask[];
    onBack: () => void;
    onEdit: () => void;
    onOpenVectorMemory?: () => void;
    onEntryChange: (entry: StoryTheaterEntry) => Promise<void> | void;
    onCreateBranch: (message: Message, title?: string) => Promise<void> | void;
}

const textFromHistory = (messages: Message[], identityName: string): string => buildStoryHistory(messages).map(message => {
    const label = message.role === 'user' ? `${identityName}给出的推进（用户侧）` : '上一层剧场正文';
    return `[${label}]\n${message.content}`;
}).join('\n\n');

const StoryRoundImage: React.FC<{ message: Message; busy: boolean; onRegenerate: () => void }> = ({ message, busy, onRegenerate }) => {
    const frame = message.metadata?.theaterImage as StoryTheaterImageFrame | undefined;
    if (!frame?.imageRef) return null;
    return <figure className='mt-5 overflow-hidden rounded-2xl border border-slate-200 bg-slate-100 shadow-sm'>
        <TokenImg value={frame.imageRef} alt='本轮剧情配图' className='block h-auto w-full object-cover' />
        <figcaption className='flex items-center gap-3 border-t border-slate-200 bg-white px-3 py-2.5'><span className='min-w-0 flex-1'><strong className='block text-[10px] text-slate-700'>本轮剧情配图</strong><span className='mt-0.5 block truncate text-[9px] text-slate-400'>{frame.engine || '内置生图引擎'}</span></span><button type='button' disabled={busy} onClick={onRegenerate} className='inline-flex shrink-0 items-center gap-1.5 rounded-full border border-slate-200 px-3 py-1.5 text-[9px] font-bold text-slate-500 disabled:opacity-40'>{busy ? <SpinnerGap size={12} className='animate-spin' /> : <ArrowClockwise size={12} />}重新生成</button></figcaption>
    </figure>;
};

const normalizeAffinityInput = (value: any, actor?: CharacterProfile): StoryAffinityInput | undefined => {
    if (!value || typeof value !== 'object') return undefined;
    const delta = Math.max(-100, Math.min(100, Math.round(Number(value.delta) || 0)));
    const reason = String(value.reason || '').trim().slice(0, 200);
    const awareness = value.awareness === 'noticed' ? 'noticed' : 'unnoticed';
    return delta !== 0 || reason ? {
        characterId: String(value.characterId || actor?.id || ''),
        characterName: String(value.characterName || actor?.name || '当前角色'),
        delta,
        reason,
        awareness,
    } : undefined;
};

const affinityInputsFromMessage = (message: Message | undefined, actors: CharacterProfile[]): StoryAffinityInput[] => {
    const values = message?.metadata?.theaterAffinityInputs;
    if (Array.isArray(values)) return values
        .map(value => normalizeAffinityInput(value, actors.find(actor => actor.id === value?.characterId)))
        .filter((value): value is StoryAffinityInput => Boolean(value));
    const legacy = normalizeAffinityInput(message?.metadata?.theaterAffinityInput, actors[0]);
    return legacy ? [legacy] : [];
};

interface AffinityDraft { delta: number; reason: string; awareness: 'noticed' | 'unnoticed'; }
const EMPTY_AFFINITY_DRAFT: AffinityDraft = { delta: 0, reason: '', awareness: 'unnoticed' };

const mirrorArchived = (message: Message, entry: StoryTheaterEntry): boolean => {
    if (!entry.writesToCharacterMemory) return message.metadata?.theaterArchived === true;
    const mirrorIds = message.metadata?.theaterMirrorIds as Record<string, number> | undefined;
    const recipientIds = Object.keys(mirrorIds || {});
    if (!mirrorIds || recipientIds.length === 0) return false;
    return recipientIds.every(charId => {
        const mirrorId = Number(mirrorIds[charId] || 0);
        return mirrorId > 0 && mirrorId <= getMemoryPalaceHighWaterMark(charId);
    });
};

interface DisplayLine { label?: string; value: string; }

const splitDisplayLines = (text: string): DisplayLine[] => {
    const rows = text.split(/\n+/).map(row => row.trim()).filter(Boolean);
    const result: DisplayLine[] = [];

    for (const row of rows) {
        const match = row.match(/^([^：:]{1,20})[：:]\s*(.*)$/);
        const label = match?.[1]?.trim() || '';
        if (match && STORY_DISPLAY_FIELD_LABELS.has(label)) {
            result.push({ label, value: match[2].trim() });
            continue;
        }

        // 只有协议里真实存在的字段名才允许开新栏。
        // 普通心声正文即使自己写出“我知道：……”之类冒号句，也继续并回上一栏；
        // red / fracture / surge 则在解析层作为 <voice> 内联强调，不再单独拆栏。
        const previous = result[result.length - 1];
        if (previous) {
            previous.value = previous.value ? `${previous.value}\n${row}` : row;
        } else {
            result.push({ value: row });
        }
    }

    return result;
};

const LabeledRows: React.FC<{ lines: DisplayLine[] }> = ({ lines }) => <div className='divide-y divide-current/10'>
    {lines.map((line, index) => <div key={index} className='py-2.5 grid grid-cols-[76px_1fr] gap-3 items-start'>
        <span className='text-[9px] tracking-wide font-bold text-slate-400'>{line.label || '记录'}</span>
        <span className='text-[12px] leading-6 whitespace-pre-wrap text-slate-700'>{line.value || '—'}</span>
    </div>)}
</div>;

const AFFINITY_DIMENSIONS = ['信任', '安全感', '占有拉力', '情绪压强', '修复意愿'] as const;

const affinityNumber = (lines: DisplayLine[], labels: string[]): number | undefined => {
    const raw = lines.find(line => line.label && labels.includes(line.label))?.value;
    const value = Number(String(raw || '').match(/-?\d+/)?.[0]);
    return Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : undefined;
};

const StoryAffinityGroup: React.FC<{ group: DisplayGroup }> = ({ group }) => {
    const cToU = affinityNumber(group.lines, ['角色对你的温度', '关系温度']);
    const uToC = affinityNumber(group.lines, ['你对角色的温度', '你的关系温度']);
    const dimensions = AFFINITY_DIMENSIONS.map(label => ({ label, value: affinityNumber(group.lines, [label]) })).filter(item => item.value !== undefined);
    const compactLabels = new Set<string>(['角色对你的温度', '关系温度', '你对角色的温度', '你的关系温度', ...AFFINITY_DIMENSIONS]);
    const notes = group.lines.filter(line => !compactLabels.has(line.label || ''));
    return <section className='py-4 first:pt-0'>
        <div className='text-[11px] font-bold text-rose-700'>{group.title || '主要角色'}</div>
        {(cToU !== undefined || uToC !== undefined) && <div className='mt-2 grid grid-cols-2 gap-2'>
            <div className='rounded-xl bg-rose-50 px-3 py-2'><div className='text-[8px] font-bold text-rose-400'>{group.title || '角色'} → 你</div><div className='mt-0.5 text-lg font-serif font-semibold text-rose-700'>{cToU ?? '—'}<span className='ml-1 text-[8px] font-sans text-rose-300'>/ 100</span></div></div>
            <div className='rounded-xl bg-violet-50 px-3 py-2'><div className='text-[8px] font-bold text-violet-400'>你 → {group.title || '角色'}</div><div className='mt-0.5 text-lg font-serif font-semibold text-violet-700'>{uToC ?? '—'}<span className='ml-1 text-[8px] font-sans text-violet-300'>/ 100</span></div></div>
        </div>}
        {dimensions.length > 0 && <div className='mt-3 grid gap-2'>{dimensions.map(item => <div key={item.label} className='grid grid-cols-[56px_1fr_24px] items-center gap-2'><span className='text-[8px] font-bold text-slate-400'>{item.label}</span><span className='h-1.5 rounded-full bg-slate-200 overflow-hidden'><i className='block h-full rounded-full bg-gradient-to-r from-violet-300 to-rose-400' style={{ width: `${item.value}%` }} /></span><span className='text-[8px] text-right tabular-nums text-slate-400'>{item.value}</span></div>)}</div>}
        {notes.length > 0 && <div className='mt-3'><LabeledRows lines={notes} /></div>}
    </section>;
};

interface DisplayGroup { title: string; lines: DisplayLine[]; }

const groupDisplayLines = (lines: DisplayLine[], anchorLabel: string, ignoredLabels: string[] = [], ignoredValues: string[] = []): DisplayGroup[] => {
    const ignoredLabelSet = new Set(ignoredLabels);
    const ignoredValueSet = new Set(ignoredValues);
    const groups: DisplayGroup[] = [];
    let current: DisplayGroup | null = null;
    for (const line of lines) {
        if (line.label === anchorLabel) {
            if (current && (current.title || current.lines.length > 0)) groups.push(current);
            current = { title: line.value, lines: [] };
            continue;
        }
        if (ignoredLabelSet.has(line.label || '') || ignoredValueSet.has(line.value)) continue;
        if (!current) current = { title: '', lines: [] };
        current.lines.push(line);
    }
    if (current && (current.title || current.lines.length > 0)) groups.push(current);
    return groups;
};

const mergeDisplayGroupsByTitle = (groups: DisplayGroup[]): DisplayGroup[] => groups.reduce<DisplayGroup[]>((result, group) => {
    const existing = group.title && result.find(item => item.title === group.title);
    if (existing) existing.lines.push(...group.lines);
    else result.push({ title: group.title, lines: [...group.lines] });
    return result;
}, []);

type StoryToneKind = 'narration' | 'dialogue' | 'psychology';

interface StoryToneSegment {
    kind: StoryToneKind;
    text: string;
}

const splitStoryToneSegments = (text: string): StoryToneSegment[] => {
    const source = String(text || '');
    const pattern = /(\*(?!\*)[^*\n]+?\*|「[^」\n]*」|『[^』\n]*』|“[^”\n]*”|‘[^’\n]*’|"[^"\n]*")/g;
    const segments: StoryToneSegment[] = [];
    let cursor = 0;
    let match: RegExpExecArray | null;

    while ((match = pattern.exec(source)) !== null) {
        if (match.index > cursor) segments.push({ kind: 'narration', text: source.slice(cursor, match.index) });
        const token = match[0];
        if (token.startsWith('*') && token.endsWith('*')) {
            segments.push({ kind: 'psychology', text: token.slice(1, -1) });
        } else {
            segments.push({ kind: 'dialogue', text: token });
        }
        cursor = match.index + token.length;
    }

    if (cursor < source.length) segments.push({ kind: 'narration', text: source.slice(cursor) });
    return segments.length > 0 ? segments : [{ kind: 'narration', text: source }];
};

/**
 * 剧情正文里的“硬换行”就是模型主动换段，不能当作同一 <p> 里的普通换行。
 *
 * 之前这里只按空行拆段（再额外照顾整行心理），于是模型如果用单换行写：
 *   第一段。
 *   第二段。
 * 浏览器虽然视觉上换了行，但两行仍在同一个 <p> 中，CSS text-indent 只会缩进第一行。
 *
 * 这里统一把每个非空硬换行都转成独立视觉段落；真正的自动折行没有 \n，
 * 仍然只会缩进每段第一行，正好符合小说排版。
 */
export const splitStoryIndentedParagraphs = (text: string): string[] => (
    String(text || '')
        .trim()
        .split(/\n+/)
        .map(paragraph => paragraph.trim())
        .filter(Boolean)
);

const StorySceneRelationships: React.FC<{ inputs: StoryAffinityInput[] }> = ({ inputs }) => <div className='mt-4 pt-4 border-t border-violet-100'>
    <div className='flex items-center gap-2 text-[9px] font-bold text-slate-400'><HeartStraight size={13} weight='fill' className='text-rose-400' />本轮 U→C 关系变化</div>
    <div className='mt-2 divide-y divide-rose-100'>{inputs.map((input, index) => {
        const characterName = input.characterName || '当前角色';
        const movement = input.delta > 0 ? '更靠近了一点' : input.delta < 0 ? '退远了一点' : '有了新的变化';
        const noticed = input.awareness === 'noticed';
        return <div key={input.characterId || `${characterName}-${index}`} className='py-2.5 flex items-start gap-3'><div className='min-w-0 flex-1'><div className='text-[10px] font-bold text-slate-600'>你 → {characterName}</div><p className='mt-1 text-[11px] leading-5 text-slate-600'>你{movement}{input.reason ? `：${input.reason}` : '。'}</p></div><div className={`shrink-0 mt-0.5 inline-flex items-center gap-1 text-[8px] font-bold ${noticed ? 'text-violet-600' : 'text-slate-400'}`}>{noticed ? <Eye size={11} weight='fill' /> : <EyeSlash size={11} />}{characterName}【{noticed ? '已察觉！' : '未察觉'}】</div></div>;
    })}</div>
</div>;

const StoryOutput: React.FC<{ content: string; onChoose?: (text: string) => void; affinityInputs?: StoryAffinityInput[] }> = ({ content, onChoose, affinityInputs = [] }) => {
    const appearance = useStoryTheaterAppearance();
    const blocks = parseStoryDisplayBlocks(content);
    const relationshipSceneIndex = blocks.findIndex(block => block.kind === 'scene');
    const hasScene = relationshipSceneIndex >= 0;
    const relationship = affinityInputs.length > 0 ? <StorySceneRelationships inputs={affinityInputs} /> : null;
    const backstageIndex = blocks.findIndex(block => block.kind === 'backstage');
    const debtIndex = blocks.findIndex(block => block.kind === 'debts');
    const aftermathIndex = backstageIndex < 0 ? debtIndex : debtIndex < 0 ? backstageIndex : Math.min(backstageIndex, debtIndex);
    const backstageLines = backstageIndex >= 0 ? splitDisplayLines(blocks[backstageIndex].text) : [];
    const debtLines = debtIndex >= 0 ? splitDisplayLines(blocks[debtIndex].text) : [];
    const backstageGroups = mergeDisplayGroupsByTitle(groupDisplayLines(backstageLines, '主体', [], ['幕后暗格']));
    const debtGroups = groupDisplayLines(debtLines, '起因', ['镜头债'], ['镜头债', '镜头债 · 后果尚未到账']);
    const hasTrueMonologue = backstageLines.some(line => line.label === '心声' || line.label === '真正的独白');
    return <div className='space-y-6'>
        {!hasScene && relationship}
        {blocks.map((block, index) => {
            const lines = splitDisplayLines(block.text);
            if (block.kind === 'story') {
                const paragraphs = splitStoryIndentedParagraphs(block.text);
                return <div key={index} className='space-y-2.5'>
                    {paragraphs.map((paragraph, paragraphIndex) => (
                        <p
                            key={paragraphIndex}
                            className='font-serif text-[15px] leading-8 text-slate-800 whitespace-pre-wrap'
                            style={{ textIndent: appearance.firstLineIndent ? '2em' : undefined }}
                        >
                            {appearance.textToneEnabled
                                ? splitStoryToneSegments(paragraph).map((segment, segmentIndex) => (
                                    <span
                                        key={segmentIndex}
                                        style={{
                                            color: segment.kind === 'dialogue'
                                                ? appearance.dialogueColor
                                                : segment.kind === 'psychology'
                                                    ? appearance.psychologyColor
                                                    : appearance.narrationColor,
                                            ...(segment.kind === 'psychology' ? { fontStyle: 'italic' } : {}),
                                        }}
                                    >
                                        {segment.text}
                                    </span>
                                ))
                                : paragraph}
                        </p>
                    ))}
                </div>;
            }
            if (block.kind === 'scene') return <section key={index} className='py-4 border-y border-slate-300'>
                <div className='flex items-center gap-2 text-[9px] tracking-[.22em] uppercase font-bold text-violet-600'><FilmSlate size={14} weight='fill' />{block.title}</div>
                <div className='mt-3 grid grid-cols-2 gap-x-5 gap-y-3'>{lines.map((line, lineIndex) => <div key={lineIndex} className={line.label === '场面' ? 'col-span-2' : ''}><div className='flex items-center gap-1 text-[9px] font-bold text-slate-400'>{line.label === '时间' ? <Clock size={11} /> : line.label === '地点' ? <MapPin size={11} /> : null}{line.label || '场景'}</div><div className='mt-1 text-[12px] leading-5 text-slate-700'>{line.value}</div></div>)}</div>
                {index === relationshipSceneIndex && relationship}
            </section>;
            if (block.kind === 'backstage' || block.kind === 'debts') {
                if (index !== aftermathIndex) return null;
                const countText = [backstageGroups.length > 0 ? `${backstageGroups.length} 位人物` : '', debtGroups.length > 0 ? `${debtGroups.length} 笔余波` : ''].filter(Boolean).join(' · ');
                return <details key={index} className='group border-y border-violet-200'>
                    <summary className='list-none cursor-pointer py-3.5 flex items-center gap-3'><span className='w-8 h-8 rounded-full bg-violet-100 grid place-items-center text-violet-600'><Key size={15} weight='fill' /></span><span className='min-w-0 flex-1'><strong className='block text-xs text-slate-700'>幕后与余波</strong><span className={`block mt-0.5 text-[9px] ${hasTrueMonologue ? 'text-violet-600 font-bold' : 'text-slate-400'}`}>{countText || '本轮没有额外记录'}{hasTrueMonologue ? ' · 真话掉落' : ''}</span></span><CaretDown size={13} className='text-violet-500 transition-transform group-open:rotate-180' /></summary>
                    <div className='pb-4 pl-11'>
                        {backstageGroups.length > 0 && <section><div className='pb-2 text-[9px] tracking-[.16em] font-bold text-violet-500'>幕后暗格</div><div className='divide-y divide-violet-100'>{backstageGroups.map((group, groupIndex) => <div key={`${group.title}-${groupIndex}`} className='py-3 first:pt-1'><div className='text-[10px] font-bold text-slate-700'>{group.title || `人物 ${groupIndex + 1}`}</div><LabeledRows lines={group.lines} /></div>)}</div></section>}
                        {debtGroups.length > 0 && <section className={backstageGroups.length > 0 ? 'mt-3 pt-4 border-t border-amber-200' : ''}><div className='pb-2 text-[9px] tracking-[.16em] font-bold text-amber-600'>尚未到账</div><div className='divide-y divide-amber-100'>{debtGroups.map((group, groupIndex) => <div key={`${group.title}-${groupIndex}`} className='py-3 first:pt-1'><div className='flex items-start gap-2'><span className='mt-0.5 w-4 h-4 shrink-0 rounded-full bg-amber-100 text-amber-700 grid place-items-center text-[8px] font-bold'>{groupIndex + 1}</span><p className='text-[11px] leading-5 font-semibold text-slate-700'>{group.title || '未命名余波'}</p></div><div className='ml-6'><LabeledRows lines={group.lines} /></div></div>)}</div></section>}
                    </div>
                </details>;
            }
            if (block.kind === 'worldline') return <section key={index} className='py-4 border-y border-violet-200'>
                <div className='flex items-center gap-2 text-[10px] font-bold text-violet-700'><Broadcast size={15} weight='fill' />世界线仍在镜头外前进</div>
                <div className='mt-4 ml-1 border-l border-violet-300'>{lines.map((line, lineIndex) => <div key={lineIndex} className='relative pl-5 pb-4 last:pb-0'><span className='absolute -left-1 top-1.5 w-2 h-2 rounded-full bg-violet-500 ring-4 ring-stone-100' /><div className='text-[9px] font-bold text-violet-500'>{line.label || `节点 ${lineIndex + 1}`}</div><div className='mt-1 text-[12px] leading-6 text-slate-700'>{line.value}</div></div>)}</div>
            </section>;
            if (block.kind === 'theater') {
                const theater = block.theater;
                return <details key={index} className='group border-y border-violet-200'>
                    <summary className='list-none cursor-pointer py-4 flex items-center gap-3'><span className='w-8 h-8 rounded-full bg-violet-100 text-violet-600 grid place-items-center'><ChatCircleDots size={16} weight='fill' /></span><span className='min-w-0 flex-1'><span className='block text-[9px] tracking-[.16em] font-bold text-violet-500'>幕间频道</span><strong className='block mt-0.5 truncate text-sm font-semibold text-slate-700'>{theater?.title || block.title || '小剧场'}</strong></span><span className='shrink-0 text-[9px] text-slate-400'>{theater?.messages?.length || 0} 条</span><CaretDown size={13} className='text-violet-500 transition-transform group-open:rotate-180' /></summary>
                    <div className='pb-5'>{theater?.system && <div className='ml-11 pl-3 border-l-2 border-violet-200 text-[10px] leading-5 text-slate-500'>{theater.system}</div>}
                    <div className='mt-4 space-y-3'>{(theater?.messages || []).map((message, messageIndex) => <div key={messageIndex} className={`flex ${message.side === 'right' ? 'justify-end' : 'justify-start'}`}><div className='max-w-[86%]'><div className={`mb-1 text-[8px] font-bold text-slate-400 ${message.side === 'right' ? 'text-right' : ''}`}>{message.name}</div><div className={`px-3 py-2 rounded-2xl text-[11px] leading-5 ${message.side === 'right' ? 'bg-violet-100 text-violet-900 rounded-br-sm' : 'bg-white border border-slate-200 text-slate-700 rounded-bl-sm'}`}>{message.text}</div></div></div>)}</div></div>
                </details>;
            }
            if (block.kind === 'choices') {
                const replies = lines.filter(line => line.label === '推进' && line.value).map(line => line.value);
                const options = replies.length > 0 ? replies : lines.filter(line => line.value).map(line => line.value);
                return <section key={index} className='py-4 border-y border-slate-300'><div className='flex items-center gap-2 text-[10px] font-bold text-slate-600'><ArrowBendDownRight size={15} />下一步可以这样写</div><div className='mt-3 divide-y divide-slate-200'>{options.map((option, optionIndex) => <button key={optionIndex} onClick={() => onChoose?.(option)} className='w-full py-3 flex items-start gap-3 text-left'><span className='w-5 h-5 shrink-0 rounded-full bg-violet-100 text-violet-700 grid place-items-center text-[9px] font-bold'>{optionIndex + 1}</span><span className='text-[12px] leading-5 text-slate-700'>{option}</span></button>)}</div></section>;
            }
            if (block.kind === 'affinity') {
                const personGroups = groupDisplayLines(lines, '人物', ['角色 ID']);
                const groups = personGroups.length > 0 ? personGroups : [{ title: '主要角色', lines: lines.filter(line => line.label !== '角色 ID') }];
                const preview = groups.slice(0, 3).map(group => {
                    const cToU = affinityNumber(group.lines, ['角色对你的温度', '关系温度']);
                    const uToC = affinityNumber(group.lines, ['你对角色的温度', '你的关系温度']);
                    return `${group.title}${cToU !== undefined ? `→你 ${cToU}` : ''}${uToC !== undefined ? ` · 你→${group.title} ${uToC}` : ''}`;
                }).join(' · ');
                return <details key={index} className='group border-y border-rose-200'>
                    <summary className='list-none cursor-pointer py-3.5 flex items-center gap-3'><span className='w-8 h-8 rounded-full bg-rose-50 text-rose-500 grid place-items-center'><HeartStraight size={15} weight='fill' /></span><span className='min-w-0 flex-1'><strong className='block text-xs text-rose-700'>双向关系 · {groups.length} 位角色</strong><span className='block mt-0.5 truncate text-[9px] text-slate-400'>{preview || '展开查看逐角色温度与关系维度'}</span></span><CaretDown size={13} className='text-rose-400 transition-transform group-open:rotate-180' /></summary>
                    <div className='pb-3 pl-11 divide-y divide-rose-100'>{groups.map((group, groupIndex) => <StoryAffinityGroup key={`${group.title}-${groupIndex}`} group={group} />)}</div>
                </details>;
            }
            return <section key={index} className='pl-4 border-l-2 border-slate-300'><div className='text-[10px] font-bold text-slate-500'>{block.title || '附加信息'}</div><div className='mt-2'><LabeledRows lines={lines} /></div></section>;
        })}
    </div>;
};

const StoryTheaterSession: React.FC<Props> = ({ entry, preset, masks, onBack, onEdit, onOpenVectorMemory, onEntryChange, onCreateBranch }) => {
    const { characters, userProfile, groups, apiConfig, apiPresets, realtimeConfig, memoryPalaceConfig, remoteVectorConfig, updateCharacter, addToast, registerBackHandler } = useOS();
    const appearance = useStoryTheaterAppearance();
    const threadId = storyTheaterThreadId(entry.id);
    const actors = useMemo(() => characters.filter(char => entry.characterIds.includes(char.id)), [characters, entry.characterIds]);
    const memoryActors = useMemo(() => {
        const recipientIds = new Set(storyTheaterMemoryRecipientIds(entry));
        return characters.filter(char => recipientIds.has(char.id));
    }, [characters, entry]);
    const mask = useMemo(() => resolveStoryTheaterMask(entry.mask, userProfile, characters, masks), [characters, entry.mask, masks, userProfile]);
    const youLabel = mask.selection.type === 'user' ? '你' : `你（${mask.name}）`;
    const promptIdentityName = mask.name.trim() && mask.name.trim() !== '你' ? mask.name.trim() : '当前用户侧角色';
    const effectivePreset = useMemo<StoryTheaterPreset>(() => ({
        ...preset,
        document: resolveStoryPresetDocument(preset, entry.presetOverride),
    }), [entry.presetOverride, preset]);
    const activeMiniTheater = useMemo(() => getActiveStoryMiniTheaterPrompt(effectivePreset.document), [effectivePreset.document]);
    const affinityEnabled = useMemo(() => effectivePreset.document.prompts.some(prompt => prompt.id === 'nmj-v65-affinity-control' && prompt.enabled), [effectivePreset.document]);
    const selectedBooks = useMemo(() => dedupeTheaterWorldbooks(actors).filter(book => entry.selectedWorldbookIds.includes(book.id)), [actors, entry.selectedWorldbookIds]);
    const [messages, setMessages] = useState<Message[]>([]);
    const [input, setInput] = useState('');
    const [sending, setSending] = useState(false);
    const [streamingText, setStreamingText] = useState('');
    const [memoryStatus, setMemoryStatus] = useState('');
    const [contextTokens, setContextTokens] = useState(0);
    const [contextTokensExact, setContextTokensExact] = useState(false);
    const [showAffinityInput, setShowAffinityInput] = useState(false);
    const [affinityDrafts, setAffinityDrafts] = useState<Record<string, AffinityDraft>>({});
    const [selectedAffinityActorId, setSelectedAffinityActorId] = useState('');
    const [expandedArchivedIds, setExpandedArchivedIds] = useState<Set<number>>(() => new Set());
    const [exporting, setExporting] = useState(false);
    const [memoryCandidates, setMemoryCandidates] = useState<AppMemoryCandidate[]>([]);
    const [showMemoryCards, setShowMemoryCards] = useState(false);
    const [memoryCardBusy, setMemoryCardBusy] = useState(false);
    const [showQuickPreset, setShowQuickPreset] = useState(false);
    const [showHeaderMenu, setShowHeaderMenu] = useState(false);
    const [rerollingId, setRerollingId] = useState<number | null>(null);
    const [regeneratingImageId, setRegeneratingImageId] = useState<number | null>(null);
    const [messageMenu, setMessageMenu] = useState<Message | null>(null);
    const [editingMessage, setEditingMessage] = useState<Message | null>(null);
    const [deletingMessage, setDeletingMessage] = useState<Message | null>(null);
    const [branchingMessage, setBranchingMessage] = useState<Message | null>(null);
    const [branchTitle, setBranchTitle] = useState('');
    const [branching, setBranching] = useState(false);
    const [editDraft, setEditDraft] = useState('');
    const [mutatingMessage, setMutatingMessage] = useState(false);
    // React state does not update synchronously. A rapid double tap can enter send()
    // twice before `sending` re-renders the disabled button, creating two billable
    // completions. Keep the state for UI only and use this ref as the real mutex.
    const sendLock = useRef(false);
    const streamingTextRef = useRef('');
    const archiveLock = useRef(false);
    const scrollContainerRef = useRef<HTMLElement>(null);
    const scrollContentRef = useRef<HTMLDivElement>(null);
    const autoFollowStreamRef = useRef(true);
    // 每次重新进入一条剧情时，先把“阅读锚点”稳定在真正的最底部。
    // 首次渲染后图片/字体/折叠摘要还会继续改变正文高度，只滚一次很容易停在中段。
    const initialBottomFollowRef = useRef(true);
    const bottomRef = useRef<HTMLDivElement>(null);
    const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const longPressOrigin = useRef<{ x: number; y: number } | null>(null);
    const loadMessages = useCallback(async () => {
        const rows = await DB.getMessagesByCharId(threadId, true);
        setMessages(rows.filter(message => message.metadata?.source === 'story_theater').sort((a, b) => a.id - b.id));
    }, [threadId]);

    useEffect(() => { void loadMessages(); }, [loadMessages]);
    useEffect(() => {
        if (typeof window === 'undefined') return;
        const onBackgroundImageJob = (event: Event) => {
            const detail = (event as CustomEvent).detail || {};
            if (
                detail.charId !== threadId
                || detail.ownerType !== 'story-theater'
            ) return;
            if (detail.type === 'completed' || detail.type === 'failed') {
                void loadMessages();
            }
        };
        window.addEventListener(BACKGROUND_IMAGE_JOB_EVENT, onBackgroundImageJob as EventListener);
        return () => window.removeEventListener(BACKGROUND_IMAGE_JOB_EVENT, onBackgroundImageJob as EventListener);
    }, [loadMessages, threadId]);

    const regenerateStoryImage = useCallback(async (message: Message) => {
        if (regeneratingImageId !== null) return;
        setRegeneratingImageId(message.id);
        let imageKeepAliveLease: string | null = null;
        try {
            if (isNativeStoryBackgroundRuntime()) {
                try {
                    imageKeepAliveLease = await acquireNativeStoryKeepAlive(
                        `story-image:${entry.id}:manual:${message.id}`,
                        `${entry.title} · 配图`,
                    );
                } catch (keepAliveError) {
                    console.warn('[StoryTheater] image keepalive unavailable; continuing in foreground', keepAliveError);
                }
            }
            const rows = (await DB.getMessagesByCharId(threadId, true))
                .filter(item => item.metadata?.source === 'story_theater' && item.id <= message.id)
                .sort((a, b) => a.id - b.id);
            const imageResult = await generateStoryTheaterImage({
                apiConfig,
                plannerApiConfig: resolveStoryImagePlannerApiConfig(entry, apiConfig, apiPresets),
                entry,
                actors,
                userProfile,
                userName: promptIdentityName,
                messages: rows,
                targetMessageId: message.id,
            });
            if (imageResult.frame) {
                await DB.updateMessageMetadata(message.id, previous => ({ ...previous, theaterImage: imageResult.frame }));
                await loadMessages();
                addToast('本轮配图已重新生成', 'success');
            } else if (imageResult.queued) {
                addToast('本轮配图已交给后台生成，完成后会自动挂回这一楼', 'info');
            }
        } catch (error: any) {
            console.error('[StoryTheater] image regeneration failed', error);
            addToast(`重新生成失败：${error?.message || error}`, 'error');
        } finally {
            await releaseNativeStoryKeepAlive(imageKeepAliveLease);
            setRegeneratingImageId(null);
        }
    }, [actors, addToast, apiConfig, apiPresets, entry, loadMessages, promptIdentityName, regeneratingImageId, threadId, userProfile]);
    useEffect(() => {
        setContextTokens(0);
        setContextTokensExact(false);
        setShowAffinityInput(false);
        setAffinityDrafts({});
        setSelectedAffinityActorId('');
        setExpandedArchivedIds(new Set());
        setMessageMenu(null);
        setEditingMessage(null);
        setDeletingMessage(null);
        setBranchingMessage(null);
        setBranchTitle('');
        setBranching(false);
        setMemoryCandidates([]);
        setShowMemoryCards(false);
        setMemoryCardBusy(false);
        streamingTextRef.current = '';
        setStreamingText('');
        autoFollowStreamRef.current = true;
        initialBottomFollowRef.current = true;
    }, [entry.id]);

    useEffect(() => {
        return registerBackHandler(() => {
            // Android 返回键遵循“最上层先退”的顺序，不再直接把整个文游 App 关掉。
            if (branchingMessage) {
                if (!branching) {
                    setBranchingMessage(null);
                    setBranchTitle('');
                }
                return true;
            }
            if (editingMessage) {
                if (!mutatingMessage) {
                    setEditingMessage(null);
                    setEditDraft('');
                }
                return true;
            }
            if (deletingMessage) {
                if (!mutatingMessage) setDeletingMessage(null);
                return true;
            }
            if (messageMenu) {
                setMessageMenu(null);
                return true;
            }
            if (showMemoryCards) {
                setShowMemoryCards(false);
                return true;
            }
            if (showAffinityInput) {
                setShowAffinityInput(false);
                return true;
            }
            if (showQuickPreset) {
                setShowQuickPreset(false);
                return true;
            }
            if (showHeaderMenu) {
                setShowHeaderMenu(false);
                return true;
            }

            // 没有弹层时才离开当前剧情，回到文游剧情列表。
            onBack();
            return true;
        });
    }, [
        branching,
        branchingMessage,
        deletingMessage,
        editingMessage,
        messageMenu,
        mutatingMessage,
        onBack,
        registerBackHandler,
        showAffinityInput,
        showHeaderMenu,
        showMemoryCards,
        showQuickPreset,
    ]);
    const patchAffinityDraft = useCallback((characterId: string, patch: Partial<AffinityDraft>) => {
        setAffinityDrafts(current => ({
            ...current,
            [characterId]: { ...(current[characterId] || EMPTY_AFFINITY_DRAFT), ...patch },
        }));
    }, []);
    const cancelLongPress = useCallback(() => {
        if (longPressTimer.current) clearTimeout(longPressTimer.current);
        longPressTimer.current = null;
        longPressOrigin.current = null;
    }, []);
    useEffect(() => () => cancelLongPress(), [cancelLongPress]);
    const beginLongPress = useCallback((message: Message, event: React.PointerEvent<HTMLElement>) => {
        if ((event.target as HTMLElement).closest('button, a, input, textarea, select, summary')) return;
        cancelLongPress();
        longPressOrigin.current = { x: event.clientX, y: event.clientY };
        longPressTimer.current = setTimeout(() => {
            setMessageMenu(message);
            longPressTimer.current = null;
            longPressOrigin.current = null;
        }, 520);
    }, [cancelLongPress]);
    const moveLongPress = useCallback((event: React.PointerEvent<HTMLElement>) => {
        const origin = longPressOrigin.current;
        if (origin && Math.hypot(event.clientX - origin.x, event.clientY - origin.y) > 10) cancelLongPress();
    }, [cancelLongPress]);
    const openMessageMenu = useCallback((message: Message, event?: React.MouseEvent<HTMLElement>) => {
        event?.preventDefault();
        if (event && (event.target as HTMLElement).closest('button, a, input, textarea, select, summary')) return;
        cancelLongPress();
        setMessageMenu(message);
    }, [cancelLongPress]);
    const pressHandlersFor = (message: Message) => ({
        onPointerDown: (event: React.PointerEvent<HTMLElement>) => beginLongPress(message, event),
        onPointerMove: moveLongPress,
        onPointerUp: cancelLongPress,
        onPointerCancel: cancelLongPress,
        onPointerLeave: cancelLongPress,
        onContextMenu: (event: React.MouseEvent<HTMLElement>) => openMessageMenu(message, event),
    });

    const relatedMessageIds = useCallback((message: Message): number[] => {
        const mirrorIds = Object.values((message.metadata?.theaterMirrorIds || {}) as Record<string, number>).map(Number).filter(id => Number.isFinite(id) && id > 0);
        return [...new Set([message.id, ...mirrorIds])];
    }, []);
    const saveMessageEdit = useCallback(async () => {
        if (!editingMessage || !editDraft.trim() || mutatingMessage) return;
        setMutatingMessage(true);
        try {
            await Promise.all(relatedMessageIds(editingMessage).map(id => DB.updateMessage(id, editDraft.trim())));
            await loadMessages();
            setEditingMessage(null);
            setEditDraft('');
            addToast(entry.writesToCharacterMemory ? '这一层和角色侧镜像记忆已同步修改' : '这一层已修改', 'success');
        } catch (error: any) {
            addToast(`修改失败：${error?.message || error}`, 'error');
        } finally {
            setMutatingMessage(false);
        }
    }, [addToast, editDraft, editingMessage, entry.writesToCharacterMemory, loadMessages, mutatingMessage, relatedMessageIds]);
    const deleteStoryMessage = useCallback(async () => {
        if (!deletingMessage || mutatingMessage) return;
        setMutatingMessage(true);
        try {
            await DB.deleteMessages(relatedMessageIds(deletingMessage));
            await loadMessages();
            setDeletingMessage(null);
            addToast(entry.writesToCharacterMemory ? '这一层和角色侧镜像记忆已同步删除' : '这一层已删除', 'success');
        } catch (error: any) {
            addToast(`删除失败：${error?.message || error}`, 'error');
        } finally {
            setMutatingMessage(false);
        }
    }, [addToast, deletingMessage, entry.writesToCharacterMemory, loadMessages, mutatingMessage, relatedMessageIds]);
    const scrollStoryToBottom = useCallback((behavior: ScrollBehavior = 'auto') => {
        const container = scrollContainerRef.current;
        if (!container) return;
        container.scrollTo({ top: container.scrollHeight, behavior });
    }, []);

    const handleStoryScroll = useCallback((event: React.UIEvent<HTMLElement>) => {
        const element = event.currentTarget;
        const distanceFromBottom = element.scrollHeight - element.scrollTop - element.clientHeight;
        // 用户离开底部后，流式正文继续生成但不再夺走阅读位置；
        // 自己滑回底部附近时才恢复跟随。
        autoFollowStreamRef.current = distanceFromBottom <= 96;
    }, []);

    useEffect(() => {
        if (!autoFollowStreamRef.current) return;
        const frame = requestAnimationFrame(() => {
            scrollStoryToBottom(initialBottomFollowRef.current ? 'auto' : 'smooth');
        });
        return () => cancelAnimationFrame(frame);
    }, [messages.length, sending, scrollStoryToBottom]);

    useEffect(() => {
        if (!streamingText || !autoFollowStreamRef.current) return;
        const frame = requestAnimationFrame(() => scrollStoryToBottom('auto'));
        return () => cancelAnimationFrame(frame);
    }, [streamingText, scrollStoryToBottom]);

    useEffect(() => {
        if (!initialBottomFollowRef.current || messages.length === 0) return;
        const content = scrollContentRef.current;
        if (!content) return;

        let settleTimer: ReturnType<typeof setTimeout> | null = null;
        let maxTimer: ReturnType<typeof setTimeout> | null = null;
        let raf1 = 0;
        let raf2 = 0;

        const finishInitialFollow = () => {
            initialBottomFollowRef.current = false;
            if (settleTimer) {
                clearTimeout(settleTimer);
                settleTimer = null;
            }
        };

        const keepAtRealBottom = () => {
            // 用户自己往上翻以后 autoFollowStreamRef 会变 false；此时绝不再把人拽回底部。
            if (!initialBottomFollowRef.current || !autoFollowStreamRef.current) {
                finishInitialFollow();
                return;
            }
            scrollStoryToBottom('auto');
            if (settleTimer) clearTimeout(settleTimer);
            // 连续 500ms 高度不再变化，才认为图片/字体/正文布局已经稳定。
            settleTimer = setTimeout(finishInitialFollow, 500);
        };

        // React 首屏提交后再等两帧，避开浏览器自己的 scroll restoration / layout。
        raf1 = requestAnimationFrame(() => {
            keepAtRealBottom();
            raf2 = requestAnimationFrame(keepAtRealBottom);
        });

        // StoryRoundImage 的 blob、字体等可能晚于 messages state 到达；
        // 观察正文真实高度，变化一次就重新锚到底部，而不是只在消息数量变化时滚一次。
        const observer = typeof ResizeObserver !== 'undefined'
            ? new ResizeObserver(() => keepAtRealBottom())
            : null;
        observer?.observe(content);

        // 安全上限：最多托底 3 秒，绝不长期抢用户滚动位置。
        maxTimer = setTimeout(finishInitialFollow, 3000);

        return () => {
            cancelAnimationFrame(raf1);
            cancelAnimationFrame(raf2);
            observer?.disconnect();
            if (settleTimer) clearTimeout(settleTimer);
            if (maxTimer) clearTimeout(maxTimer);
        };
    }, [entry.id, messages.length, scrollStoryToBottom]);
    const archivedMessageIds = useMemo(
        () => messages.filter(message => mirrorArchived(message, entry)).map(message => message.id),
        [entry, messages],
    );
    const allArchivesExpanded = archivedMessageIds.length > 0 && archivedMessageIds.every(id => expandedArchivedIds.has(id));
    const toggleAllArchives = useCallback(() => {
        setExpandedArchivedIds(current => {
            const next = new Set(current);
            if (archivedMessageIds.every(id => next.has(id))) archivedMessageIds.forEach(id => next.delete(id));
            else archivedMessageIds.forEach(id => next.add(id));
            return next;
        });
    }, [archivedMessageIds]);
    const setArchiveExpanded = useCallback((messageId: number, open: boolean) => {
        setExpandedArchivedIds(current => {
            if (current.has(messageId) === open) return current;
            const next = new Set(current);
            if (open) next.add(messageId);
            else next.delete(messageId);
            return next;
        });
    }, []);
    const storedTokenInfo = useMemo(() => {
        const source = [...messages].reverse().find(message => Number(message.metadata?.theaterPromptTokens) > 0);
        return source ? {
            count: Number(source.metadata.theaterPromptTokens),
            exact: source.metadata.theaterPromptTokensExact === true,
        } : { count: 0, exact: false };
    }, [messages]);
    const displayedTokenInfo = contextTokens > 0 ? { count: contextTokens, exact: contextTokensExact } : storedTokenInfo;

    const exportStory = useCallback(async () => {
        if (messages.length === 0 || exporting) {
            if (messages.length === 0) addToast('暂无可导出的剧情原文', 'info');
            return;
        }
        setExporting(true);
        try {
            const result = await shareOrDownloadFile({
                content: formatStoryTheaterExport(entry, mask.name, actors.map(actor => actor.name), messages),
                fileName: makeStoryTheaterFileName(entry.title),
                mimeType: 'text/plain;charset=utf-8',
                shareTitle: `${entry.title || '未命名剧情'}的完整原文`,
            });
            addToast(result === 'shared' ? '已打开分享面板' : '剧情原文已导出', 'success');
        } catch (error: any) {
            console.error('[StoryTheater] export failed', error);
            addToast(`剧情原文导出失败：${error?.message || error}`, 'error');
        } finally {
            setExporting(false);
        }
    }, [actors, addToast, entry, exporting, mask.name, messages]);

    const openSharedFictionMemoryCards = useCallback(async () => {
        if (entry.writesToCharacterMemory) {
            addToast('真实时间陪伴已经按真实经历进入角色记忆，不需要再做虚构记忆卡', 'info');
            return;
        }
        if (messages.length === 0) {
            addToast('先演一段剧情，再整理共同演绎记忆', 'info');
            return;
        }
        if (memoryCardBusy || memoryActors.length === 0) return;

        setMemoryCardBusy(true);
        try {
            const existingGroups = await Promise.all(
                memoryActors.map(actor => DB.getAppMemoryCandidatesBySource(actor.id, 'story_theater', entry.id)),
            );
            const existing = existingGroups.flat();
            const pending = existing.filter(candidate => candidate.status === 'pending');
            if (pending.length > 0) {
                setMemoryCandidates(existing);
                setShowMemoryCards(true);
                return;
            }

            const transcript = [
                `[剧情标题] ${entry.title}`,
                entry.premise ? `[剧情介绍] ${entry.premise}` : '',
                '[记忆性质] 这是一段大家在剧情剧场里共同创作、共同演绎的虚构故事，不是现实经历。',
                `[用户侧执笔身份] ${mask.name}`,
                `[参与角色] ${actors.map(actor => actor.name).join('、') || '暂无'}`,
                ...messages.map(message => {
                    const who = message.role === 'user' ? `${mask.name}（用户侧执笔）` : '剧场正文';
                    return `[${who}] ${message.content}`;
                }),
            ].filter(Boolean).join('\n\n');

            const generated: AppMemoryCandidate[] = [];
            for (const actor of memoryActors) {
                setMemoryStatus(`正在为 ${actor.name} 整理“我们一起演过”的记忆卡……`);
                const rows = await generateAppMemoryCandidates({
                    sourceApp: 'story_theater',
                    sourceRecordId: entry.id,
                    char: actor,
                    userProfile,
                    groups,
                    apiConfig,
                    realtimeConfig,
                    transcript,
                    sceneHint: `与用户共同演绎虚构剧情《${entry.title}》；记住共同创作本身，不把剧中事件当成现实经历。用户侧执笔身份：${mask.name}`,
                });
                generated.push(...rows);
            }

            setMemoryCandidates([...existing, ...generated]);
            setShowMemoryCards(true);
            if (generated.length === 0) addToast('目前没有值得带回主聊天的共同演绎记忆', 'info');
        } catch (error: any) {
            console.error('[StoryTheater] shared fiction memory cards failed', error);
            addToast(`整理共同演绎记忆失败：${error?.message || error}`, 'error');
        } finally {
            setMemoryStatus('');
            setMemoryCardBusy(false);
        }
    }, [actors, addToast, apiConfig, entry, groups, mask.name, memoryActors, memoryCardBusy, messages, realtimeConfig, userProfile]);

    const callCompletion = useCallback(async (
        payload: Array<{ role: string; content: string }>,
        settings?: Partial<StoryGenerationSettings>,
        onPromptTokens?: (tokens: number) => void,
        onStreamText?: (fullText: string) => void,
        background?: {
            ownerKey: string;
            title: string;
            meta?: Record<string, any>;
            beforeRelease?: () => Promise<void> | void;
        },
    ): Promise<string> => {
        const generationSettings = prepareStoryGenerationSettings(settings, entry.omitSamplingParams === true);
        const plan = resolveApiExecutionPlan('story', apiConfig, true);
        const wantsStreamPreview = Boolean(onStreamText);
        const requestBody = {
            model: apiConfig.model,
            messages: payload,
            // 正文不要再无脑强制 stream:true：不写 stream，让每条 API 线路按自己的
            // 预设决定是否流式；总结/归档没有预览回调时则明确要求 stream:false。
            // 这样 Gemini/特殊中转不会被强行塞进 OpenAI SSE，非流式也能正常拿整包正文。
            ...(wantsStreamPreview ? {} : { stream: false }),
            ...generationSettings,
        };

        // 回到 9/2 已验证可切屏的架构：模型请求始终走 WebView/browser fetch；
        // Android 原生层只负责前台服务 + WakeLock 保活，不再自己直连模型 API。
        // 这样保留浏览器这条已经稳定的 SSE/代理兼容链路，同时避免原生 OkHttp 的
        // Software caused connection abort / 524 / 首字超时等另一套网络行为。
        let keepAliveLease: string | null = null;
        if (background && isNativeStoryBackgroundRuntime()) {
            try {
                // 清掉今天原生直连版本留下的旧 pending，防止升级后幽灵恢复。
                await clearPendingNativeStoryJob(background.ownerKey);
                keepAliveLease = await acquireNativeStoryKeepAlive(background.ownerKey, background.title);
            } catch (keepAliveError) {
                console.warn('[StoryTheater] native keepalive unavailable; continuing with browser fetch', keepAliveError);
            }
        }

        let completionSucceeded = false;
        const completionStartedAt = Date.now();
        let streamedChars = 0;
        let firstVisibleMs: number | null = null;
        const attemptTrace: Array<Record<string, unknown>> = [];
        const safeRouteLabel = (route: any): string => {
            const rawBaseUrl = String(route?.api?.baseUrl || '');
            let host = rawBaseUrl;
            try { host = new URL(rawBaseUrl).host || rawBaseUrl; } catch { /* keep raw base URL */ }
            return [
                route?.presetName || route?.presetId || 'direct',
                host || 'unknown-host',
                route?.api?.model || 'unknown-model',
            ].join(' @ ');
        };
        try {
            const { value: data } = await executeOpenAiChatPlan({
                plan,
                body: requestBody,
                meta: {
                    appId: 'date',
                    appName: '剧情剧场',
                    purpose: '剧情续写',
                },
                directMaxRetries: 2,
                // 单线路剧情不再把“首字慢”误判成失败；连接只要还活着就继续等待。
                disableDirectFirstVisibleTimeout: true,
                // 恢复 9/2 已验证可切屏的正文行为：只要当前调用需要实时正文预览，
                // 就强制走流式，让 WebView 在后台持续收到数据；否则 Android 隐藏 WebView
                // 容易把“长时间零字节的非流式请求”冻结/断开。
                // 总结/归档没有 onStreamText，仍明确 stream:false，不受这里影响。
                forceStream: wantsStreamPreview,
                // 剧情正文按“首个可见正文字符”承诺线路：首字前可以故障转移，
                // 首字一旦已经展示，后续断流也绝不换线路，避免两条线路各写半篇。
                streamCommitMode: wantsStreamPreview ? 'content' : 'activity',
                onAttempt: attempt => {
                    attemptTrace.push({
                        preset: attempt.presetName || attempt.presetId,
                        route: `${Number(attempt.routeIndex) + 1}/${attempt.routeCount}`,
                        phase: attempt.phase,
                        durationMs: attempt.durationMs,
                        kind: attempt.classification?.kind,
                        status: attempt.classification?.status,
                        message: attempt.classification?.message,
                    });
                },
                streamHooks: wantsStreamPreview ? {
                    onDelta: (_delta, fullText) => {
                        streamedChars = fullText.length;
                        if (firstVisibleMs === null && fullText.length > 0) {
                            firstVisibleMs = Date.now() - completionStartedAt;
                        }
                        onStreamText?.(fullText);
                    },
                } : undefined,
            });
            const reportedPromptTokens = Number(data?.usage?.prompt_tokens);
            if (Number.isFinite(reportedPromptTokens) && reportedPromptTokens > 0) onPromptTokens?.(reportedPromptTokens);
            const content = extractContent(data).trim();
            if (!content) throw new Error(describeEmptyStoryCompletion(data));

            const finishReason = String(
                data?.choices?.[0]?.finish_reason
                || data?.choices?.[0]?.finishReason
                || '',
            ).trim();
            const streamIncomplete = data?._sullyStreamIncomplete === true;
            const outputLimited = finishReason === 'length' || finishReason === 'max_tokens';
            if (outputLimited || streamIncomplete) {
                const reason = outputLimited
                    ? `模型达到输出上限（finish_reason=${finishReason}）`
                    : '流式连接结束时没有收到模型完成标记';
                const incompleteError: any = new Error(`剧情正文疑似被截断：${reason}`);
                incompleteError.storyIncompleteCompletion = {
                    content,
                    finishReason,
                    streamIncomplete,
                };
                throw incompleteError;
            }

            completionSucceeded = true;
            return content;
        } catch (completionError: any) {
            const elapsedMs = Date.now() - completionStartedAt;
            const nav = typeof navigator !== 'undefined' ? navigator as any : undefined;
            const connection = nav?.connection || nav?.mozConnection || nav?.webkitConnection;
            const diagnostics = {
                errorName: completionError?.name || 'Error',
                errorMessage: String(completionError?.message || completionError),
                elapsedMs,
                streamedChars,
                firstVisibleMs,
                online: typeof navigator !== 'undefined' ? navigator.onLine : undefined,
                visibility: typeof document !== 'undefined' ? document.visibilityState : undefined,
                effectiveType: connection?.effectiveType,
                downlink: connection?.downlink,
                saveData: connection?.saveData,
                nativeKeepAlive: Boolean(background && isNativeStoryBackgroundRuntime()),
                transport: 'webview-fetch',
                imageGenerationEnabled: entry.imageGeneration?.enabled === true,
                imageStageStarted: false,
                planMode: plan.mode,
                routes: plan.routes.map(safeRouteLabel),
                attempts: attemptTrace,
            };
            // 单独打一条纯文本诊断，确保“应用日志”导出时即使对象参数被截掉，
            // 也能直接看到这次剧情 SSE 断在哪里；不包含 API Key / 请求正文。
            console.error(
                '[StoryTheater] transport diagnostic\n'
                + JSON.stringify(diagnostics, null, 2),
            );
            try {
                completionError.storyTransportDiagnostics = diagnostics;
            } catch { /* frozen errors are fine */ }
            throw completionError;
        } finally {
            // 自动配图开启时，先申请下一张保活 lease，再释放正文 lease。
            // 两张 lease 有短暂重叠，避免 App 已在后台时正文刚结束就被系统冻结，
            // 导致后面的规划器 / MCP 生图没机会启动。
            if (completionSucceeded && background?.beforeRelease) {
                try {
                    await background.beforeRelease();
                } catch (handoffError) {
                    console.warn('[StoryTheater] keepalive handoff failed; continuing normally', handoffError);
                }
            }
            await releaseNativeStoryKeepAlive(keepAliveLease);
        }
    }, [apiConfig, entry.omitSamplingParams]);

    const saveCentralAndMirrors = useCallback(async (role: 'user' | 'assistant', content: string, centralMetadata: Record<string, unknown> = {}): Promise<number> => {
        const now = Date.now();
        const centralId = await DB.saveMessage({ charId: threadId, role, type: 'text', content, timestamp: now, metadata: { source: 'story_theater', theaterId: entry.id, ...centralMetadata } });
        if (!entry.writesToCharacterMemory) return centralId;
        const theaterMirrorIds: Record<string, number> = {};
        for (const actor of memoryActors) {
            theaterMirrorIds[actor.id] = await DB.saveMessage({
                charId: actor.id,
                role,
                type: 'text',
                content,
                timestamp: memoryTimestampForCharacter(entry, actor.id, now),
                metadata: { source: 'story_theater_memory', theaterId: entry.id, theaterTitle: entry.title, theaterCentralId: centralId },
            });
        }
        await DB.updateMessageMetadata(centralId, previous => ({ ...previous, theaterMirrorIds }));
        return centralId;
    }, [entry, memoryActors, threadId]);

    const buildActorContexts = useCallback(async (query: string): Promise<string> => {
        const allBookIds = new Set(actors.flatMap(actor => (actor.mountedWorldbooks || []).map(book => book.id)));
        const blocks: string[] = [];
        for (const actor of actors) {
            if (!entry.carryCharacterMemory) {
                blocks.push(buildBareTheaterActorContext(actor));
                continue;
            }
            const limit = Math.max(0, Math.min(500, entry.characterContextLimits[actor.id] ?? 100));
            const recent = limit > 0 ? await DB.getRecentMessagesByCharId(actor.id, limit) : [];
            let recalled = '';
            const embedding = memoryPalaceConfig.embedding;
            if (actor.memoryPalaceEnabled && embedding?.baseUrl && embedding?.apiKey) {
                const rawRecall = await retrieveMemories(recent, actor.id, embedding, actor.activeBuffs?.[0]?.name, actor.personalityStyle || 'emotional', actor.ruminationTendency ?? 0.3, query, userProfile.name, remoteVectorConfig, actor.name);
                recalled = buildStoryActorMemoryEnvelope(actor.name, rawRecall, userProfile.name, mask.name);
            }
            const theaterActor = { ...actor, memoryPalaceInjection: recalled };
            const core = ContextBuilder.buildCoreContext(theaterActor, userProfile, true, recalled, {
                skipUserProfile: true,
                skipWorldbookIds: allBookIds,
                headerOverride: `[剧情角色：${actor.name}]`,
            }, { skipTimeAwareness: true });
            blocks.push(`${core}\n${formatActorRecentMessages(actor, recent, userProfile.name, mask.name)}`.trim());
        }
        return blocks.join('\n\n---\n\n');
    }, [actors, entry.carryCharacterMemory, entry.characterContextLimits, mask.name, memoryPalaceConfig.embedding, remoteVectorConfig, userProfile]);

    const buildMaskMemoryContext = useCallback(async (query: string): Promise<string> => {
        if (!entry.carryCharacterMemory || !mask.characterId) return '';
        const maskCharacter = characters.find(char => char.id === mask.characterId);
        if (!maskCharacter) return '';
        const limit = Math.max(0, Math.min(500, entry.characterContextLimits[maskCharacter.id] ?? 100));
        const recent = limit > 0 ? await DB.getRecentMessagesByCharId(maskCharacter.id, limit) : [];
        let recalled = '';
        const embedding = memoryPalaceConfig.embedding;
        if (maskCharacter.memoryPalaceEnabled && embedding?.baseUrl && embedding?.apiKey) {
            const rawRecall = await retrieveMemories(recent, maskCharacter.id, embedding, maskCharacter.activeBuffs?.[0]?.name, maskCharacter.personalityStyle || 'emotional', maskCharacter.ruminationTendency ?? 0.3, query, userProfile.name, remoteVectorConfig, maskCharacter.name);
            recalled = buildStoryActorMemoryEnvelope(maskCharacter.name, rawRecall, userProfile.name, mask.name);
        }
        const skipWorldbookIds = new Set([
            ...(maskCharacter.mountedWorldbooks || []).map(book => book.id),
            ...actors.flatMap(actor => (actor.mountedWorldbooks || []).map(book => book.id)),
        ]);
        const core = ContextBuilder.buildCoreContext({ ...maskCharacter, memoryPalaceInjection: recalled }, userProfile, true, recalled, {
            skipUserProfile: true,
            skipWorldbookIds,
            headerOverride: `[你当前身份的既有记忆：${maskCharacter.name}]`,
        }, { skipTimeAwareness: true });
        return `${core}\n${formatActorRecentMessages(maskCharacter, recent, userProfile.name, mask.name)}`.trim();
    }, [actors, characters, entry.carryCharacterMemory, entry.characterContextLimits, mask.characterId, mask.name, memoryPalaceConfig.embedding, remoteVectorConfig, userProfile]);

    const independentRecall = useCallback(async (query: string, recent: Message[], activeEntry: StoryTheaterEntry = entry): Promise<string> => {
        if (activeEntry.writesToCharacterMemory || !activeEntry.archives.some(archive => archive.strategy === 'vector')) return '';
        const embedding = memoryPalaceConfig.embedding;
        if (!embedding?.baseUrl || !embedding?.apiKey) return '（本剧情存在向量归档，但当前没有可用的向量记忆配置。）';
        return retrieveMemories(recent, threadId, embedding, undefined, 'emotional', 0.3, query, mask.name, remoteVectorConfig, activeEntry.title);
    }, [entry, mask.name, memoryPalaceConfig.embedding, remoteVectorConfig, threadId]);

    const applyActorMemoryPipeline = useCallback(async () => {
        if (!entry.writesToCharacterMemory) return;
        const embedding = memoryPalaceConfig.embedding;
        const light = memoryPalaceConfig.lightLLM?.baseUrl ? memoryPalaceConfig.lightLLM : { baseUrl: apiConfig.baseUrl, apiKey: apiConfig.apiKey, model: apiConfig.model };
        if (!embedding?.baseUrl || !embedding?.apiKey || !light.baseUrl) return;
        for (const actor of memoryActors) {
            if (!actor.memoryPalaceEnabled) continue;
            try {
                setMemoryStatus(`${actor.name}正在整理这段相处……`);
                const recent = await DB.getRecentMessagesByCharId(actor.id, 50);
                await processNewMessagesWithAutoArchive(recent, actor.id, actor.name, embedding, light, mask.name, false, setMemoryStatus);
                if (incrementDigestRound(actor.id)) {
                    await runCognitiveDigestion(actor.id, actor.name, [actor.systemPrompt, actor.worldview].filter(Boolean).join('\n'), light, false, mask.name, embedding);
                }
            } catch (error: any) {
                console.warn('[StoryTheater] actor memory pipeline failed', actor.id, error?.message || error);
            }
        }
        setMemoryStatus('');
        await loadMessages();
    }, [apiConfig, characters, entry.writesToCharacterMemory, loadMessages, mask.name, memoryActors, memoryPalaceConfig, updateCharacter]);

    const archiveIfNeeded = useCallback(async (): Promise<StoryTheaterEntry | null> => {
        if (entry.writesToCharacterMemory || archiveLock.current) return null;
        archiveLock.current = true;
        try {
            const rows = (await DB.getMessagesByCharId(threadId, true))
                .filter(message => message.metadata?.source === 'story_theater' && !message.metadata?.theaterArchived)
                .sort((a, b) => a.id - b.id);
            const batch = selectStoryArchiveBatch(rows, entry.archiveAfter, entry.archiveKeepRecent ?? 5);
            if (batch.length === 0) return null;
            const first = batch[0];
            const last = batch[batch.length - 1];
            let summary: string | undefined;

            if (entry.archiveStrategy === 'summary') {
                setMemoryStatus(`正在把 ${batch.length} 条正文压成事件盒……`);
                const transcript = batch.map(message => `${message.role === 'user' ? '推进' : '正文'}：${message.content}`).join('\n\n');
                summary = await callCompletion([
                    { role: 'system', content: '把剧场片段压缩成一只可长期常驻上下文的事件盒。使用第三人称，严格保留人物、因果、承诺、关系变化、未解决冲突和当前场景落点；不要评论写作，不要虚构片段外事实。控制在 800 字以内。' },
                    { role: 'user', content: `剧情：${entry.title}\n\n${transcript}` },
                ], { temperature: 0.2, max_tokens: 1600 });
            } else {
                const embedding = memoryPalaceConfig.embedding;
                const light = memoryPalaceConfig.lightLLM?.baseUrl ? memoryPalaceConfig.lightLLM : { baseUrl: apiConfig.baseUrl, apiKey: apiConfig.apiKey, model: apiConfig.model };
                if (!embedding?.baseUrl || !embedding?.apiKey || !light.baseUrl) {
                    addToast('独立向量归档需要先完成向量记忆配置', 'error');
                    return null;
                }
                setMemoryStatus(`正在写入「${entry.title}」的独立向量分区……`);
                const result = await processMessageRange(threadId, entry.title, embedding, light, first.id, last.id, mask.name, setMemoryStatus);
                if (result.error && result.stored === 0 && result.skipped === 0) throw new Error('这批正文没有生成可用的向量记忆');
            }

            await Promise.all(batch.map(message => DB.updateMessageMetadata(message.id, previous => ({ ...previous, theaterArchived: true, theaterArchiveStrategy: entry.archiveStrategy }))));
            const next: StoryTheaterEntry = {
                ...entry,
                archives: [...entry.archives, {
                    id: makeStoryTheaterId(),
                    strategy: entry.archiveStrategy,
                    fromMessageId: first.id,
                    toMessageId: last.id,
                    messageCount: batch.length,
                    ...(summary ? { summary } : {}),
                    createdAt: Date.now(),
                }],
                updatedAt: Date.now(),
            };
            await onEntryChange(next);
            await loadMessages();
            addToast(entry.archiveStrategy === 'summary' ? '旧正文已收进事件盒' : '旧正文已写入独立向量分区', 'success');
            return next;
        } catch (error: any) {
            console.error('[StoryTheater] archive failed', error);
            addToast(`剧情归档失败：${error?.message || error}`, 'error');
            return null;
        } finally {
            archiveLock.current = false;
            setMemoryStatus('');
        }
    }, [addToast, apiConfig, callCompletion, entry, loadMessages, mask.name, memoryPalaceConfig, onEntryChange, threadId]);

    const send = useCallback(async (rerollTarget?: Message, continueRequested = false) => {
        if (sendLock.current || actors.length === 0) return;
        sendLock.current = true;
        streamingTextRef.current = '';
        setStreamingText('');
        setSending(true);
        setRerollingId(rerollTarget?.id || null);

        let partialStreamText = '';
        let partialAffinityInputs: StoryAffinityInput[] = [];
        let partialPromptTokens = 0;
        let partialPromptTokensExact = false;
        let partialIsReroll = false;
        let partialRerollTarget: Message | undefined;
        let partialClearInput = false;
        const backgroundOwnerKey = `story-turn:${entry.id}`;
        let automaticImageKeepAliveLease: string | null = null;
        let activeRequestKey = '';
        let activeUserMessageId = 0;

        try {
            const before = (await DB.getMessagesByCharId(threadId, true))
                .filter(message => message.metadata?.source === 'story_theater')
                .sort((a, b) => a.id - b.id);
            const latest = before[before.length - 1];
            const isReroll = Boolean(rerollTarget && latest?.id === rerollTarget.id && latest.role === 'assistant' && !mirrorArchived(latest, entry));
            partialIsReroll = isReroll;
            partialRerollTarget = rerollTarget;
            if (rerollTarget && !isReroll) return;
            const openingPrompt = `请直接写出「${entry.title}」的第一幕。${entry.premise ? `剧情介绍：${entry.premise}` : '没有额外剧情介绍，请根据角色、世界与预设自然建立场景。'}直接开始，不要求补充信息，也不要替当前由你执笔的身份做重大决定。`;
            const typedText = input.trim();
            const rerollIndex = isReroll ? before.findIndex(message => message.id === rerollTarget?.id) : -1;
            const previousUser = rerollIndex > 0 ? [...before.slice(0, rerollIndex)].reverse().find(message => message.role === 'user') : undefined;
            const assistantOpening = !isReroll && !continueRequested && before.length === 0 && entry.openingMode === 'assistant' && !typedText;
            const text = isReroll
                ? (previousUser?.content.trim() || openingPrompt)
                : (continueRequested ? MEETING_CONTINUE_DISPLAY_TEXT : (typedText || getPendingStoryRetryInput(before) || (assistantOpening ? openingPrompt : '')));
            if (!text) return;
            const retry = !isReroll && latest?.role === 'user' && latest.content === text;
            activeRequestKey = isReroll && rerollTarget
                ? `story-reroll:${entry.id}:${rerollTarget.id}`
                : retry
                    ? String(latest?.metadata?.theaterRequestKey || `story-turn:${entry.id}:${latest?.id || makeStoryTheaterId()}`)
                    : assistantOpening
                        ? `story-opening:${entry.id}`
                        : `story-turn:${entry.id}:${makeStoryTheaterId()}`;
            // 重新生成与失败重试都从消息标记恢复“继续”，模型始终收到模式专属调度词；
            // 数据库、阅读页与角色镜像只留下简洁的“（继续）”。
            const isContinueTurn = isReroll
                ? previousUser?.metadata?.theaterContinue === true
                : continueRequested || (retry && latest?.metadata?.theaterContinue === true);
            partialClearInput = !isContinueTurn;
            const modelText = isContinueTurn ? buildStoryContinueInstruction(promptIdentityName) : text;
            const draftAffinityInputs = affinityEnabled ? actors.map(actor => {
                const draft = affinityDrafts[actor.id] || EMPTY_AFFINITY_DRAFT;
                return normalizeAffinityInput({ ...draft, characterId: actor.id, characterName: actor.name }, actor);
            }).filter((value): value is StoryAffinityInput => Boolean(value)) : [];
            const savedAffinityInputs = affinityInputsFromMessage(isReroll ? previousUser : retry ? latest : undefined, actors);
            const rerollAffinityInputs = isReroll ? affinityInputsFromMessage(rerollTarget, actors) : [];
            const affinityInputs = savedAffinityInputs.length > 0 ? savedAffinityInputs : rerollAffinityInputs.length > 0 ? rerollAffinityInputs : draftAffinityInputs;
            partialAffinityInputs = affinityInputs;
            const userMessageId = isReroll
                ? (previousUser?.id || 0)
                : assistantOpening
                    ? 0
                    : retry
                        ? latest.id
                        : await saveCentralAndMirrors('user', text, {
                            ...(affinityInputs.length > 0 ? { theaterAffinityInputs: affinityInputs } : {}),
                            ...(isContinueTurn ? { theaterContinue: true } : {}),
                            theaterRequestKey: activeRequestKey,
                            theaterRequestState: 'pending',
                            theaterRequestStartedAt: Date.now(),
                        });
            activeUserMessageId = Number(userMessageId || 0);
            if (!isReroll && activeUserMessageId > 0) {
                await DB.updateMessageMetadata(activeUserMessageId, previous => ({
                    ...previous,
                    theaterRequestKey: activeRequestKey,
                    theaterRequestState: 'pending',
                    theaterRequestStartedAt: previous.theaterRequestStartedAt || Date.now(),
                    ...(retry ? { theaterRequestRetriedAt: Date.now() } : {}),
                }));
            }
            if (!isReroll && !assistantOpening) await loadMessages();

            // 归档不能只放在成功生成之后：一旦会话已经碰到上游上下文上限，正文永远生成
            // 不出来，后置归档也就永远没有机会执行。重试已有 user 楼层时先归档，窗口可自愈。
            const promptEntry = await archiveIfNeeded() || entry;

            const current = (await DB.getMessagesByCharId(threadId, true))
                .filter(message => message.metadata?.source === 'story_theater')
                .sort((a, b) => a.id - b.id);
            const history = current.filter(message => message.id !== userMessageId && message.id !== rerollTarget?.id);
            const visibleHistory = history.filter(message => !mirrorArchived(message, promptEntry));
            const [actorContext, maskMemoryContext, vectorRecall] = await Promise.all([
                buildActorContexts(modelText),
                buildMaskMemoryContext(modelText),
                independentRecall(modelText, visibleHistory.slice(-8), promptEntry),
            ]);
            const summaries = promptEntry.archives.filter(archive => archive.summary).map((archive, index) => `事件盒 ${index + 1}：${archive.summary}`).join('\n\n');
            const scenario = [
                `### 当前剧情\n标题：${entry.title}\n前提：${entry.premise || '沿用已经发生的正文自然继续。'}`,
                summaries ? `### 常驻事件盒\n${summaries}` : '',
                vectorRecall ? buildStoryArchiveMemoryEnvelope(vectorRecall) : '',
            ].filter(Boolean).join('\n\n');
            const worldbookScanMessages = buildStoryWorldbookScanMessages(
                visibleHistory.map(message => ({ role: message.role, content: message.content })),
                modelText,
            );
            const worldbookSlots = buildTheaterWorldbookSlots(selectedBooks, worldbookScanMessages, promptIdentityName, actors.map(actor => actor.name));
            const compiled = compileStoryPreset({
                preset: effectivePreset,
                userName: promptIdentityName,
                characterNames: actors.map(actor => actor.name),
                slots: {
                    actors: actorContext,
                    persona: [buildTheaterPersona(mask), maskMemoryContext].filter(Boolean).join('\n\n'),
                    scenario,
                    worldBefore: worldbookSlots.worldBefore,
                    worldAfter: worldbookSlots.worldAfter,
                    history: textFromHistory(visibleHistory, promptIdentityName),
                },
            });
            const miniTheaterReminder = buildStoryMiniTheaterReminder(effectivePreset.document, promptIdentityName, actors.map(actor => actor.name));
            const backstageAftermathReminder = buildStoryBackstageAftermathReminder(effectivePreset.document);
            const textToneFormatReminder = buildStoryTextToneFormatReminder(appearance.textToneEnabled);
            const multiAffinityGuide = affinityEnabled ? buildStoryMultiAffinityGuide(actors.map(actor => ({ id: actor.id, name: actor.name }))) : '';
            const affinityAwarenessReminder = affinityInputs.map(item => buildStoryAffinityAwarenessReminder(item, item.characterName || '当前角色')).filter(Boolean).join('\n\n');
            const identityGuard = buildStoryIdentityGuard(effectivePreset.document, promptIdentityName, actors.map(actor => actor.name));
            const modelInput = appendStoryAffinityInputs(modelText, affinityInputs);
            const payloadBeforeTurn = [
                ...compiled.messages,
                ...(promptEntry.writesToCharacterMemory ? [{ role: 'system' as const, content: REAL_COMPANION_MEMORY_GUARD }] : []),
                ...(backstageAftermathReminder ? [{ role: 'system' as const, content: backstageAftermathReminder }] : []),
                ...(miniTheaterReminder ? [{ role: 'system' as const, content: miniTheaterReminder }] : []),
                ...(textToneFormatReminder ? [{ role: 'system' as const, content: textToneFormatReminder }] : []),
                ...(multiAffinityGuide ? [{ role: 'system' as const, content: multiAffinityGuide }] : []),
                ...(affinityEnabled ? [{ role: 'system' as const, content: RELATIONSHIP_TEXTURE_GUIDE }] : []),
                ...(affinityAwarenessReminder ? [{ role: 'system' as const, content: affinityAwarenessReminder }] : []),
                { role: 'system' as const, content: identityGuard },
            ];
            const payload = appendStoryUserTurn(payloadBeforeTurn, modelInput, compiled.assistantPrefill, promptEntry.forceUserLastMessage === true);
            let promptTokenCount = estimateStoryTokens(payload.map(message => `${message.role}\n${message.content}`).join('\n'));
            let promptTokenCountExact = false;
            partialPromptTokens = promptTokenCount;
            partialPromptTokensExact = false;
            setContextTokens(promptTokenCount);
            setContextTokensExact(false);
            const prefill = compiled.assistantPrefill?.content || '';
            const generated = await callCompletion(payload, compiled.settings, reported => {
                promptTokenCount = reported;
                promptTokenCountExact = true;
                partialPromptTokens = reported;
                partialPromptTokensExact = true;
                setContextTokens(reported);
                setContextTokensExact(true);
            }, fullText => {
                const visible = prefill && !fullText.startsWith(prefill) ? `${prefill}${fullText}` : fullText;
                partialStreamText = visible;
                streamingTextRef.current = visible;
                setStreamingText(visible);
            }, {
                ownerKey: backgroundOwnerKey,
                title: entry.title,
                meta: {
                    ...(isReroll && rerollTarget ? { rerollTargetId: rerollTarget.id } : {}),
                    ...(affinityInputs.length > 0 ? { affinityInputs } : {}),
                    isContinueTurn,
                },
                beforeRelease: entry.imageGeneration?.enabled && isNativeStoryBackgroundRuntime()
                    ? async () => {
                        if (automaticImageKeepAliveLease) return;
                        automaticImageKeepAliveLease = await acquireNativeStoryKeepAlive(
                            `story-image:${entry.id}:auto`,
                            `${entry.title} · 配图`,
                        );
                    }
                    : undefined,
            });
            const content = prefill && !generated.startsWith(prefill) ? `${prefill}${generated}` : generated;
            const rowsBeforeCommit = (await DB.getMessagesByCharId(threadId, true))
                .filter(message => message.metadata?.source === 'story_theater')
                .sort((a, b) => a.id - b.id);
            const duplicateAssistant = rowsBeforeCommit.find(message =>
                message.role === 'assistant'
                && message.metadata?.theaterRequestKey === activeRequestKey
                && message.id !== rerollTarget?.id
            );
            let didCommitAssistant = false;
            let assistantMessageId: number;
            if (duplicateAssistant) {
                assistantMessageId = duplicateAssistant.id;
                console.warn('[StoryTheater] duplicate completion discarded', { requestKey: activeRequestKey, messageId: duplicateAssistant.id });
            } else {
                if (isReroll && rerollTarget) {
                    const mirrorIds = Object.values((rerollTarget.metadata?.theaterMirrorIds || {}) as Record<string, number>).map(Number).filter(Boolean);
                    await DB.deleteMessages([rerollTarget.id, ...mirrorIds]);
                }
                assistantMessageId = await saveCentralAndMirrors('assistant', content, {
                    theaterPromptTokens: promptTokenCount,
                    theaterPromptTokensExact: promptTokenCountExact,
                    theaterRequestKey: activeRequestKey,
                    ...(affinityInputs.length > 0 ? { theaterAffinityInputs: affinityInputs } : {}),
                });
                didCommitAssistant = true;
            }
            if (!isReroll && activeUserMessageId > 0) {
                await DB.updateMessageMetadata(activeUserMessageId, previous => ({
                    ...previous,
                    theaterRequestKey: activeRequestKey,
                    theaterRequestState: 'done',
                    theaterRequestFinishedAt: Date.now(),
                }));
            }
            if (!isContinueTurn) setInput('');
            setAffinityDrafts({});
            setShowAffinityInput(false);
            await loadMessages();
            streamingTextRef.current = '';
            setStreamingText('');
            partialStreamText = '';
            if (didCommitAssistant && entry.imageGeneration?.enabled) {
                setMemoryStatus('正在为本轮剧情绘制插图…');
                try {
                    const imageRows = (await DB.getMessagesByCharId(threadId, true))
                        .filter(message => message.metadata?.source === 'story_theater')
                        .sort((a, b) => a.id - b.id);
                    const imageResult = await generateStoryTheaterImage({
                        apiConfig,
                        plannerApiConfig: resolveStoryImagePlannerApiConfig(entry, apiConfig, apiPresets),
                        entry,
                        actors,
                        userProfile,
                        userName: promptIdentityName,
                        messages: imageRows,
                        targetMessageId: assistantMessageId,
                    });
                    if (imageResult.frame) {
                        await DB.updateMessageMetadata(assistantMessageId, previous => ({ ...previous, theaterImage: imageResult.frame }));
                        await loadMessages();
                    } else if (imageResult.queued) {
                        addToast('剧情配图已进入后台生成，完成后会自动挂回本轮正文', 'info');
                    }
                } catch (imageError: any) {
                    console.error('[StoryTheater] automatic image failed', imageError);
                    addToast(`正文已保存，但自动配图失败：${imageError?.message || imageError}`, 'error');
                } finally {
                    await releaseNativeStoryKeepAlive(automaticImageKeepAliveLease);
                    automaticImageKeepAliveLease = null;
                    setMemoryStatus('');
                }
            }
            if (didCommitAssistant) {
                if (entry.writesToCharacterMemory) void applyActorMemoryPipeline();
                else void archiveIfNeeded();
            }
        } catch (error: any) {
            const storyDiagnostics = error?.storyTransportDiagnostics;
            if (storyDiagnostics) {
                console.error(
                    '[StoryTheater] send failed with transport diagnostics\n'
                    + JSON.stringify(storyDiagnostics, null, 2),
                    error,
                );
            } else {
                console.error('[StoryTheater] send failed', error);
            }

            const returnedPartial = String(error?.storyIncompleteCompletion?.content || '').trim();
            const committedPartial = (partialStreamText || streamingTextRef.current || returnedPartial).trim();
            if (committedPartial) {
                try {
                    if (partialIsReroll && partialRerollTarget) {
                        const mirrorIds = Object.values((partialRerollTarget.metadata?.theaterMirrorIds || {}) as Record<string, number>)
                            .map(Number)
                            .filter(Boolean);
                        await DB.deleteMessages([partialRerollTarget.id, ...mirrorIds]);
                    }
                    const partialRows = (await DB.getMessagesByCharId(threadId, true))
                        .filter(message => message.metadata?.source === 'story_theater')
                        .sort((a, b) => a.id - b.id);
                    const duplicatePartial = activeRequestKey
                        ? partialRows.find(message => message.role === 'assistant' && message.metadata?.theaterRequestKey === activeRequestKey)
                        : undefined;
                    if (!duplicatePartial) {
                        await saveCentralAndMirrors('assistant', committedPartial, {
                            theaterPromptTokens: partialPromptTokens,
                            theaterPromptTokensExact: partialPromptTokensExact,
                            theaterInterrupted: true,
                            ...(activeRequestKey ? { theaterRequestKey: activeRequestKey } : {}),
                            ...(partialAffinityInputs.length > 0 ? { theaterAffinityInputs: partialAffinityInputs } : {}),
                        });
                    }
                    if (!partialIsReroll && activeUserMessageId > 0) {
                        await DB.updateMessageMetadata(activeUserMessageId, previous => ({
                            ...previous,
                            ...(activeRequestKey ? { theaterRequestKey: activeRequestKey } : {}),
                            theaterRequestState: 'done',
                            theaterRequestFinishedAt: Date.now(),
                        }));
                    }
                    if (partialClearInput) setInput('');
                    setAffinityDrafts({});
                    setShowAffinityInput(false);
                    await loadMessages();
                    streamingTextRef.current = '';
                    setStreamingText('');
                    addToast(
                        error?.storyIncompleteCompletion
                            ? '这一轮确实被截断了：已保留现有正文并标成“中断”，不会再冒充正常生成。可以直接点「续」接着写。'
                            : '流式生成中途断开，已保留已经出现的正文；因为已经出首字，没有切换故障转移线路。',
                        'error',
                    );
                    return;
                } catch (savePartialError: any) {
                    console.error('[StoryTheater] preserve interrupted stream failed', savePartialError);
                }
            }

            streamingTextRef.current = '';
            setStreamingText('');
            const message = String(error?.message || error);
            const isOpaqueBrowserFailure = /load failed|failed to fetch|network\s*error|network request failed/i.test(message);
            const isAmbiguousTransportFailure = (
                error?.name === 'TypeError'
                || error?.name === 'AbortError'
                || /network\s*error|failed to fetch|load failed|network request failed|timeout|timed out|aborted|首字等待超时/i.test(message)
            );
            if (!partialIsReroll && activeUserMessageId > 0) {
                await DB.updateMessageMetadata(activeUserMessageId, previous => ({
                    ...previous,
                    ...(activeRequestKey ? { theaterRequestKey: activeRequestKey } : {}),
                    theaterRequestState: 'failed',
                    theaterRequestFailedAt: Date.now(),
                    theaterRequestError: message.slice(0, 300),
                }));
                await loadMessages();
            }
            if (isAmbiguousTransportFailure) {
                addToast('连接已经实际断开；这一轮现在可以立即重试。单纯“模型很慢”不会再被当成超时报错；若极端情况下旧结果晚到，同一轮 request key 会阻止重复正文。', 'error');
            } else {
                addToast(
                    isOpaqueBrowserFailure
                        ? '剧情请求被上游/网关断开，浏览器读不到真实错误。请求差异已写入 Network 日志。'
                        : message.includes('API Error 400') && isStoryUserLastCompatibilityError(message) && !entry.forceUserLastMessage
                        ? '剧情续写失败：API 400。若日志提示最后一条必须是 user，可在右上角设置开启“400 兼容模式”；更建议更换模型。'
                        : `剧情续写失败：${message}`,
                    'error',
                );
            }
        } finally {
            await releaseNativeStoryKeepAlive(automaticImageKeepAliveLease);
            automaticImageKeepAliveLease = null;
            sendLock.current = false;
            setSending(false);
            setRerollingId(null);
        }
    }, [actors, addToast, affinityDrafts, affinityEnabled, apiConfig, apiPresets, appearance.textToneEnabled, applyActorMemoryPipeline, archiveIfNeeded, buildActorContexts, buildMaskMemoryContext, callCompletion, effectivePreset, entry, independentRecall, input, loadMessages, mask, promptIdentityName, saveCentralAndMirrors, selectedBooks, threadId, userProfile]);

    // Android 后台只保活 WebView 请求，不再创建可恢复的原生 API 任务。

    const archivedCount = messages.filter(message => mirrorArchived(message, entry)).length;
    const pendingRetryInput = getPendingStoryRetryInput(messages);
    const canWriteOpening = messages.length === 0 && entry.openingMode === 'assistant';
    const filledAffinityActorIds = actors.filter(actor => {
        const draft = affinityDrafts[actor.id];
        return Boolean(draft && (draft.delta !== 0 || draft.reason.trim()));
    }).map(actor => actor.id);
    const selectedAffinityActor = actors.find(actor => actor.id === selectedAffinityActorId) || actors[0];
    const selectedAffinityDraft = selectedAffinityActor ? (affinityDrafts[selectedAffinityActor.id] || EMPTY_AFFINITY_DRAFT) : EMPTY_AFFINITY_DRAFT;

    return <div className='relative h-full w-full flex flex-col bg-stone-100 text-slate-800'>
        <header className='story-safe-header shrink-0 bg-stone-100/95 backdrop-blur border-b border-slate-200 z-10'>
            <div className='h-14 px-3 flex items-center gap-2'>
                <button onClick={onBack} className='w-9 h-9 shrink-0 rounded-full grid place-items-center' aria-label='返回'><ArrowLeft size={20} /></button>
                <div className='min-w-0 flex-1'>
                    <div className='flex items-center gap-2'>
                        <h1 className='min-w-0 flex-1 truncate font-serif text-[15px] font-semibold text-slate-800'>{entry.title}</h1>
                        {sending && <span className='shrink-0 inline-flex items-center gap-1 text-[8px] font-bold text-emerald-700'><span className='h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse' />续写中</span>}
                    </div>
                    <div className='mt-0.5 flex min-w-0 items-center gap-1.5 text-[9px] text-slate-400'>
                        <span className='truncate'>{youLabel} · {actors.map(actor => actor.name).join('、') || '未选角色'}</span>
                        <span className='shrink-0'>·</span>
                        <span className='shrink-0' title={displayedTokenInfo.exact ? '本轮实际使用的完整上下文' : '按本轮完整上下文估算'}>{displayedTokenInfo.count > 0 ? `${(displayedTokenInfo.count / 1000).toFixed(displayedTokenInfo.count >= 10000 ? 0 : 1)}k` : '—'}</span>
                    </div>
                </div>
                <button
                    type='button'
                    onClick={() => setShowHeaderMenu(true)}
                    className='w-9 h-9 shrink-0 rounded-full border border-slate-200 bg-white grid place-items-center text-slate-600 active:scale-95 transition-transform'
                    title='剧情工具与设置'
                    aria-label='剧情工具与设置'
                >
                    <GearSix size={18} />
                </button>
            </div>
        </header>

        {showMemoryCards && memoryActors[0] && (
            <AppMemoryCandidatePanel
                candidates={memoryCandidates}
                char={memoryActors[0]}
                characters={memoryActors}
                userProfile={userProfile}
                memoryPalaceConfig={memoryPalaceConfig}
                remoteVectorConfig={remoteVectorConfig}
                updateCharacter={updateCharacter}
                addToast={addToast}
                onChange={setMemoryCandidates}
                onClose={() => setShowMemoryCards(false)}
            />
        )}

        <main
            ref={scrollContainerRef}
            onScroll={handleStoryScroll}
            className='story-page-scroll flex-1 overflow-y-auto px-5 py-7'
        >
            <div ref={scrollContentRef} className='max-w-2xl mx-auto'>
                {messages.length === 0 ? <section className='py-10 border-y border-slate-200'>
                    <div className='text-[9px] tracking-[.25em] uppercase font-bold text-violet-500'>Opening note</div>
                    <h2 className='mt-3 text-3xl font-serif font-semibold leading-tight'>{entry.title}</h2>
                    <p className='mt-5 text-sm leading-7 text-slate-600 whitespace-pre-wrap'>{entry.premise || (canWriteOpening ? '人物与世界已经就位，可以让故事先写下第一幕。' : '写下第一句话，让人物走进这座只属于本条剧情的剧场。')}</p>
                    <p className='mt-6 text-[10px] text-slate-400'>{canWriteOpening ? '输入框留空，点击推进即可开场' : '这一幕由你先落笔'}</p>
                    <p className='mt-3 text-[9px] leading-5 text-slate-400'>小提示：生成正文后，长按楼层可编辑或删除；“预设”和“关系”浮钮都可以拖到顺手的位置。</p>
                </section> : entry.writesToCharacterMemory && <div className='mb-8 py-3 border-y border-amber-200 text-center text-[11px] text-amber-700'>和朋友们已经分别相处了一段时间……</div>}

                {archivedMessageIds.length > 0 && <div className='mb-7 px-1 flex items-center justify-between gap-3 text-[9px] text-slate-400'><span>{archivedMessageIds.length} 条归档原文 · 默认折叠，整段上下滑动浏览</span><button onClick={toggleAllArchives} className='shrink-0 px-3 py-1.5 rounded-full bg-white border border-slate-200 font-bold text-violet-600'>{allArchivesExpanded ? '全部收起' : '全部展开'}</button></div>}

                <div className='space-y-8'>
                    {messages.map(message => {
                        const archived = mirrorArchived(message, entry);
                        if (archived) {
                            const archiveLabel = entry.writesToCharacterMemory
                                ? '已作为正常记忆归档'
                                : message.metadata?.theaterArchiveStrategy === 'vector'
                                    ? '已存入本剧情向量分区'
                                    : '已收进剧场事件盒';
                            const isExpanded = expandedArchivedIds.has(message.id);
                            return <details key={message.id} open={isExpanded} onToggle={event => setArchiveExpanded(message.id, event.currentTarget.open)} className='group border-y border-slate-200'>
                                <summary className='list-none cursor-pointer py-3 flex items-center gap-3 text-slate-400 [&::-webkit-details-marker]:hidden'>
                                    <Archive size={13} className='shrink-0' />
                                    <span className='min-w-0 flex-1'>
                                        <strong className='block text-[10px] font-semibold tracking-wide'>{archiveLabel}</strong>
                                        <span className='block mt-0.5 text-[9px]'>{message.role === 'user' ? '你的推进' : '剧场正文'} · 展开查看原文</span>
                                    </span>
                                    <CaretDown size={14} className='shrink-0 transition-transform group-open:rotate-180' />
                                </summary>
                                {isExpanded && <div {...pressHandlersFor(message)} className='pb-5 pl-7'>
                                    {message.role === 'user'
                                        ? <p className='text-sm leading-7 text-slate-600 whitespace-pre-wrap'>{message.content}</p>
                                        : <><StoryOutput content={message.content} affinityInputs={affinityInputsFromMessage(message, actors)} /><StoryRoundImage message={message} busy={regeneratingImageId === message.id} onRegenerate={() => void regenerateStoryImage(message)} /></>}
                                </div>}
                            </details>;
                        }
                        if (message.role === 'user') return <section key={message.id} {...pressHandlersFor(message)} className='pl-4 border-l-2 border-violet-300'><div className='text-[9px] tracking-[.16em] font-bold text-violet-500'>你写下</div><p className='mt-2 text-sm leading-7 text-slate-600 whitespace-pre-wrap'>{message.content}</p></section>;
                        const isLatest = message.id === messages[messages.length - 1]?.id;
                        return <article key={message.id} {...pressHandlersFor(message)}><StoryOutput content={message.content} onChoose={choice => setInput(choice)} affinityInputs={affinityInputsFromMessage(message, actors)} /><StoryRoundImage message={message} busy={regeneratingImageId === message.id} onRegenerate={() => void regenerateStoryImage(message)} />{isLatest && <div className='mt-4 flex items-center justify-end gap-2'><span className='w-1.5 h-1.5 rounded-full bg-violet-400' /><button disabled={sending} onClick={() => void send(message)} className='inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border border-slate-200 bg-white text-[10px] font-bold text-slate-500 disabled:opacity-40'>{rerollingId === message.id ? <SpinnerGap size={12} className='animate-spin' /> : <ArrowClockwise size={12} />}换一种写法</button></div>}</article>;
                    })}
                    {streamingText && <article className='relative'>
                        <StoryOutput content={streamingText} affinityInputs={[]} />
                        <div className='mt-4 flex items-center gap-2 text-[9px] font-bold text-violet-500'>
                            <span className='w-1.5 h-1.5 rounded-full bg-violet-500 animate-pulse' />
                            正在续写 · 首字出现后将固定当前线路
                        </div>
                    </article>}
                </div>
                {archivedCount > 0 && <div className='mt-10 flex items-center justify-center gap-2 text-[9px] text-slate-400'><Archive size={13} />{archivedCount} 条旧内容已归档，仍会通过所选记忆方式参与续写</div>}
                <div ref={bottomRef} className='h-6' />
            </div>
        </main>

        {affinityEnabled && showAffinityInput && <div
            className='fixed inset-0 z-[60] flex items-end bg-slate-950/30'
            onClick={() => setShowAffinityInput(false)}
        >
            <div
                className='story-safe-sheet w-full max-h-[74dvh] overflow-y-auto rounded-t-[28px] bg-stone-100 px-5 pt-5 shadow-2xl'
                onClick={event => event.stopPropagation()}
                role='dialog'
                aria-modal='true'
                aria-label='本轮关系备注'
            >
                <div className='flex items-start gap-4'>
                    <div className='w-10 h-10 shrink-0 rounded-xl bg-rose-100 text-rose-600 grid place-items-center'>
                        <HeartStraight size={18} weight='fill' />
                    </div>
                    <div className='min-w-0 flex-1'>
                        <div className='text-[9px] tracking-[.18em] uppercase font-bold text-rose-500'>Affinity note</div>
                        <h2 className='mt-0.5 text-base font-semibold'>这轮关系备注 · 可选</h2>
                        <p className='mt-1 text-[9px] leading-4 text-slate-400'>
                            {filledAffinityActorIds.length > 0
                                ? `已填写 ${filledAffinityActorIds.length} 位：${actors.filter(actor => filledAffinityActorIds.includes(actor.id)).map(actor => actor.name).join('、')}`
                                : '只有你觉得关系真的有变化时才需要填。'}
                        </p>
                    </div>
                    <button type='button' onClick={() => setShowAffinityInput(false)} className='w-9 h-9 shrink-0 rounded-full bg-white border border-slate-200 grid place-items-center text-slate-500' aria-label='关闭关系备注'>
                        <X size={16} />
                    </button>
                </div>

                <div className='mt-5 border-t border-rose-200'>
                    <div className='pt-4 flex gap-2 overflow-x-auto'>
                        {actors.map(actor => {
                            const filled = filledAffinityActorIds.includes(actor.id);
                            const selected = selectedAffinityActor?.id === actor.id;
                            return <button key={actor.id} type='button' onClick={() => setSelectedAffinityActorId(actor.id)} className={`shrink-0 px-2.5 py-2 rounded-xl flex items-center gap-2 border text-[10px] font-bold ${selected ? 'bg-white border-rose-300 text-rose-700' : 'border-transparent text-slate-500'}`}>
                                <TokenImg value={actor.avatar} alt='' className='w-6 h-6 rounded-full object-cover' />
                                <span>{actor.name}</span>
                                <span className={`w-1.5 h-1.5 rounded-full ${filled ? 'bg-rose-500' : 'bg-slate-200'}`} />
                            </button>;
                        })}
                    </div>

                    {selectedAffinityActor && <div className='mt-4 pt-4 border-t border-rose-200/70'>
                        <div className='flex items-center justify-between gap-3'>
                            <div>
                                <span className='block text-[10px] font-bold text-rose-700'>你 → {selectedAffinityActor.name}</span>
                                <span className='block mt-0.5 text-[9px] text-slate-400'>只改变你和这位角色在这一轮的关系</span>
                            </div>
                            <button type='button' onClick={() => setAffinityDrafts(current => { const next = { ...current }; delete next[selectedAffinityActor.id]; return next; })} className='text-[9px] font-bold text-slate-400'>清空这位</button>
                        </div>

                        <div className='mt-4 flex items-center gap-3'>
                            <span className='text-[10px] font-bold text-rose-600'>变化</span>
                            <input disabled={sending} type='range' min={-10} max={10} step={1} value={selectedAffinityDraft.delta} onChange={event => patchAffinityDraft(selectedAffinityActor.id, { delta: Number(event.target.value) })} className='min-w-0 flex-1 accent-rose-500' />
                            <strong className={`w-8 text-right text-xs ${selectedAffinityDraft.delta > 0 ? 'text-rose-600' : selectedAffinityDraft.delta < 0 ? 'text-slate-600' : 'text-slate-400'}`}>{selectedAffinityDraft.delta >= 0 ? '+' : ''}{selectedAffinityDraft.delta}</strong>
                        </div>

                        <input disabled={sending} maxLength={200} value={selectedAffinityDraft.reason} onChange={event => patchAffinityDraft(selectedAffinityActor.id, { reason: event.target.value })} placeholder={`为什么你对 ${selectedAffinityActor.name} 有这点变化？`} className='mt-3 w-full px-3 py-3 rounded-xl bg-white border border-rose-200 text-xs outline-none placeholder:text-slate-300' />

                        <div className='mt-3 grid grid-cols-2 p-1 rounded-xl bg-white border border-rose-200'>
                            <button type='button' disabled={sending} onClick={() => patchAffinityDraft(selectedAffinityActor.id, { awareness: 'unnoticed' })} className={`py-2.5 rounded-lg text-[9px] font-bold ${selectedAffinityDraft.awareness === 'unnoticed' ? 'bg-slate-100 text-slate-700' : 'text-slate-400'}`}><span className='inline-flex items-center gap-1'><EyeSlash size={12} />未察觉 · 只变氛围</span></button>
                            <button type='button' disabled={sending} onClick={() => patchAffinityDraft(selectedAffinityActor.id, { awareness: 'noticed' })} className={`py-2.5 rounded-lg text-[9px] font-bold ${selectedAffinityDraft.awareness === 'noticed' ? 'bg-violet-100 text-violet-700' : 'text-slate-400'}`}><span className='inline-flex items-center gap-1'><Eye size={12} />已察觉 · 完全透视</span></button>
                        </div>

                        <p className='mt-3 pb-2 text-[9px] leading-4 text-rose-500'>没有填写的角色，本轮保持原关系。</p>
                    </div>}
                </div>
            </div>
        </div>}

        <footer className='story-safe-footer shrink-0 px-3 pt-1.5 bg-stone-100/95 backdrop-blur border-t border-slate-200'>
            <div className='max-w-2xl mx-auto'>
                {memoryStatus && <div className='mb-1 flex items-center gap-2 px-1 text-[9px] text-violet-600'><SpinnerGap size={12} className='animate-spin' />{memoryStatus}</div>}
                {sending && isNativeStoryBackgroundRuntime() && <div className='mb-1 flex items-center gap-2 px-1 text-[9px] text-emerald-700'><span className='w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse' />后台续写中，可直接切屏</div>}
                {!sending && !memoryStatus && !input.trim() && pendingRetryInput && <div className='mb-1 px-1 text-[9px] text-violet-600'>上次续写已断开，可以直接点发送重试</div>}
                <div className='rounded-[22px] bg-white border border-slate-200 shadow-sm px-3 py-2'>
                    <textarea
                        value={input}
                        onChange={event => setInput(event.target.value)}
                        onKeyDown={event => {
                            if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                                event.preventDefault();
                                void send();
                            }
                        }}
                        disabled={sending}
                        rows={1}
                        placeholder={pendingRetryInput ? '继续上次中断…' : canWriteOpening ? '留空发送即可开场…' : '写下动作、对白或你希望发生的事…'}
                        className='block w-full min-h-9 max-h-28 overflow-y-auto px-1 py-1 bg-transparent text-[13px] leading-5 resize-none outline-none disabled:opacity-50'
                    />
                    <div className='mt-1 flex items-center gap-1.5'>
                        <button
                            type='button'
                            onClick={() => void send(undefined, true)}
                            disabled={sending || actors.length === 0}
                            className='h-8 min-w-8 px-2 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200 grid place-items-center text-[9px] font-bold active:scale-95 transition-transform disabled:opacity-30'
                            title='按当前节奏继续，不额外替你行动'
                            aria-label='继续当前剧情'
                        >
                            续
                        </button>

                        <div className='flex-1' />

                        <button
                            type='button'
                            onClick={() => setShowQuickPreset(true)}
                            className='relative w-8 h-8 rounded-full bg-rose-50 text-rose-600 border border-rose-200 grid place-items-center active:scale-95 transition-transform'
                            title='本剧情快速预设'
                            aria-label='本剧情快速预设'
                        >
                            <SlidersHorizontal size={15} weight='bold' />
                        </button>

                        {affinityEnabled && <button
                            type='button'
                            onClick={() => setShowAffinityInput(true)}
                            className='relative w-8 h-8 rounded-full bg-amber-50 text-amber-600 border border-amber-200 grid place-items-center active:scale-95 transition-transform'
                            title='本轮关系变化'
                            aria-label='本轮关系变化'
                        >
                            <HeartStraight size={16} weight={filledAffinityActorIds.length > 0 ? 'fill' : 'regular'} />
                            {filledAffinityActorIds.length > 0 && <span className='absolute -right-1 -top-1 min-w-4 h-4 px-1 rounded-full bg-amber-500 text-white text-[8px] grid place-items-center'>{filledAffinityActorIds.length}</span>}
                        </button>}

                        <button
                            type='button'
                            onClick={() => void send()}
                            disabled={sending || (!input.trim() && !pendingRetryInput && !canWriteOpening)}
                            title={!input.trim() && pendingRetryInput ? '继续上次中断' : canWriteOpening && !input.trim() ? '让故事先开场' : '推进'}
                            className='story-send-button w-9 h-9 rounded-full bg-blue-500 text-white grid place-items-center shadow-sm active:scale-95 transition-transform disabled:bg-slate-300 disabled:text-white disabled:opacity-100'
                        >
                            {sending ? <SpinnerGap size={16} className='animate-spin' /> : <ArrowUp size={18} weight='bold' />}
                        </button>
                    </div>
                </div>
            </div>
        </footer>
        {showHeaderMenu && <div className='fixed inset-0 z-[68] flex items-end bg-slate-900/25' onClick={() => setShowHeaderMenu(false)}>
            <div className='story-safe-sheet w-full max-h-[86dvh] overflow-y-auto rounded-t-[28px] bg-stone-100 px-4 pt-3 shadow-2xl' onClick={event => event.stopPropagation()}>
                <div className='mx-auto mb-3 h-1 w-9 rounded-full bg-slate-300' />
                <div className='flex items-start gap-3'>
                    <span className='flex -space-x-1.5 shrink-0'>
                        {mask.avatar ? <TokenImg value={mask.avatar} alt='' className='w-8 h-8 rounded-full object-cover border-2 border-stone-100 relative z-10' /> : <span className='w-8 h-8 rounded-full bg-violet-100 text-violet-700 border-2 border-stone-100 grid place-items-center text-[10px] font-bold relative z-10'>{mask.name.slice(0, 1)}</span>}
                        {actors.slice(0, 2).map(actor => <TokenImg key={actor.id} value={actor.avatar} alt='' className='w-8 h-8 rounded-full object-cover border-2 border-stone-100' />)}
                    </span>
                    <div className='min-w-0 flex-1'>
                        <div className='text-[9px] uppercase tracking-[.2em] font-bold text-violet-500'>Story tools</div>
                        <h2 className='mt-0.5 truncate text-base font-semibold text-slate-800'>{entry.title}</h2>
                        <p className='mt-0.5 truncate text-[9px] text-slate-400'>{youLabel} · {actors.map(actor => actor.name).join('、') || '未选角色'}</p>
                    </div>
                    <button onClick={() => setShowHeaderMenu(false)} className='w-8 h-8 rounded-full grid place-items-center text-slate-400' aria-label='关闭'><X size={16} /></button>
                </div>

                <div className='mt-4 grid grid-cols-2 gap-2'>
                    <button
                        type='button'
                        onClick={() => { setShowHeaderMenu(false); onEdit(); }}
                        className='h-11 rounded-2xl border border-slate-200 bg-white px-3 flex items-center gap-2 text-[10px] font-bold text-slate-700'
                    >
                        <GearSix size={16} className='text-violet-600' />剧情设置
                    </button>
                    <StoryAppearanceButton
                        triggerLabel='外观与排版'
                        className='h-11 w-full rounded-2xl border border-slate-200 bg-white px-3 flex items-center gap-2 text-[10px] font-bold text-slate-700'
                    />
                    <StoryImageSettingsButton
                        entry={entry}
                        onChange={onEntryChange}
                        triggerLabel='剧情配图'
                        triggerClassName='h-11 w-full rounded-2xl border border-slate-200 bg-white px-3 flex items-center gap-2 text-[10px] font-bold text-slate-700'
                    />
                    <button
                        type='button'
                        disabled={exporting || messages.length === 0}
                        onClick={() => void exportStory()}
                        className='h-11 rounded-2xl border border-slate-200 bg-white px-3 flex items-center gap-2 text-[10px] font-bold text-slate-700 disabled:opacity-30'
                    >
                        {exporting ? <SpinnerGap size={16} className='animate-spin text-violet-600' /> : <DownloadSimple size={16} className='text-violet-600' />}导出全文
                    </button>
                    {onOpenVectorMemory && <button
                        type='button'
                        onClick={() => { setShowHeaderMenu(false); onOpenVectorMemory(); }}
                        className='h-11 rounded-2xl border border-slate-200 bg-white px-3 flex items-center gap-2 text-[10px] font-bold text-slate-700'
                    >
                        <Database size={16} className='text-violet-600' />向量记忆
                    </button>}
                    {!entry.writesToCharacterMemory && <button
                        type='button'
                        disabled={memoryCardBusy || messages.length === 0 || memoryActors.length === 0}
                        onClick={() => { setShowHeaderMenu(false); void openSharedFictionMemoryCards(); }}
                        className='h-11 rounded-2xl border border-violet-200 bg-violet-50 px-3 flex items-center gap-2 text-[10px] font-bold text-violet-700 disabled:opacity-30'
                    >
                        {memoryCardBusy ? <SpinnerGap size={16} className='animate-spin' /> : <Sparkle size={16} weight='fill' />}整理记忆卡
                    </button>}
                </div>

                <div className='mt-4 rounded-2xl border border-slate-200 bg-white px-3 py-2.5 grid grid-cols-2 gap-x-5 gap-y-2.5 text-[9px]'>
                    <div><span className='block text-[8px] font-bold text-slate-400'>模式</span><span className='mt-0.5 block truncate text-slate-600'>{entry.writesToCharacterMemory ? '真实时间陪伴' : '虚构剧场'}</span></div>
                    <div><span className='block text-[8px] font-bold text-slate-400'>记忆方式</span><span className='mt-0.5 block truncate text-slate-600'>{entry.writesToCharacterMemory ? '写入角色记忆' : entry.archiveStrategy === 'summary' ? '独立事件盒' : '独立向量分区'}</span></div>
                    <div><span className='block text-[8px] font-bold text-slate-400'>结尾模块</span><span className='mt-0.5 block truncate text-slate-600'>{activeMiniTheater?.name || '未启用小剧场'}</span></div>
                    <div><span className='block text-[8px] font-bold text-slate-400'>上下文</span><span className='mt-0.5 block truncate text-slate-600'>{displayedTokenInfo.count > 0 ? `${displayedTokenInfo.exact ? '实际' : '估算'} ${displayedTokenInfo.count.toLocaleString()} tokens` : '推进时统计'}</span></div>
                    <div><span className='block text-[8px] font-bold text-slate-400'>API 兼容</span><span className={`mt-0.5 block truncate ${entry.forceUserLastMessage ? 'font-semibold text-amber-700' : 'text-slate-600'}`}>{entry.forceUserLastMessage ? '400 兼容模式' : '原生预填'}</span></div>
                    <div><span className='block text-[8px] font-bold text-slate-400'>采样参数</span><span className={`mt-0.5 block truncate ${entry.omitSamplingParams ? 'font-semibold text-amber-700' : 'text-slate-600'}`}>{entry.omitSamplingParams ? '不发送高级参数' : '完整发送'}</span></div>
                </div>
            </div>
        </div>}

        {showQuickPreset && <StoryQuickPresetPanel
            document={effectivePreset.document}
            hasOverride={Boolean(entry.presetOverride)}
            onApply={async document => { await onEntryChange({ ...entry, presetOverride: document, updatedAt: Date.now() }); addToast('快捷预设已应用到本剧情', 'success'); }}
            onReset={async () => { await onEntryChange({ ...entry, presetOverride: undefined, updatedAt: Date.now() }); addToast('已恢复本剧情的原预设', 'info'); }}
            onClose={() => setShowQuickPreset(false)}
        />}
        {messageMenu && <div className='fixed inset-0 z-[70] flex items-end bg-slate-900/25' onClick={() => setMessageMenu(null)}>
            <div className='story-safe-sheet w-full rounded-t-3xl bg-stone-100 px-5 pt-4 shadow-2xl' onClick={event => event.stopPropagation()}>
                <div className='mx-auto mb-4 h-1 w-9 rounded-full bg-slate-300' />
                <div className='flex items-start justify-between gap-4'><div><div className='text-[9px] tracking-[.18em] font-bold text-violet-500'>{messageMenu.role === 'user' ? '你的推进' : '剧场正文'}</div><p className='mt-1 max-w-[75vw] truncate text-xs text-slate-500'>{messageMenu.content.replace(/<[^>]+>/g, ' ').trim()}</p></div><button onClick={() => setMessageMenu(null)} className='w-8 h-8 rounded-full grid place-items-center text-slate-400'><X size={16} /></button></div>
                <div className='mt-5 divide-y divide-slate-200 border-y border-slate-200'><button onClick={() => { setEditingMessage(messageMenu); setEditDraft(messageMenu.content); setMessageMenu(null); }} className='w-full py-4 flex items-center gap-3 text-left'><PencilSimple size={17} className='text-violet-600' /><span><strong className='block text-xs text-slate-700'>编辑这一层</strong><span className='block mt-0.5 text-[9px] text-slate-400'>{entry.writesToCharacterMemory ? '同步修改每位角色收到的镜像内容' : '只修改本剧情沙盒'}</span></span></button><button onClick={() => { setBranchingMessage(messageMenu); setBranchTitle(''); setMessageMenu(null); }} className='w-full py-4 flex items-center gap-3 text-left'><GitBranch size={17} className='text-violet-600' /><span><strong className='block text-xs text-slate-700'>从这里建立分支</strong><span className='block mt-0.5 text-[9px] text-slate-400'>复制这一层及之前的剧情，之后两条世界线互不影响</span></span></button><button onClick={() => { setDeletingMessage(messageMenu); setMessageMenu(null); }} className='w-full py-4 flex items-center gap-3 text-left'><Trash size={17} className='text-rose-500' /><span><strong className='block text-xs text-rose-600'>删除这一层</strong><span className='block mt-0.5 text-[9px] text-slate-400'>不会自动删除相邻的推进或正文</span></span></button></div>
            </div>
        </div>}
        {branchingMessage && <div className='fixed inset-0 z-[76] flex items-end bg-slate-900/30' onClick={() => { if (!branching) { setBranchingMessage(null); setBranchTitle(''); } }}>
            <div className='story-safe-sheet w-full rounded-t-3xl bg-stone-100 px-5 pt-5 shadow-2xl' onClick={event => event.stopPropagation()}>
                <div className='flex items-start justify-between gap-4'>
                    <div><div className='text-[9px] tracking-[.18em] font-bold text-violet-500'>BRANCH TIMELINE</div><h2 className='mt-1 text-lg font-semibold'>从这一层建立新世界线</h2></div>
                    <button disabled={branching} onClick={() => { setBranchingMessage(null); setBranchTitle(''); }} className='w-9 h-9 shrink-0 rounded-full grid place-items-center text-slate-400 disabled:opacity-30'><X size={17} /></button>
                </div>
                <p className='mt-3 text-[10px] leading-5 text-slate-500'>新分支会继承这一层以及之前的角色、身份、世界书、预设和剧情内容；原世界线完全不动。留空会自动命名为“{entry.branchFrom?.rootTitle || entry.title} · 分支 N”。</p>
                {entry.writesToCharacterMemory && <p className='mt-2 rounded-xl bg-amber-50 px-3 py-2 text-[9px] leading-4 text-amber-700'>当前是“真实时间陪伴”。分支属于“如果当时……”的另一条可能性，因此新分支会自动切成虚构剧场，不再写回角色真实记忆。</p>}
                <label className='mt-4 block'><span className='text-[9px] font-bold text-slate-500'>分支名称 · 可选</span><input autoFocus value={branchTitle} onChange={event => setBranchTitle(event.target.value)} placeholder='留空自动命名' className='mt-2 w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm outline-none' /></label>
                <button
                    disabled={branching}
                    onClick={async () => {
                        if (!branchingMessage || branching) return;
                        setBranching(true);
                        try {
                            await onCreateBranch(branchingMessage, branchTitle.trim() || undefined);
                        } finally {
                            setBranching(false);
                        }
                    }}
                    className='mt-4 h-12 w-full rounded-2xl bg-slate-900 text-xs font-bold text-white disabled:opacity-40'
                >
                    {branching ? <SpinnerGap size={17} className='mx-auto animate-spin' /> : '建立分支并进入'}
                </button>
            </div>
        </div>}
        {editingMessage && <div className='fixed inset-0 z-[75] flex items-end overflow-y-auto overscroll-contain bg-slate-900/30' onClick={() => !mutatingMessage && setEditingMessage(null)}>
            <div className='story-safe-sheet story-keyboard-sheet flex max-h-full w-full flex-col overflow-y-auto overscroll-contain rounded-t-3xl bg-stone-100 px-5 pt-5 shadow-2xl' onClick={event => event.stopPropagation()}>
                <div className='flex items-center justify-between'><div><div className='text-[9px] tracking-[.18em] font-bold text-violet-500'>编辑楼层</div><h2 className='mt-1 text-base font-semibold'>{editingMessage.role === 'user' ? '修改这次推进' : '修改这段正文'}</h2></div><button disabled={mutatingMessage} onClick={() => setEditingMessage(null)} className='w-9 h-9 rounded-full grid place-items-center text-slate-400 disabled:opacity-30'><X size={17} /></button></div>
                {editingMessage.role === 'assistant' && <p className='mt-3 text-[9px] leading-4 text-amber-700'>正文中的结构标签负责折叠区渲染；可以修改内容，删改成对标签可能会让该区退化为纯文字。</p>}
                <textarea autoFocus value={editDraft} onChange={event => setEditDraft(event.target.value)} className='mt-4 w-full min-h-48 max-h-[48vh] overflow-y-auto overscroll-contain rounded-2xl border border-slate-200 bg-white p-4 text-xs leading-6 outline-none resize-y' />
                <button disabled={mutatingMessage || !editDraft.trim()} onClick={() => void saveMessageEdit()} className='mt-3 w-full h-12 rounded-2xl bg-slate-900 text-white text-xs font-bold disabled:opacity-30'>{mutatingMessage ? '正在同步…' : '保存这一层'}</button>
            </div>
        </div>}
        {deletingMessage && <div className='fixed inset-0 z-[75] flex items-end bg-slate-900/30' onClick={() => !mutatingMessage && setDeletingMessage(null)}>
            <div className='story-safe-sheet w-full rounded-t-3xl bg-stone-100 px-5 pt-5 shadow-2xl' onClick={event => event.stopPropagation()}>
                <div className='text-[9px] tracking-[.18em] font-bold text-rose-500'>删除楼层</div><h2 className='mt-1 text-lg font-semibold'>只删除选中的这一层？</h2><p className='mt-3 text-[10px] leading-5 text-slate-500'>相邻楼层会保留。{entry.writesToCharacterMemory ? '尚未归档的角色侧镜像会一并删除；已经被总结进长期记忆的旧内容不会被反向改写。' : '本剧情的既有事件盒或向量归档不会被反向改写。'}</p>
                <div className='mt-5 grid grid-cols-2 gap-3'><button disabled={mutatingMessage} onClick={() => setDeletingMessage(null)} className='h-12 rounded-2xl border border-slate-200 bg-white text-xs font-bold text-slate-600 disabled:opacity-30'>取消</button><button disabled={mutatingMessage} onClick={() => void deleteStoryMessage()} className='h-12 rounded-2xl bg-rose-600 text-white text-xs font-bold disabled:opacity-30'>{mutatingMessage ? '正在删除…' : '确认删除'}</button></div>
            </div>
        </div>}
    </div>;
};

export default StoryTheaterSession;
