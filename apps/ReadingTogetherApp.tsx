import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, UploadSimple, BookOpenText, Sparkle, PenNib, Trash } from '@phosphor-icons/react';
import { useOS } from '../context/OSContext';
import { DB } from '../utils/db';
import type {
  AppMemoryCandidate,
  ReadingProject,
  ReadingRecord,
  ReadingRecordType,
  ReadingStylePreset,
  ReadingWriting,
  ReadingWritingType,
} from '../types';
import { callAppModel, sliceLocalMessages } from '../utils/appContext';
import { generateAppMemoryCandidates } from '../utils/appMemoryBridge';
import AppMemoryCandidatePanel from '../components/AppMemoryCandidatePanel';
import {
  parseReadingDocument,
  readingContextAround,
} from '../utils/reading/documentParser';

type View = 'shelf' | 'reader' | 'writing';
const uid = (p: string) =>
  `${p}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

const defaultStyles: ReadingStylePreset[] = [
  {
    id: 'reading_style_plain',
    name: '清淡叙事',
    prompt: '文字克制、清晰、留白适中，不堆砌修辞。',
    target: 'all',
    createdAt: 0,
    updatedAt: 0,
  },
  {
    id: 'reading_style_literary',
    name: '文学感',
    prompt: '注重意象、节奏、心理暗流和句子余韵，但保持自然可读。',
    target: 'writing',
    createdAt: 0,
    updatedAt: 0,
  },
  {
    id: 'reading_style_tension',
    name: '关系张力',
    prompt: '关注未说出口的情绪、试探、克制、靠近与回避。',
    target: 'writing',
    createdAt: 0,
    updatedAt: 0,
  },
];

const ReadingTogetherApp: React.FC = () => {
  const {
    closeApp,
    characters,
    userProfile,
    groups,
    apiConfig,
    realtimeConfig,
    memoryPalaceConfig,
    remoteVectorConfig,
    updateCharacter,
    addToast,
    registerBackHandler,
  } = useOS();

  const [view, setView] = useState<View>('shelf');
  const [projects, setProjects] = useState<ReadingProject[]>([]);
  const [project, setProject] = useState<ReadingProject | null>(null);
  const [records, setRecords] = useState<ReadingRecord[]>([]);
  const [styles, setStyles] = useState<ReadingStylePreset[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const [question, setQuestion] = useState('');
  const [candidates, setCandidates] = useState<AppMemoryCandidate[]>([]);
  const [showMemory, setShowMemory] = useState(false);
  const [writingType, setWritingType] = useState<ReadingWritingType>('free');
  const [writingPrompt, setWritingPrompt] = useState('');
  const [writingTitle, setWritingTitle] = useState('');
  const [writingResult, setWritingResult] = useState('');
  const abortRef = useRef<AbortController | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const char = useMemo(
    () => characters.find((v) => v.id === project?.charId) || null,
    [characters, project?.charId],
  );

  const reloadShelf = useCallback(async () => {
    const [p, s] = await Promise.all([
      DB.getReadingProjects(),
      DB.getReadingStylePresets(),
    ]);
    setProjects(p);
    if (s.length === 0) {
      await DB.saveReadingStylePresets(defaultStyles);
      setStyles(defaultStyles);
    } else {
      setStyles(s);
    }
  }, []);

  useEffect(() => {
    void reloadShelf();
    return () => abortRef.current?.abort();
  }, [reloadShelf]);

  useEffect(() => {
    return registerBackHandler(() => {
      if (showMemory) {
        setShowMemory(false);
        return true;
      }
      if (view !== 'shelf') {
        setView('shelf');
        setProject(null);
        return true;
      }
      return false;
    });
  }, [registerBackHandler, showMemory, view]);

  const importFile = async (file: File) => {
    const firstChar = characters[0];
    if (!firstChar) {
      addToast('请先创建角色');
      return;
    }
    const ext = file.name.toLowerCase().endsWith('.md') ? 'md' : 'txt';
    const raw = await file.text();
    const segments = parseReadingDocument(raw);
    if (segments.length === 0) {
      addToast('文件中没有可读取的文字', 'error');
      return;
    }
    const next: ReadingProject = {
      id: uid('readproj'),
      title: file.name.replace(/\.(txt|md)$/i, ''),
      sourceName: file.name,
      format: ext,
      charId: firstChar.id,
      segments,
      progressIndex: 0,
      localContextLimit: 30,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    await DB.saveReadingProject(next);
    await reloadShelf();
    await openProject(next);
  };

  const openProject = async (p: ReadingProject) => {
    setProject(p);
    setSelectedIndex(Math.min(p.progressIndex || 0, p.segments.length - 1));
    setRecords(await DB.getReadingRecordsByProject(p.id));
    setCandidates(
      await DB.getAppMemoryCandidatesBySource(p.charId, 'reading_together', p.id),
    );
    setView('reader');
  };

  const updateProgress = async (index: number) => {
    if (!project) return;
    const next = { ...project, progressIndex: index, updatedAt: Date.now() };
    setProject(next);
    setSelectedIndex(index);
    await DB.saveReadingProject(next);
  };

  const saveRecord = async (record: ReadingRecord) => {
    await DB.saveReadingRecord(record);
    setRecords((old) => [...old, record]);
  };

  const selectedSegment = project?.segments[selectedIndex];

  const runReadingAction = async (
    type: 'annotation' | 'inner_voice' | 'ask',
  ) => {
    if (!project || !char || !selectedSegment || busy) return;
    if (type === 'ask' && !question.trim()) {
      addToast('先写下你要问 TA 的问题');
      return;
    }

    setBusy(true);
    abortRef.current?.abort();
    abortRef.current = new AbortController();
    try {
      const local = sliceLocalMessages(
        records.filter((v) => v.projectId === project.id),
        project.localContextLimit,
      );
      const actionPrompt =
        type === 'annotation'
          ? '请对选中段落写一条有内容的边读边评。不要总结全文，要像真的一起读书时留下的批注。'
          : type === 'inner_voice'
            ? '请写出你读到这段时没有直接说出口的真实心声。保持角色本人，不要替用户发言。'
            : `用户问你：“${question.trim()}”。结合这段文字和你们过去的关系自然回答。`;

      const content = await callAppModel({
        sourceApp: 'reading_together',
        purpose: 'App 内生成',
        char,
        userProfile,
        groups,
        apiConfig,
        realtimeConfig,
        sceneHint: `${project.title} 第${selectedIndex + 1}段；${question || type}`,
        signal: abortRef.current.signal,
        appSystemPrompt: `
你正在“素页同栖”里和用户共同阅读《${project.title}》。
你拥有主聊天的全部连续记忆、关系和世界书。
只讨论真实提供给你的段落，不虚构原文中不存在的内容。
当前任务：${actionPrompt}
`,
        localMessages: [
          ...local.map((v) => ({
            role: v.role,
            content: `[${v.type}] ${v.content}`,
          })),
          {
            role: 'user',
            content:
              `${readingContextAround(project.segments, selectedIndex, 1)}\n\n` +
              (type === 'ask' ? `[用户的问题]\n${question.trim()}` : ''),
          },
        ],
      });

      if (type === 'ask') {
        await saveRecord({
          id: uid('readrec'),
          projectId: project.id,
          segmentId: selectedSegment.id,
          charId: char.id,
          type: 'question',
          role: 'user',
          content: question.trim(),
          createdAt: Date.now(),
        });
      }
      await saveRecord({
        id: uid('readrec'),
        projectId: project.id,
        segmentId: selectedSegment.id,
        charId: char.id,
        type:
          type === 'ask'
            ? 'answer'
            : (type as Extract<ReadingRecordType, 'annotation' | 'inner_voice'>),
        role: 'assistant',
        content,
        createdAt: Date.now(),
      });
      if (type === 'ask') setQuestion('');
    } catch (error: any) {
      if (error?.name !== 'AbortError') {
        addToast(error?.message || '生成失败', 'error');
      }
    } finally {
      setBusy(false);
    }
  };

  const makeMemoryCandidates = async () => {
    if (!project || !char || busy) return;
    setBusy(true);
    abortRef.current?.abort();
    abortRef.current = new AbortController();
    try {
      const transcript = records
        .map((v) => `[第${project.segments.findIndex(s=>s.id===v.segmentId)+1}段·${v.type}] ${v.role==='user'?userProfile.name:char.name}：${v.content}`)
        .join('\n');
      const rows = await generateAppMemoryCandidates({
        sourceApp: 'reading_together',
        sourceRecordId: project.id,
        char,
        userProfile,
        groups,
        apiConfig,
        realtimeConfig,
        transcript,
        sceneHint: `与用户共读《${project.title}》`,
        signal: abortRef.current.signal,
      });
      setCandidates((old) => [...old, ...rows]);
      setShowMemory(true);
      if (rows.length === 0) addToast('目前没有值得进入主记忆的内容');
    } catch (error: any) {
      if (error?.name !== 'AbortError') {
        addToast(error?.message || '整理记忆失败', 'error');
      }
    } finally {
      setBusy(false);
    }
  };

  const generateWriting = async () => {
    if (!char || busy || !writingPrompt.trim()) return;
    setBusy(true);
    abortRef.current?.abort();
    abortRef.current = new AbortController();
    try {
      const style = styles.find((v) => v.id === project?.stylePresetId);
      const previous =
        writingType === 'continue' ? writingResult.trim() : '';
      const content = await callAppModel({
        sourceApp: 'reading_together',
        purpose: 'App 内生成',
        char,
        userProfile,
        groups,
        apiConfig,
        realtimeConfig,
        sceneHint: `素页同栖共同写作：${writingTitle || writingPrompt}`,
        signal: abortRef.current.signal,
        appSystemPrompt: `
你正在“素页同栖”的执笔成篇中写作。
类型：${writingType}
${style ? `文风要求：${style.prompt}` : ''}
保持角色对用户的连续认知，但不要把系统资料生硬写进正文。
${writingType === 'user_char_story' ? `故事主角是 ${userProfile.name} 与 ${char.name}。` : ''}
`,
        localMessages: [
          {
            role: 'user',
            content:
              `[写作要求]\n${writingPrompt.trim()}\n\n` +
              (previous ? `[需要继续扩写的正文]\n${previous}` : ''),
          },
        ],
      });
      setWritingResult(content);
      const item: ReadingWriting = {
        id: uid('readwrite'),
        projectId: project?.id,
        charId: char.id,
        type: writingType,
        title: writingTitle.trim() || '未命名作品',
        prompt: writingPrompt.trim(),
        content,
        stylePresetId: project?.stylePresetId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      await DB.saveReadingWriting(item);
      addToast('已保存到生成历史', 'success');
    } catch (error: any) {
      if (error?.name !== 'AbortError') addToast(error?.message || '写作失败', 'error');
    } finally {
      setBusy(false);
    }
  };

  if (view === 'writing') {
    return (
      <div className="w-full h-full overflow-auto bg-[#f7f4ed]">
        <header style={{padding:'calc(var(--safe-top) + 14px) 16px 12px',display:'flex',gap:12}}>
          <button onClick={()=>setView(project?'reader':'shelf')}><ArrowLeft size={22}/></button>
          <strong style={{flex:1}}>执笔成篇</strong>
        </header>
        <main style={{padding:16,display:'grid',gap:12}}>
          <select value={writingType} onChange={e=>setWritingType(e.target.value as ReadingWritingType)}>
            <option value="free">自由生成</option>
            <option value="user_char_story">用户 × 角色故事</option>
            <option value="continue">继续扩写</option>
          </select>
          <input placeholder="标题" value={writingTitle} onChange={e=>setWritingTitle(e.target.value)}/>
          <textarea rows={7} placeholder="写作要求" value={writingPrompt} onChange={e=>setWritingPrompt(e.target.value)}/>
          {writingResult && <textarea rows={18} value={writingResult} onChange={e=>setWritingResult(e.target.value)}/>}
          <button disabled={busy||!writingPrompt.trim()} onClick={generateWriting}
            style={{padding:14,borderRadius:14,background:'#7c3aed',color:'#fff'}}>
            {busy?'正在写…':'生成并保存'}
          </button>
        </main>
      </div>
    );
  }

  if (view === 'reader' && project && selectedSegment) {
    const segRecords = records.filter(v=>v.segmentId===selectedSegment.id);
    return (
      <div className="w-full h-full flex flex-col bg-[#fbf8f0]" style={{position:'relative'}}>
        <header style={{padding:'calc(var(--safe-top) + 12px) 14px 10px',display:'flex',gap:10,alignItems:'center'}}>
          <button onClick={()=>setView('shelf')}><ArrowLeft size={22}/></button>
          <div style={{flex:1,minWidth:0}}><strong>{project.title}</strong><div style={{fontSize:11,color:'#78716c'}}>第 {selectedIndex+1}/{project.segments.length} 段 · {char?.name}</div></div>
          <button onClick={()=>setView('writing')}><PenNib size={20}/></button>
          <button onClick={makeMemoryCandidates} disabled={busy}><Sparkle size={20}/></button>
        </header>

        <div style={{display:'flex',gap:6,padding:'0 12px 8px',overflowX:'auto'}}>
          {project.segments.map((seg,i)=>(
            <button key={seg.id} onClick={()=>updateProgress(i)}
              style={{flex:'0 0 auto',padding:'5px 9px',borderRadius:999,background:i===selectedIndex?'#7c3aed':'#ede9fe',color:i===selectedIndex?'#fff':'#5b21b6'}}>
              {i+1}
            </button>
          ))}
        </div>

        <main style={{flex:1,overflow:'auto',padding:16}}>
          <article style={{fontFamily:'serif',fontSize:17,lineHeight:1.95,whiteSpace:'pre-wrap',color:'#292524'}}>
            {selectedSegment.text}
          </article>
          <div style={{display:'flex',gap:8,margin:'18px 0',flexWrap:'wrap'}}>
            <button disabled={busy} onClick={()=>runReadingAction('annotation')}>批注</button>
            <button disabled={busy} onClick={()=>runReadingAction('inner_voice')}>心声</button>
          </div>
          <div style={{display:'flex',gap:8}}>
            <input style={{flex:1}} placeholder="问 TA 关于这段的事…" value={question} onChange={e=>setQuestion(e.target.value)}/>
            <button disabled={busy||!question.trim()} onClick={()=>runReadingAction('ask')}>问 TA</button>
          </div>
          <div style={{display:'grid',gap:10,marginTop:18}}>
            {segRecords.map(r=>(
              <div key={r.id} style={{padding:12,borderRadius:14,background:r.role==='user'?'#ede9fe':'#fff',border:'1px solid #e7e5e4'}}>
                <div style={{fontSize:11,color:'#78716c',marginBottom:5}}>{r.type}</div>
                <div style={{whiteSpace:'pre-wrap',lineHeight:1.7}}>{r.content}</div>
              </div>
            ))}
            {busy && <div style={{color:'#78716c'}}>正在阅读…</div>}
          </div>
        </main>

        {showMemory && char && (
          <AppMemoryCandidatePanel
            candidates={candidates}
            char={char}
            userProfile={userProfile}
            memoryPalaceConfig={memoryPalaceConfig}
            remoteVectorConfig={remoteVectorConfig}
            updateCharacter={updateCharacter}
            addToast={addToast}
            onChange={setCandidates}
            onClose={()=>setShowMemory(false)}
          />
        )}
      </div>
    );
  }

  return (
    <div className="w-full h-full overflow-auto bg-[#f7f4ed]">
      <input ref={fileRef} type="file" accept=".txt,.md,text/plain,text/markdown" hidden
        onChange={e=>{const f=e.target.files?.[0];if(f)void importFile(f);e.currentTarget.value='';}}/>
      <header style={{padding:'calc(var(--safe-top) + 14px) 16px 12px',display:'flex',gap:12,alignItems:'center'}}>
        <button onClick={closeApp}><ArrowLeft size={22}/></button>
        <div style={{flex:1}}><h1 style={{fontSize:20,fontWeight:800}}>素页同栖</h1><div style={{fontSize:12,color:'#78716c'}}>共读、批注、心声与共同写作</div></div>
        <button onClick={()=>setView('writing')}><PenNib size={21}/></button>
        <button onClick={()=>fileRef.current?.click()}><UploadSimple size={22}/></button>
      </header>
      <main style={{padding:16,display:'grid',gap:12}}>
        {projects.length===0 && <div style={{padding:50,textAlign:'center',color:'#78716c'}}><BookOpenText size={42}/><div>导入 TXT 或 Markdown 开始共读</div></div>}
        {projects.map(p=>(
          <div key={p.id} style={{padding:14,borderRadius:18,background:'#fff',boxShadow:'0 8px 24px rgba(0,0,0,.06)'}}>
            <div style={{display:'flex',gap:10,alignItems:'center'}}>
              <button style={{flex:1,textAlign:'left'}} onClick={()=>openProject(p)}>
                <strong>{p.title}</strong>
                <div style={{fontSize:12,color:'#78716c',marginTop:5}}>
                  {p.progressIndex+1}/{p.segments.length} · {characters.find(c=>c.id===p.charId)?.name||'角色已删除'}
                </div>
              </button>
              <button onClick={async()=>{await DB.deleteReadingProject(p.id);await reloadShelf();}}><Trash size={18}/></button>
            </div>
          </div>
        ))}
      </main>
    </div>
  );
};

export default ReadingTogetherApp;
