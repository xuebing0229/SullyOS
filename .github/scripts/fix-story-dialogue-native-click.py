from pathlib import Path

path = Path('components/date/story/StoryTheaterSession.tsx')
text = path.read_text(encoding='utf-8')

old_generic = 'useLongPressGesture<HTMLSpanElement, StoryDialoguePressTarget>'
new_generic = 'useLongPressGesture<HTMLButtonElement, StoryDialoguePressTarget>'
if text.count(old_generic) != 1:
    raise SystemExit(f'long press generic match count: {text.count(old_generic)}')
text = text.replace(old_generic, new_generic, 1)

marker = '{splitStoryToneSegments(paragraph, nextStoryDialogue).map((segment, segmentIndex) => ('
start = text.find(marker)
if start < 0:
    raise SystemExit('story segment renderer start not found')
end_marker = '\n                        </p>'
end = text.find(end_marker, start)
if end < 0:
    raise SystemExit('story segment renderer end not found')
old_block = text[start:end]
if old_block.count('<span') != 1 or 'data-story-dialogue-index' not in old_block:
    raise SystemExit('unexpected story segment renderer shape')
if '<button' in old_block:
    raise SystemExit('story dialogue button already present')

new_block = '''{splitStoryToneSegments(paragraph, nextStoryDialogue).map((segment, segmentIndex) => {
                                const renderedText = appearance.textToneEnabled
                                    ? segment.text
                                    : segment.kind === 'psychology'
                                        ? `*${segment.text}*`
                                        : segment.text;
                                const toneStyle = appearance.textToneEnabled ? {
                                    color: segment.kind === 'dialogue'
                                        ? appearance.dialogueColor
                                        : segment.kind === 'psychology'
                                            ? appearance.psychologyColor
                                            : appearance.narrationColor,
                                    ...(segment.kind === 'psychology' ? { fontStyle: 'italic' as const } : {}),
                                } : undefined;
                                const clickableDialogue = segment.kind === 'dialogue'
                                    && segment.dialogueIndex !== undefined
                                    && Boolean(onDialogueClick);

                                if (!clickableDialogue) {
                                    return <span key={segmentIndex} style={toneStyle}>{renderedText}</span>;
                                }

                                const canRefreshVoice = (segment.speaker === 'char' || segment.speaker === 'user')
                                    && Boolean(onDialogueLongPress);

                                return <button
                                    key={segmentIndex}
                                    type='button'
                                    data-story-speaker={segment.speaker}
                                    data-story-dialogue-index={segment.dialogueIndex}
                                    onClick={event => {
                                        event.stopPropagation();
                                        if (dialoguePress.consumeSuppressedClick()) {
                                            event.preventDefault();
                                            return;
                                        }
                                        onDialogueClick?.(segment.dialogueIndex as number, segment.text, segment.speaker);
                                    }}
                                    onPointerDown={event => {
                                        event.stopPropagation();
                                        if (!canRefreshVoice) return;
                                        dialoguePress.beginPress(event, {
                                            dialogueIndex: segment.dialogueIndex as number,
                                            text: segment.text,
                                            speaker: segment.speaker as StoryVoiceSpeaker,
                                        });
                                    }}
                                    onPointerMove={event => {
                                        event.stopPropagation();
                                        dialoguePress.movePress(event);
                                    }}
                                    onPointerUp={event => {
                                        event.stopPropagation();
                                        dialoguePress.endPress(event);
                                    }}
                                    onPointerCancel={event => {
                                        event.stopPropagation();
                                        dialoguePress.cancelPress();
                                    }}
                                    onPointerLeave={() => dialoguePress.cancelPress()}
                                    onContextMenu={canRefreshVoice ? event => {
                                        event.stopPropagation();
                                        dialoguePress.openContextMenu(event, {
                                            dialogueIndex: segment.dialogueIndex as number,
                                            text: segment.text,
                                            speaker: segment.speaker as StoryVoiceSpeaker,
                                        });
                                    } : undefined}
                                    className='inline cursor-pointer border-0 bg-transparent p-0 m-0 text-left align-baseline'
                                    style={{
                                        ...(toneStyle || {}),
                                        font: 'inherit',
                                        lineHeight: 'inherit',
                                        letterSpacing: 'inherit',
                                        whiteSpace: 'inherit',
                                    }}
                                >
                                    {renderedText}
                                </button>;
                            })}'''

text = text[:start] + new_block + text[end:]

if text.count("type='button'\n                                    data-story-speaker={segment.speaker}") != 1:
    raise SystemExit('native dialogue button verification failed')

path.write_text(text, encoding='utf-8')
