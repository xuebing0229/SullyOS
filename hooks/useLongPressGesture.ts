import { useCallback, useEffect, useRef } from 'react';
import type { MouseEvent, PointerEvent } from 'react';

export interface LongPressMovement {
    deltaX: number;
    deltaY: number;
    pointerType: string;
}

interface UseLongPressGestureOptions<TPayload> {
    onLongPress: (payload: TPayload) => void;
    delay?: number;
    moveTolerance?: number;
    disabled?: boolean;
}

/**
 * Shared long-press recognizer extracted from the main chat gesture.
 *
 * It deliberately owns only recognition: one active pointer, a hold timer,
 * movement cancellation, pointer-cancel cleanup, and context-menu parity.
 * Callers keep their own business action and any extra gestures such as reply swipe.
 */
export const useLongPressGesture = <TElement extends HTMLElement, TPayload>({
    onLongPress,
    delay = 600,
    moveTolerance = 10,
    disabled = false,
}: UseLongPressGestureOptions<TPayload>) => {
    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const startRef = useRef({ x: 0, y: 0 });
    const activePointerIdRef = useRef<number | null>(null);
    const activePointerTypeRef = useRef('');
    const payloadRef = useRef<TPayload | null>(null);
    const suppressClickUntilRef = useRef(0);

    const clearTimer = useCallback(() => {
        if (!timerRef.current) return;
        clearTimeout(timerRef.current);
        timerRef.current = null;
    }, []);

    const resetPointer = useCallback(() => {
        activePointerIdRef.current = null;
        activePointerTypeRef.current = '';
        payloadRef.current = null;
    }, []);

    const beginPress = useCallback((event: PointerEvent<TElement>, payload: TPayload): boolean => {
        if (disabled || event.button !== 0) return false;
        clearTimer();
        activePointerIdRef.current = event.pointerId;
        activePointerTypeRef.current = event.pointerType;
        payloadRef.current = payload;
        startRef.current = { x: event.clientX, y: event.clientY };
        suppressClickUntilRef.current = 0;
        document.getSelection()?.removeAllRanges();

        timerRef.current = setTimeout(() => {
            timerRef.current = null;
            const activePayload = payloadRef.current;
            resetPointer();
            if (activePayload === null) return;
            // Android/WebView may emit a synthetic click/contextmenu after a hold.
            // Suppress only that immediate follow-up, never a later real tap.
            suppressClickUntilRef.current = Date.now() + 800;
            onLongPress(activePayload);
        }, delay);
        return true;
    }, [clearTimer, delay, disabled, onLongPress, resetPointer]);

    const movePress = useCallback((event: PointerEvent<TElement>): LongPressMovement | null => {
        if (activePointerIdRef.current !== event.pointerId) return null;
        const deltaX = event.clientX - startRef.current.x;
        const deltaY = event.clientY - startRef.current.y;
        if (Math.abs(deltaX) > moveTolerance || Math.abs(deltaY) > moveTolerance) {
            clearTimer();
        }
        return {
            deltaX,
            deltaY,
            pointerType: activePointerTypeRef.current,
        };
    }, [clearTimer, moveTolerance]);

    const endPress = useCallback((event: PointerEvent<TElement>): boolean => {
        if (activePointerIdRef.current !== event.pointerId) return false;
        clearTimer();
        resetPointer();
        return true;
    }, [clearTimer, resetPointer]);

    const cancelPress = useCallback(() => {
        clearTimer();
        resetPointer();
    }, [clearTimer, resetPointer]);

    const openContextMenu = useCallback((event: MouseEvent<TElement>, payload: TPayload): boolean => {
        event.preventDefault();
        if (disabled) return false;
        clearTimer();
        resetPointer();
        if (Date.now() <= suppressClickUntilRef.current) return true;
        suppressClickUntilRef.current = Date.now() + 800;
        onLongPress(payload);
        return true;
    }, [clearTimer, disabled, onLongPress, resetPointer]);

    const consumeSuppressedClick = useCallback((): boolean => {
        const suppressed = Date.now() <= suppressClickUntilRef.current;
        suppressClickUntilRef.current = 0;
        return suppressed;
    }, []);

    useEffect(() => () => {
        clearTimer();
        resetPointer();
    }, [clearTimer, resetPointer]);

    return {
        beginPress,
        movePress,
        endPress,
        cancelPress,
        cancelTimer: clearTimer,
        openContextMenu,
        consumeSuppressedClick,
    };
};
