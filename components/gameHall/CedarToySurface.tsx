import React, { useEffect, useRef, useState } from 'react';
import { ArrowClockwise, ArrowLeft, WarningCircle } from '@phosphor-icons/react';
import { frameFromElement, gameHallWebView, isNativeGameHallWebViewAvailable } from '../../utils/gameHallWebView';
import type { GameHallWebState } from '../../utils/gameHallTypes';

const CEDAR_TOY_URL = 'https://toy.cedarstar.org/';

interface Props { suspended?: boolean; onState?: (state: GameHallWebState) => void; }
const CedarToySurface: React.FC<Props> = ({ suspended = false, onState }) => {
  const hostRef = useRef<HTMLDivElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [nativeError, setNativeError] = useState('');
  const [iframeBlocked, setIframeBlocked] = useState(false);
  const native = isNativeGameHallWebViewAvailable();

  useEffect(() => {
    if (!native || !hostRef.current) return;
    let disposed = false;
    let listener: { remove: () => Promise<void> } | undefined;
    const updateFrame = () => {
      if (!hostRef.current || disposed) return;
      void gameHallWebView.setFrame(frameFromElement(hostRef.current)).catch(() => undefined);
    };
    const observer = new ResizeObserver(updateFrame);
    observer.observe(hostRef.current);
    const start = async () => {
      try {
        await gameHallWebView.create({ url: CEDAR_TOY_URL, frame: frameFromElement(hostRef.current!) });
        await gameHallWebView.setVisible({ visible: !suspended });
        listener = await gameHallWebView.addListener('stateChange', state => onState?.(state));
      } catch (error: any) {
        if (!disposed) setNativeError(error?.message || '原生游戏视图启动失败');
      }
    };
    void start();
    window.addEventListener('resize', updateFrame);
    return () => {
      disposed = true; observer.disconnect(); window.removeEventListener('resize', updateFrame);
      void listener?.remove(); void gameHallWebView.destroy().catch(() => undefined);
    };
  }, [native, onState]);

  useEffect(() => {
    if (!native) return;
    void gameHallWebView.setVisible({ visible: !suspended }).catch(() => undefined);
  }, [native, suspended]);

  const reload = () => native
    ? void gameHallWebView.reload().catch((e: any) => setNativeError(e?.message || '刷新失败'))
    : (() => { if (iframeRef.current) iframeRef.current.src = CEDAR_TOY_URL; })();
  const back = () => native
    ? void gameHallWebView.goBack().catch((e: any) => setNativeError(e?.message || '后退失败'))
    : window.history.back();

  return (
    <section className="relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-white/10 bg-slate-950">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-white/10 bg-slate-900 px-2 text-white">
        <button onClick={back} className="rounded-lg p-2 hover:bg-white/10" aria-label="网页后退"><ArrowLeft size={17} /></button>
        <div className="min-w-0 flex-1 truncate rounded-full bg-black/25 px-3 py-1 text-[11px] text-slate-300">toy.cedarstar.org</div>
        <button onClick={reload} className="rounded-lg p-2 hover:bg-white/10" aria-label="刷新网页"><ArrowClockwise size={17} /></button>
      </div>
      <div ref={hostRef} className="relative min-h-0 flex-1 bg-white">
        {!native && (
          <iframe
            ref={iframeRef}
            title="Cedar Toy"
            src={CEDAR_TOY_URL}
            className="h-full w-full border-0"
            sandbox="allow-forms allow-modals allow-popups allow-same-origin allow-scripts allow-downloads"
            allow="clipboard-read; clipboard-write; fullscreen"
            onLoad={() => { setIframeBlocked(false); onState?.({ url: CEDAR_TOY_URL, title: 'Cedar Toy', loading: false }); }}
            onError={() => setIframeBlocked(true)}
          />
        )}
        {(nativeError || iframeBlocked) && (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-slate-950 p-6 text-center text-slate-200">
            <WarningCircle size={34} className="text-amber-400" />
            <strong>{native ? '原生游戏视图不可用' : '该站点可能不支持嵌入'}</strong>
            <p className="text-xs leading-5 text-slate-400">{nativeError || '请在 Android 版使用原生子 WebView。SullyOS 不会绕过站点的 frame 安全策略。'}</p>
          </div>
        )}
      </div>
    </section>
  );
};
export default CedarToySurface;
