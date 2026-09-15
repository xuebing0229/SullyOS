from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label} match count: {count}")
    return text.replace(old, new, 1)


# ---------------------------------------------------------------------------
# Shared recognizer: extracted from the main chat's proven message gesture.
# Business actions stay with their callers (chat menu, story voice refresh, etc.).
# ---------------------------------------------------------------------------
hook = Path("hooks/useLongPressGesture.ts")
if hook.exists():
    raise SystemExit("hooks/useLongPressGesture.ts already exists; refusing to overwrite")

hook.write_text(
    """import { useCallback, useEffect, useRef } from 'react';
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
""",
    encoding="utf-8",
)


# ---------------------------------------------------------------------------
# Main chat: consume the shared recognizer, preserve reply-swipe behavior.
# ---------------------------------------------------------------------------
path = Path("components/chat/MessageItem.tsx")
text = path.read_text(encoding="utf-8")
text = replace_once(
    text,
    "import React, { useEffect, useRef, useState } from 'react';\n",
    "import React, { useEffect, useRef, useState } from 'react';\nimport { useLongPressGesture } from '../../hooks/useLongPressGesture';\n",
    "MessageItem import",
)

old_chat = """    const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const startPos = useRef({ x: 0, y: 0 });
    const activePointerId = useRef<number | null>(null);
    const activePointerType = useRef<string>('');
    const replyGestureActiveRef = useRef(false);
    const replyReadyRef = useRef(false);
    const suppressNextClickRef = useRef(false);

    const styleConfig = isUser ? activeTheme.user : activeTheme.ai;
    // 气泡底纹画在 CSS background-image 上，拿不到 <img> 那层的自动解析，只能在顶层
    // 无条件解析一次（hook 不能进条件分支）。挂件/头像挂件走 TokenImg，各自组件内解析。
    const bubbleBgUrl = useBlobRefUrl(styleConfig.backgroundImage);
    const [showVoiceText, setShowVoiceText] = useState(false);
    const [openingCollaborationFile, setOpeningCollaborationFile] = useState(false);
    const [replyOffset, setReplyOffset] = useState(0);
    const [isReplyGestureActive, setIsReplyGestureActive] = useState(false);
    const [isReplyReady, setIsReplyReady] = useState(false);

    const clearLongPressTimer = () => {
        if (!longPressTimer.current) return;
        clearTimeout(longPressTimer.current);
        longPressTimer.current = null;
    };

    const resetReplyGesture = () => {
        replyGestureActiveRef.current = false;
        replyReadyRef.current = false;
        setIsReplyGestureActive(false);
        setIsReplyReady(false);
        setReplyOffset(0);
    };

    const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
        if (selectionMode || e.button !== 0) return;
        activePointerId.current = e.pointerId;
        activePointerType.current = e.pointerType;
        suppressNextClickRef.current = false;
        startPos.current = { x: e.clientX, y: e.clientY };
        document.getSelection()?.removeAllRanges();

        clearLongPressTimer();
        longPressTimer.current = setTimeout(() => {
            longPressTimer.current = null;
            activePointerId.current = null;
            activePointerType.current = '';
            resetReplyGesture();
            suppressNextClickRef.current = true;
            onLongPress(m);
        }, 600);
    };

    const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
        if (activePointerId.current !== e.pointerId) return;
        const diffX = e.clientX - startPos.current.x;
        const diffY = e.clientY - startPos.current.y;
        const isTouchPointer = activePointerType.current !== 'mouse';

        if (!replyGestureActiveRef.current) {
            const startsReplySwipe = isTouchPointer
                && !isSystem
                && diffX < -8
                && Math.abs(diffX) > Math.abs(diffY);
            if (!startsReplySwipe) {
                if (Math.abs(diffX) > 10 || Math.abs(diffY) > 10) clearLongPressTimer();
                return;
            }
            clearLongPressTimer();
            replyGestureActiveRef.current = true;
            setIsReplyGestureActive(true);
        }

        if (Math.abs(diffY) > 24 && Math.abs(diffY) > Math.abs(diffX)) {
            resetReplyGesture();
            return;
        }

        e.preventDefault();
        document.getSelection()?.removeAllRanges();
        const nextOffset = Math.max(-72, Math.min(0, diffX));
        const nextReady = nextOffset <= -52;
        replyReadyRef.current = nextReady;
        setReplyOffset(nextOffset);
        setIsReplyReady(nextReady);
    };

    const handlePointerEnd = (e: React.PointerEvent<HTMLDivElement>) => {
        if (activePointerId.current !== e.pointerId) return;
        clearLongPressTimer();
        activePointerId.current = null;
        activePointerType.current = '';

        const shouldReply = replyGestureActiveRef.current && replyReadyRef.current;
        resetReplyGesture();

        if (shouldReply) onReply(m);
    };

    const handlePointerCancel = () => {
        clearLongPressTimer();
        activePointerId.current = null;
        activePointerType.current = '';
        resetReplyGesture();
    };

    const handleClick = (e: React.MouseEvent) => {
        if (selectionMode) {
            e.stopPropagation();
            e.preventDefault();
            onToggleSelect(m.id);
        }
    };

    const interactionProps = {
        onPointerDown: handlePointerDown,
        onPointerUp: handlePointerEnd,
        onPointerMove: handlePointerMove,
        onPointerCancel: handlePointerCancel,
        onContextMenu: (e: React.MouseEvent) => {
            e.preventDefault();
            if (selectionMode || replyGestureActiveRef.current) return;
            clearLongPressTimer();
            activePointerId.current = null;
            activePointerType.current = '';
            resetReplyGesture();
            suppressNextClickRef.current = true;
            onLongPress(m);
        },
        onDragStart: (e: React.DragEvent) => e.preventDefault(),
        onClick: handleClick
    };
"""

new_chat = """    const replyGestureActiveRef = useRef(false);
    const replyReadyRef = useRef(false);

    const styleConfig = isUser ? activeTheme.user : activeTheme.ai;
    // 气泡底纹画在 CSS background-image 上，拿不到 <img> 那层的自动解析，只能在顶层
    // 无条件解析一次（hook 不能进条件分支）。挂件/头像挂件走 TokenImg，各自组件内解析。
    const bubbleBgUrl = useBlobRefUrl(styleConfig.backgroundImage);
    const [showVoiceText, setShowVoiceText] = useState(false);
    const [openingCollaborationFile, setOpeningCollaborationFile] = useState(false);
    const [replyOffset, setReplyOffset] = useState(0);
    const [isReplyGestureActive, setIsReplyGestureActive] = useState(false);
    const [isReplyReady, setIsReplyReady] = useState(false);

    const resetReplyGesture = () => {
        replyGestureActiveRef.current = false;
        replyReadyRef.current = false;
        setIsReplyGestureActive(false);
        setIsReplyReady(false);
        setReplyOffset(0);
    };

    const messagePressGesture = useLongPressGesture<HTMLDivElement, Message>({
        delay: 600,
        moveTolerance: 10,
        disabled: selectionMode,
        onLongPress: message => {
            resetReplyGesture();
            onLongPress(message);
        },
    });

    const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
        messagePressGesture.beginPress(e, m);
    };

    const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
        const movement = messagePressGesture.movePress(e);
        if (!movement) return;
        const { deltaX: diffX, deltaY: diffY, pointerType } = movement;
        const isTouchPointer = pointerType !== 'mouse';

        if (!replyGestureActiveRef.current) {
            const startsReplySwipe = isTouchPointer
                && !isSystem
                && diffX < -8
                && Math.abs(diffX) > Math.abs(diffY);
            if (!startsReplySwipe) return;
            messagePressGesture.cancelTimer();
            replyGestureActiveRef.current = true;
            setIsReplyGestureActive(true);
        }

        if (Math.abs(diffY) > 24 && Math.abs(diffY) > Math.abs(diffX)) {
            resetReplyGesture();
            return;
        }

        e.preventDefault();
        document.getSelection()?.removeAllRanges();
        const nextOffset = Math.max(-72, Math.min(0, diffX));
        const nextReady = nextOffset <= -52;
        replyReadyRef.current = nextReady;
        setReplyOffset(nextOffset);
        setIsReplyReady(nextReady);
    };

    const handlePointerEnd = (e: React.PointerEvent<HTMLDivElement>) => {
        if (!messagePressGesture.endPress(e)) return;
        const shouldReply = replyGestureActiveRef.current && replyReadyRef.current;
        resetReplyGesture();
        if (shouldReply) onReply(m);
    };

    const handlePointerCancel = () => {
        messagePressGesture.cancelPress();
        resetReplyGesture();
    };

    const handleClick = (e: React.MouseEvent) => {
        if (selectionMode) {
            e.stopPropagation();
            e.preventDefault();
            onToggleSelect(m.id);
        }
    };

    const interactionProps = {
        onPointerDown: handlePointerDown,
        onPointerUp: handlePointerEnd,
        onPointerMove: handlePointerMove,
        onPointerCancel: handlePointerCancel,
        onContextMenu: (e: React.MouseEvent<HTMLDivElement>) => {
            if (selectionMode || replyGestureActiveRef.current) {
                e.preventDefault();
                return;
            }
            resetReplyGesture();
            messagePressGesture.openContextMenu(e, m);
        },
        onDragStart: (e: React.DragEvent) => e.preventDefault(),
        onClick: handleClick
    };
"""
text = replace_once(text, old_chat, new_chat, "MessageItem gesture block")
path.write_text(text, encoding="utf-8")


# ---------------------------------------------------------------------------
# Story dialogue + story message menus: same shared recognizer.
# Light tap playback returns to a normal click like main chat's voice bar.
# ---------------------------------------------------------------------------
path = Path("components/date/story/StoryTheaterSession.tsx")
text = path.read_text(encoding="utf-8")
text = replace_once(
    text,
    "import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';\n",
    "import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';\nimport { useLongPressGesture } from '../../../hooks/useLongPressGesture';\n",
    "Story import",
)

start_marker = "const StoryOutput: React.FC<"
inline_marker = "    const inlineVoice = parseStoryVoiceMessage(content);"
start = text.find(start_marker)
inline = text.find(inline_marker, start)
if start < 0 or inline < 0:
    raise SystemExit("StoryOutput gesture section not found")
old_head = text[start:inline]
if "dialoguePressTimerRef" not in old_head or "finishDialoguePress" not in old_head:
    raise SystemExit("StoryOutput gesture section shape changed")
new_head = """interface StoryDialoguePressTarget {
    dialogueIndex: number;
    text: string;
    speaker: StoryVoiceSpeaker;
}

const StoryOutput: React.FC<{ content: string; onChoose?: (text: string) => void; affinityInputs?: StoryAffinityInput[]; voiceSpeakers?: Array<StoryVoiceSpeaker | null>; onDialogueClick?: (dialogueIndex: number, text: string, speaker?: StoryVoiceSpeaker) => void; onDialogueLongPress?: (dialogueIndex: number, text: string, speaker: StoryVoiceSpeaker) => void }> = ({ content, onChoose, affinityInputs = [], voiceSpeakers, onDialogueClick, onDialogueLongPress }) => {
    const appearance = useStoryTheaterAppearance();
    const dialoguePress = useLongPressGesture<HTMLSpanElement, StoryDialoguePressTarget>({
        delay: 600,
        moveTolerance: 10,
        onLongPress: target => onDialogueLongPress?.(target.dialogueIndex, target.text, target.speaker),
    });
"""
text = text[:start] + new_head + text[inline:]

old_span = """                                    onClick={segment.kind === 'dialogue' && segment.dialogueIndex !== undefined && onDialogueClick
                                        ? event => {
                                            event.stopPropagation();
                                            if (suppressDialogueClickRef.current) {
                                                suppressDialogueClickRef.current = false;
                                                event.preventDefault();
                                                return;
                                            }
                                            onDialogueClick?.(segment.dialogueIndex as number, segment.text, segment.speaker);
                                        }
                                        : undefined}
                                    onPointerDown={segment.kind === 'dialogue' && segment.dialogueIndex !== undefined && onDialogueClick
                                        ? event => beginDialoguePress(event, segment.dialogueIndex as number, segment.text, segment.speaker)
                                        : undefined}
                                    onPointerMove={segment.kind === 'dialogue' && segment.dialogueIndex !== undefined && onDialogueClick ? moveDialoguePress : undefined}
                                    onPointerUp={segment.kind === 'dialogue' && segment.dialogueIndex !== undefined && onDialogueClick
                                        ? event => finishDialoguePress(event, segment.dialogueIndex as number, segment.text, segment.speaker)
                                        : undefined}
                                    onPointerCancel={segment.kind === 'dialogue' && segment.dialogueIndex !== undefined && onDialogueClick ? abortDialoguePress : undefined}
                                    onPointerLeave={segment.kind === 'dialogue' && segment.dialogueIndex !== undefined && onDialogueClick ? abortDialoguePress : undefined}
                                    onContextMenu={segment.kind === 'dialogue' && (segment.speaker === 'char' || segment.speaker === 'user') && onDialogueLongPress
                                        ? event => { event.preventDefault(); event.stopPropagation(); }
                                        : undefined}
"""
new_span = """                                    onClick={segment.kind === 'dialogue' && segment.dialogueIndex !== undefined && onDialogueClick
                                        ? event => {
                                            event.stopPropagation();
                                            if (dialoguePress.consumeSuppressedClick()) {
                                                event.preventDefault();
                                                return;
                                            }
                                            onDialogueClick(segment.dialogueIndex as number, segment.text, segment.speaker);
                                        }
                                        : undefined}
                                    onPointerDown={segment.kind === 'dialogue' && segment.dialogueIndex !== undefined && onDialogueClick
                                        ? event => {
                                            event.stopPropagation();
                                            if ((segment.speaker === 'char' || segment.speaker === 'user') && onDialogueLongPress) {
                                                dialoguePress.beginPress(event, {
                                                    dialogueIndex: segment.dialogueIndex as number,
                                                    text: segment.text,
                                                    speaker: segment.speaker,
                                                });
                                            }
                                        }
                                        : undefined}
                                    onPointerMove={segment.kind === 'dialogue' && segment.dialogueIndex !== undefined && onDialogueClick
                                        ? event => { event.stopPropagation(); dialoguePress.movePress(event); }
                                        : undefined}
                                    onPointerUp={segment.kind === 'dialogue' && segment.dialogueIndex !== undefined && onDialogueClick
                                        ? event => { event.stopPropagation(); dialoguePress.endPress(event); }
                                        : undefined}
                                    onPointerCancel={segment.kind === 'dialogue' && segment.dialogueIndex !== undefined && onDialogueClick
                                        ? event => { event.stopPropagation(); dialoguePress.cancelPress(); }
                                        : undefined}
                                    onPointerLeave={segment.kind === 'dialogue' && segment.dialogueIndex !== undefined && onDialogueClick
                                        ? () => dialoguePress.cancelPress()
                                        : undefined}
                                    onContextMenu={segment.kind === 'dialogue' && segment.dialogueIndex !== undefined && (segment.speaker === 'char' || segment.speaker === 'user') && onDialogueLongPress
                                        ? event => {
                                            event.stopPropagation();
                                            dialoguePress.openContextMenu(event, {
                                                dialogueIndex: segment.dialogueIndex as number,
                                                text: segment.text,
                                                speaker: segment.speaker as StoryVoiceSpeaker,
                                            });
                                        }
                                        : undefined}
"""
text = replace_once(text, old_span, new_span, "Story dialogue span handlers")

text = replace_once(
    text,
    """    const storyMessageElementsRef = useRef<Map<number, HTMLElement>>(new Map());
    const pendingHistoryJumpRef = useRef<number | null>(null);
    const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const longPressOrigin = useRef<{ x: number; y: number } | null>(null);
""",
    """    const storyMessageElementsRef = useRef<Map<number, HTMLElement>>(new Map());
    const pendingHistoryJumpRef = useRef<number | null>(null);
""",
    "Story message long-press refs",
)

old_story_handlers = """    const cancelLongPress = useCallback(() => {
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
"""
new_story_handlers = """    const storyMessagePress = useLongPressGesture<HTMLElement, Message>({
        delay: 600,
        moveTolerance: 10,
        onLongPress: message => setMessageMenu(message),
    });
    const pressHandlersFor = (message: Message) => ({
        onPointerDown: (event: React.PointerEvent<HTMLElement>) => {
            if ((event.target as HTMLElement).closest('button, a, input, textarea, select, summary')) return;
            storyMessagePress.beginPress(event, message);
        },
        onPointerMove: (event: React.PointerEvent<HTMLElement>) => { storyMessagePress.movePress(event); },
        onPointerUp: (event: React.PointerEvent<HTMLElement>) => { storyMessagePress.endPress(event); },
        onPointerCancel: () => storyMessagePress.cancelPress(),
        onPointerLeave: () => storyMessagePress.cancelPress(),
        onContextMenu: (event: React.MouseEvent<HTMLElement>) => {
            event.preventDefault();
            if ((event.target as HTMLElement).closest('button, a, input, textarea, select, summary')) return;
            storyMessagePress.openContextMenu(event, message);
        },
    });
"""
text = replace_once(text, old_story_handlers, new_story_handlers, "Story message long-press handlers")
path.write_text(text, encoding="utf-8")

print("shared long-press patch applied")
