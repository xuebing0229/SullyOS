import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  getClosestGameHallSheetSnap,
  getGameHallSheetHeight,
  getGameHallSheetMetrics,
  getNextGameHallSheetSnap,
  type GameHallSheetSnap,
} from '../../utils/gameHallPanelLayout';

interface Props {
  snap: GameHallSheetSnap;
  onSnapChange: (snap: GameHallSheetSnap) => void;
  children: React.ReactNode;
  className?: string;
  ariaLabel?: string;
}

interface DragState {
  pointerId: number;
  startY: number;
  startHeight: number;
  currentHeight: number;
  moved: boolean;
}

const getViewportHeight = (): number =>
  window.visualViewport?.height || window.innerHeight || 720;

const GameHallBottomSheet: React.FC<Props> = ({
  snap,
  onSnapChange,
  children,
  className = '',
  ariaLabel = '角色讨论面板',
}) => {
  const [viewportHeight, setViewportHeight] = useState(() => getViewportHeight());
  const [dragHeight, setDragHeight] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<DragState | null>(null);
  const suppressClickRef = useRef(false);

  const metrics = useMemo(
    () => getGameHallSheetMetrics(viewportHeight),
    [viewportHeight],
  );
  const settledHeight = getGameHallSheetHeight(snap, metrics);
  const renderedHeight = dragHeight ?? settledHeight;

  useEffect(() => {
    const updateViewportHeight = () => setViewportHeight(getViewportHeight());
    window.addEventListener('resize', updateViewportHeight);
    window.visualViewport?.addEventListener('resize', updateViewportHeight);
    return () => {
      window.removeEventListener('resize', updateViewportHeight);
      window.visualViewport?.removeEventListener('resize', updateViewportHeight);
    };
  }, []);

  // A keyboard or rotation can shrink the available viewport while the sheet
  // is open. Re-snap instead of leaving a stale pixel height on screen.
  useEffect(() => {
    setDragHeight(null);
  }, [metrics.collapsed, metrics.half, metrics.expanded]);

  const finishDrag = useCallback(() => {
    const drag = dragRef.current;
    if (!drag) return;

    const heightDelta = drag.currentHeight - drag.startHeight;
    let next = getClosestGameHallSheetSnap(drag.currentHeight, metrics);

    // A deliberate flick should advance at least one stop even when it ends
    // close to the starting height.
    if (Math.abs(heightDelta) >= 44) {
      next = getNextGameHallSheetSnap(snap, heightDelta > 0 ? 'up' : 'down');
      const closest = getClosestGameHallSheetSnap(drag.currentHeight, metrics);
      if (
        Math.abs(drag.currentHeight - metrics[closest]) <
        Math.abs(drag.currentHeight - metrics[next])
      ) {
        next = closest;
      }
    }

    if (drag.moved) {
      suppressClickRef.current = true;
      window.setTimeout(() => {
        suppressClickRef.current = false;
      }, 0);
    }
    dragRef.current = null;
    setDragging(false);
    setDragHeight(null);
    onSnapChange(next);
  }, [metrics, onSnapChange, snap]);

  const handlePointerDown = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startHeight: renderedHeight,
      currentHeight: renderedHeight,
      moved: false,
    };
    setDragging(true);
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const delta = drag.startY - event.clientY;
    const nextHeight = Math.min(
      Math.max(drag.startHeight + delta, metrics.collapsed),
      metrics.expanded,
    );
    drag.currentHeight = nextHeight;
    drag.moved = drag.moved || Math.abs(delta) > 5;
    setDragHeight(nextHeight);
  };

  const handlePointerUp = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // Pointer capture may already have been released by the browser.
    }
    finishDrag();
  };

  const handleHandleClick = () => {
    // Pointer up fires a click after dragging. Ignore that synthetic click.
    if (suppressClickRef.current) return;
    if (snap === 'collapsed') onSnapChange('half');
    else if (snap === 'expanded') onSnapChange('half');
    else onSnapChange('collapsed');
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      onSnapChange(getNextGameHallSheetSnap(snap, 'up'));
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      onSnapChange(getNextGameHallSheetSnap(snap, 'down'));
    } else if (event.key === 'Home') {
      event.preventDefault();
      onSnapChange('collapsed');
    } else if (event.key === 'End') {
      event.preventDefault();
      onSnapChange('expanded');
    }
  };

  return (
    <section
      className={`flex shrink-0 flex-col overflow-hidden rounded-2xl border border-white/10 bg-slate-900/95 shadow-2xl ${className}`}
      style={{
        height: `${renderedHeight}px`,
        transition: dragging ? 'none' : 'height 180ms ease-out',
        willChange: dragging ? 'height' : undefined,
      }}
      aria-label={ariaLabel}
      data-snap={snap}
    >
      <button
        type="button"
        className="flex h-5 w-full shrink-0 touch-none select-none items-center justify-center"
        style={{ touchAction: 'none' }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={finishDrag}
        onClick={handleHandleClick}
        onKeyDown={handleKeyDown}
        role="slider"
        aria-orientation="vertical"
        aria-label="拖动或点击调整角色讨论面板高度"
        aria-valuemin={metrics.collapsed}
        aria-valuemax={metrics.expanded}
        aria-valuenow={Math.round(renderedHeight)}
        aria-valuetext={snap === 'collapsed' ? '已收起' : snap === 'half' ? '半展开' : '已展开'}
      >
        <span className="h-1 w-10 rounded-full bg-white/30" />
      </button>
      {children}
    </section>
  );
};

export default GameHallBottomSheet;
