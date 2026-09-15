from pathlib import Path

session_path = Path('components/date/story/StoryTheaterSession.tsx')
workflow_path = Path('.github/workflows/story-tts-pointer-hotfix-once.yml')
script_path = Path('scripts/story-tts-pointer-hotfix.py')

session = session_path.read_text(encoding='utf-8')

old_press = r'''    const beginDialogueLongPress = useCallback((
        event: React.PointerEvent<HTMLSpanElement>,
        dialogueIndex: number,
        dialogueText: string,
        speaker: StoryVoiceSpeaker,
    ) => {
        event.stopPropagation();
        cancelDialogueLongPress();
        suppressDialogueClickRef.current = false;
        dialoguePressOriginRef.current = { x: event.clientX, y: event.clientY };
        dialoguePressTimerRef.current = setTimeout(() => {
            dialoguePressTimerRef.current = null;
            dialoguePressOriginRef.current = null;
            suppressDialogueClickRef.current = true;
            onDialogueLongPress?.(dialogueIndex, dialogueText, speaker);
        }, 520);
    }, [cancelDialogueLongPress, onDialogueLongPress]);
    const moveDialogueLongPress = useCallback((event: React.PointerEvent<HTMLSpanElement>) => {
        event.stopPropagation();
        const origin = dialoguePressOriginRef.current;
        if (!origin) return;
        if (Math.abs(event.clientX - origin.x) > 10 || Math.abs(event.clientY - origin.y) > 10) cancelDialogueLongPress();
    }, [cancelDialogueLongPress]);
'''

new_press = r'''    const dialoguePressMovedRef = useRef(false);
    const dialogueLongPressTriggeredRef = useRef(false);
    const beginDialoguePress = useCallback((
        event: React.PointerEvent<HTMLSpanElement>,
        dialogueIndex: number,
        dialogueText: string,
        speaker?: StoryVoiceSpeaker,
    ) => {
        event.stopPropagation();
        cancelDialogueLongPress();
        suppressDialogueClickRef.current = false;
        dialoguePressMovedRef.current = false;
        dialogueLongPressTriggeredRef.current = false;
        dialoguePressOriginRef.current = { x: event.clientX, y: event.clientY };
        if ((speaker === 'char' || speaker === 'user') && onDialogueLongPress) {
            dialoguePressTimerRef.current = setTimeout(() => {
                dialoguePressTimerRef.current = null;
                dialoguePressOriginRef.current = null;
                dialogueLongPressTriggeredRef.current = true;
                suppressDialogueClickRef.current = true;
                onDialogueLongPress(dialogueIndex, dialogueText, speaker);
            }, 520);
        }
    }, [cancelDialogueLongPress, onDialogueLongPress]);
    const moveDialoguePress = useCallback((event: React.PointerEvent<HTMLSpanElement>) => {
        event.stopPropagation();
        const origin = dialoguePressOriginRef.current;
        if (!origin) return;
        if (Math.abs(event.clientX - origin.x) > 10 || Math.abs(event.clientY - origin.y) > 10) {
            dialoguePressMovedRef.current = true;
            if (dialoguePressTimerRef.current) clearTimeout(dialoguePressTimerRef.current);
            dialoguePressTimerRef.current = null;
        }
    }, []);
    const finishDialoguePress = useCallback((
        event: React.PointerEvent<HTMLSpanElement>,
        dialogueIndex: number,
        dialogueText: string,
        speaker?: StoryVoiceSpeaker,
    ) => {
        event.stopPropagation();
        const shouldPlay = !dialoguePressMovedRef.current && !dialogueLongPressTriggeredRef.current;
        if (dialoguePressTimerRef.current) clearTimeout(dialoguePressTimerRef.current);
        dialoguePressTimerRef.current = null;
        dialoguePressOriginRef.current = null;
        dialoguePressMovedRef.current = false;
        dialogueLongPressTriggeredRef.current = false;
        if (shouldPlay && onDialogueClick) {
            // Android WebView 在嵌套滚动/长按手势中可能不再派发 synthetic click。
            // 直接在 pointerup 完成轻点播放，再吞掉随后可能到达的 click，避免双播。
            suppressDialogueClickRef.current = true;
            onDialogueClick(dialogueIndex, dialogueText, speaker);
        }
    }, [onDialogueClick]);
    const abortDialoguePress = useCallback((event: React.PointerEvent<HTMLSpanElement>) => {
        event.stopPropagation();
        if (dialoguePressTimerRef.current) clearTimeout(dialoguePressTimerRef.current);
        dialoguePressTimerRef.current = null;
        dialoguePressOriginRef.current = null;
        dialoguePressMovedRef.current = false;
        dialogueLongPressTriggeredRef.current = false;
    }, []);
'''

if old_press not in session:
    raise SystemExit('dialogue press block not found')
session = session.replace(old_press, new_press, 1)

old_handlers = r'''                                    onPointerDown={segment.kind === 'dialogue' && (segment.speaker === 'char' || segment.speaker === 'user') && segment.dialogueIndex !== undefined && onDialogueLongPress
                                        ? event => beginDialogueLongPress(event, segment.dialogueIndex as number, segment.text, segment.speaker as StoryVoiceSpeaker)
                                        : undefined}
                                    onPointerMove={segment.kind === 'dialogue' && (segment.speaker === 'char' || segment.speaker === 'user') && segment.dialogueIndex !== undefined && onDialogueLongPress ? moveDialogueLongPress : undefined}
                                    onPointerUp={segment.kind === 'dialogue' && (segment.speaker === 'char' || segment.speaker === 'user') && segment.dialogueIndex !== undefined && onDialogueLongPress ? event => { event.stopPropagation(); cancelDialogueLongPress(); } : undefined}
                                    onPointerCancel={segment.kind === 'dialogue' && (segment.speaker === 'char' || segment.speaker === 'user') && segment.dialogueIndex !== undefined && onDialogueLongPress ? event => { event.stopPropagation(); cancelDialogueLongPress(); } : undefined}
                                    onPointerLeave={segment.kind === 'dialogue' && (segment.speaker === 'char' || segment.speaker === 'user') && segment.dialogueIndex !== undefined && onDialogueLongPress ? event => { event.stopPropagation(); cancelDialogueLongPress(); } : undefined}
'''

new_handlers = r'''                                    onPointerDown={segment.kind === 'dialogue' && segment.dialogueIndex !== undefined && onDialogueClick
                                        ? event => beginDialoguePress(event, segment.dialogueIndex as number, segment.text, segment.speaker)
                                        : undefined}
                                    onPointerMove={segment.kind === 'dialogue' && segment.dialogueIndex !== undefined && onDialogueClick ? moveDialoguePress : undefined}
                                    onPointerUp={segment.kind === 'dialogue' && segment.dialogueIndex !== undefined && onDialogueClick
                                        ? event => finishDialoguePress(event, segment.dialogueIndex as number, segment.text, segment.speaker)
                                        : undefined}
                                    onPointerCancel={segment.kind === 'dialogue' && segment.dialogueIndex !== undefined && onDialogueClick ? abortDialoguePress : undefined}
                                    onPointerLeave={segment.kind === 'dialogue' && segment.dialogueIndex !== undefined && onDialogueClick ? abortDialoguePress : undefined}
'''

if old_handlers not in session:
    raise SystemExit('dialogue pointer handlers not found')
session = session.replace(old_handlers, new_handlers, 1)

old_classifier = r'''        if (!resolvedSpeaker) {
            const message = messages.find(item => item.id === messageId);
            if (!message) return;
            const currentSpeakers = voiceSpeakersFromMessage(message);
            try {
'''
new_classifier = r'''        if (!resolvedSpeaker) {
            const message = messages.find(item => item.id === messageId);
            if (!message) return;
            const currentSpeakers = voiceSpeakersFromMessage(message);
            addToast('正在识别这句对白是谁说的…', 'info');
            try {
'''
if old_classifier not in session:
    raise SystemExit('classifier entry not found')
session = session.replace(old_classifier, new_classifier, 1)

old_partial = r'''                    const committedPartial = (partialStreamText || streamingTextRef.current || returnedPartial).trim();
            if (committedPartial) {
'''
new_partial = r'''            const committedPartial = (partialStreamText || streamingTextRef.current || returnedPartial).trim();
            if (committedPartial) {
'''
# Normalize a pre-existing indentation oddity only if present; it is not part of the functional patch.
if old_partial in session:
    session = session.replace(old_partial, new_partial, 1)

session_path.write_text(session, encoding='utf-8')

# One-shot patch infrastructure must not remain in master.
if workflow_path.exists():
    workflow_path.unlink()
if script_path.exists():
    script_path.unlink()
