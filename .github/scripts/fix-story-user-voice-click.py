from pathlib import Path

story = Path('components/date/story/StoryTheaterSession.tsx')
text = story.read_text()

old = "const StoryOutput: React.FC<{ content: string; onChoose?: (text: string) => void; affinityInputs?: StoryAffinityInput[]; voiceSpeakers?: Array<StoryVoiceSpeaker | null>; onDialogueClick?: (dialogueIndex: number, text: string, speaker?: StoryVoiceSpeaker) => void; onDialogueLongPress?: (dialogueIndex: number, text: string, speaker: StoryVoiceSpeaker) => void }> = ({ content, onChoose, affinityInputs = [], voiceSpeakers, onDialogueClick, onDialogueLongPress }) => {"
new = "const StoryOutput: React.FC<{ content: string; onChoose?: (text: string) => void; affinityInputs?: StoryAffinityInput[]; voiceSpeakers?: Array<StoryVoiceSpeaker | null>; plainUserInput?: boolean; onDialogueClick?: (dialogueIndex: number, text: string, speaker?: StoryVoiceSpeaker) => void; onDialogueLongPress?: (dialogueIndex: number, text: string, speaker: StoryVoiceSpeaker) => void }> = ({ content, onChoose, affinityInputs = [], voiceSpeakers, plainUserInput = false, onDialogueClick, onDialogueLongPress }) => {"
assert text.count(old) == 1, f'StoryOutput signature matches: {text.count(old)}'
text = text.replace(old, new)

old = """                        <p
                            key={paragraphIndex}
                            className='max-w-full font-serif text-[15px] leading-8 text-slate-800 whitespace-pre-wrap break-words [overflow-wrap:anywhere]'
                            style={{ textIndent: appearance.firstLineIndent ? '2em' : undefined }}
                        >"""
new = """                        <p
                            key={paragraphIndex}
                            className={plainUserInput
                                ? 'max-w-full text-sm leading-7 text-slate-600 whitespace-pre-wrap break-words [overflow-wrap:anywhere]'
                                : 'max-w-full font-serif text-[15px] leading-8 text-slate-800 whitespace-pre-wrap break-words [overflow-wrap:anywhere]'}
                            style={{ textIndent: !plainUserInput && appearance.firstLineIndent ? '2em' : undefined }}
                        >"""
assert text.count(old) == 1, f'paragraph shell matches: {text.count(old)}'
text = text.replace(old, new)

old = """                                const renderedText = appearance.textToneEnabled
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
                                } : undefined;"""
new = """                                const renderedText = plainUserInput
                                    ? (segment.kind === 'psychology' ? `*${segment.text}*` : segment.text)
                                    : appearance.textToneEnabled
                                        ? segment.text
                                        : segment.kind === 'psychology'
                                            ? `*${segment.text}*`
                                            : segment.text;
                                const toneStyle = !plainUserInput && appearance.textToneEnabled ? {
                                    color: segment.kind === 'dialogue'
                                        ? appearance.dialogueColor
                                        : segment.kind === 'psychology'
                                            ? appearance.psychologyColor
                                            : appearance.narrationColor,
                                    ...(segment.kind === 'psychology' ? { fontStyle: 'italic' as const } : {}),
                                } : undefined;"""
assert text.count(old) == 1, f'tone block matches: {text.count(old)}'
text = text.replace(old, new)

old = "<p className='mt-2 text-sm leading-7 text-slate-600 whitespace-pre-wrap'>{message.content}</p>"
replacement = "<div className='mt-2'><StoryOutput content={message.content} plainUserInput voiceSpeakers={voiceSpeakersFromMessage(message)} onDialogueClick={entry.storyTtsEnabled ? (dialogueIndex, text, speaker) => void playStoryDialogue(message.id, dialogueIndex, text, speaker) : undefined} onDialogueLongPress={entry.storyTtsEnabled ? (dialogueIndex, text, speaker) => setVoiceRefreshMenu({ messageId: message.id, dialogueIndex, text, speaker }) : undefined} /></div>"
assert text.count(old) == 2, f'user paragraph matches: {text.count(old)}'
text = text.replace(old, replacement)

old = """                    userName: promptIdentityName,
                    currentSpeakers,"""
new = """                    userName: promptIdentityName,
                    sourceRole: message.role === 'user' ? 'user' : 'assistant',
                    currentSpeakers,"""
assert text.count(old) == 1, f'classifier call matches: {text.count(old)}'
text = text.replace(old, new)
story.write_text(text)

classifier = Path('utils/storyTheaterVoiceClassifier.ts')
text = classifier.read_text()
old = """    userName: string;
    currentSpeakers?: StoryVoiceDialogueSpeaker[];"""
new = """    userName: string;
    sourceRole?: 'user' | 'assistant';
    currentSpeakers?: StoryVoiceDialogueSpeaker[];"""
assert text.count(old) == 1, f'classifier interface matches: {text.count(old)}'
text = text.replace(old, new)

old = """    characterName,
    userName,
    currentSpeakers = [],"""
new = """    characterName,
    userName,
    sourceRole = 'assistant',
    currentSpeakers = [],"""
assert text.count(old) == 1, f'classifier args matches: {text.count(old)}'
text = text.replace(old, new)

old = """                        `用户侧身份：${userName}`,
                        '每句只能分类为 char / user / npc。',"""
new = """                        `用户侧身份：${userName}`,
                        sourceRole === 'user'
                            ? '当前这段正文来自用户侧自己提交的推进。消息作者是用户不代表所有引号都属于 user；但没有明确其他人物归属、作为用户本人直接说出口的对白应判为 user。'
                            : '当前这段正文来自剧情模型生成。',
                        '每句只能分类为 char / user / npc。',"""
assert text.count(old) == 1, f'classifier prompt matches: {text.count(old)}'
text = text.replace(old, new)
classifier.write_text(text)
