import fs from 'node:fs';

function read(path) { return fs.readFileSync(path, 'utf8'); }
function write(path, content) { fs.writeFileSync(path, content, 'utf8'); }
function replaceExact(content, from, to, label) {
  if (!content.includes(from)) throw new Error(`Missing target: ${label}`);
  const next = content.replace(from, to);
  if (next === content) throw new Error(`No change: ${label}`);
  return next;
}

// 1) Persist the switch on the category itself. Undefined keeps old libraries compatible (= allowed).
{
  const path = 'types.ts';
  let s = read(path);
  s = replaceExact(
    s,
    `export interface EmojiCategory {\n    id: string;\n    name: string;\n    isSystem?: boolean;\n    allowedCharacterIds?: string[]; // If set, only these characters can see this category\n}`,
    `export interface EmojiCategory {\n    id: string;\n    name: string;\n    isSystem?: boolean;\n    allowedCharacterIds?: string[]; // If set, only these characters can see this category\n    /** false = this group stays available to the user, but roles cannot see/send its emojis. */\n    roleUsable?: boolean;\n}`,
    'EmojiCategory.roleUsable',
  );
  write(path, s);
}

// 2) Keep the user's sticker panel unchanged, but feed the role a separately filtered library.
{
  const path = 'apps/Chat.tsx';
  let s = read(path);
  s = replaceExact(
    s,
    `    // Filter categories and emojis by active character's visibility (used for both AI prompt and UI)\n    const visibleCategories = useMemo(() => categories.filter(cat => {\n        if (!cat.allowedCharacterIds || cat.allowedCharacterIds.length === 0) return true;\n        return cat.allowedCharacterIds.includes(activeCharacterId);\n    }), [categories, activeCharacterId]);\n\n    const aiVisibleEmojis = useMemo(() => {\n        const hiddenIds = new Set(categories.filter(c => !visibleCategories.some(vc => vc.id === c.id)).map(c => c.id));\n        if (hiddenIds.size === 0) return emojis;\n        return emojis.filter(e => !e.categoryId || !hiddenIds.has(e.categoryId));\n    }, [emojis, categories, visibleCategories]);`,
    `    // “聊天可见范围”只决定用户在当前聊天里能不能看到这个分组。\n    // “角色可用”是另一层权限：关闭后用户仍可手动查看/发送，但 AI 完全拿不到该组。\n    const visibleCategories = useMemo(() => categories.filter(cat => {\n        if (!cat.allowedCharacterIds || cat.allowedCharacterIds.length === 0) return true;\n        return cat.allowedCharacterIds.includes(activeCharacterId);\n    }), [categories, activeCharacterId]);\n\n    const aiVisibleCategories = useMemo(\n        () => visibleCategories.filter(cat => cat.roleUsable !== false),\n        [visibleCategories],\n    );\n\n    const aiVisibleEmojis = useMemo(() => {\n        const blockedIds = new Set(categories.filter(c => (\n            !visibleCategories.some(vc => vc.id === c.id) || c.roleUsable === false\n        )).map(c => c.id));\n        if (blockedIds.size === 0) return emojis;\n        return emojis.filter(e => !e.categoryId || !blockedIds.has(e.categoryId));\n    }, [emojis, categories, visibleCategories]);`,
    'Chat role-only emoji filter',
  );
  s = replaceExact(
    s,
    `        emojis: aiVisibleEmojis,\n        categories: visibleCategories,`,
    `        emojis: aiVisibleEmojis,\n        categories: aiVisibleCategories,`,
    'useChatAI role-visible categories',
  );
  s = replaceExact(
    s,
    `    const handleSaveCategoryVisibility = async (categoryId: string, allowedCharacterIds: string[] | undefined) => {\n        const cat = categories.find(c => c.id === categoryId);\n        if (!cat) return;\n        await DB.saveEmojiCategory({ ...cat, allowedCharacterIds });\n        await loadEmojiData();\n        markEmojiLibraryChanged();\n        setSelectedCategory(null);\n        addToast(allowedCharacterIds ? \`已设置 \${allowedCharacterIds.length} 个角色可见\` : '已设为所有角色可见', 'success');\n    };`,
    `    const handleSaveCategoryVisibility = async (categoryId: string, allowedCharacterIds: string[] | undefined) => {\n        const cat = categories.find(c => c.id === categoryId);\n        if (!cat) return;\n        await DB.saveEmojiCategory({ ...cat, allowedCharacterIds });\n        await loadEmojiData();\n        markEmojiLibraryChanged();\n        setSelectedCategory(null);\n        addToast(allowedCharacterIds ? \`已设置 \${allowedCharacterIds.length} 个聊天可见\` : '已设为所有聊天可见', 'success');\n    };\n\n    const handleSaveCategoryRoleUsable = async (categoryId: string, roleUsable: boolean) => {\n        const cat = categories.find(c => c.id === categoryId);\n        if (!cat) return;\n        const updated = { ...cat, roleUsable };\n        await DB.saveEmojiCategory(updated);\n        setCategories(prev => prev.map(item => item.id === categoryId ? updated : item));\n        setSelectedCategory(prev => prev?.id === categoryId ? updated : prev);\n        markEmojiLibraryChanged();\n        addToast(roleUsable ? '角色现在可以使用这组表情' : '这组表情已仅供你使用', 'success');\n    };`,
    'category role usable save handler',
  );
  s = replaceExact(
    s,
    `                allCharacters={characters} onSaveCategoryVisibility={handleSaveCategoryVisibility}`,
    `                allCharacters={characters} onSaveCategoryVisibility={handleSaveCategoryVisibility} onSaveCategoryRoleUsable={handleSaveCategoryRoleUsable}`,
    'ChatModals role usable prop',
  );
  s = replaceExact(
    s,
    `                        emojis={emojis}\n                        emojiCategories={categories}`,
    `                        emojis={aiVisibleEmojis}\n                        emojiCategories={aiVisibleCategories}`,
    'Collaboration role emoji filter',
  );
  write(path, s);
}

// 3) Add the switch directly to the existing category long-press menu.
{
  const path = 'components/chat/ChatModals.tsx';
  let s = read(path);
  s = replaceExact(
    s,
    `    allCharacters?: CharacterProfile[];\n    onSaveCategoryVisibility?: (categoryId: string, allowedCharacterIds: string[] | undefined) => void;`,
    `    allCharacters?: CharacterProfile[];\n    onSaveCategoryVisibility?: (categoryId: string, allowedCharacterIds: string[] | undefined) => void;\n    onSaveCategoryRoleUsable?: (categoryId: string, roleUsable: boolean) => void | Promise<void>;`,
    'ChatModals role usable prop type',
  );
  s = replaceExact(
    s,
    `    allCharacters = [], onSaveCategoryVisibility,`,
    `    allCharacters = [], onSaveCategoryVisibility, onSaveCategoryRoleUsable,`,
    'ChatModals role usable destructure',
  );
  s = replaceExact(
    s,
    `                <div className="space-y-3">\n                    <button onClick={openVisibilityModal}`,
    `                <div className="space-y-3">\n                    <div className="flex items-center justify-between gap-3 rounded-2xl bg-slate-50 px-4 py-3">\n                        <div className="min-w-0 pr-2">\n                            <div className="text-sm font-medium text-slate-700">角色可用</div>\n                            <div className="mt-0.5 text-[10px] leading-relaxed text-slate-400">关闭后你仍可正常使用这组表情，角色不会看到或调用它们。</div>\n                        </div>\n                        <button\n                            type="button"\n                            onClick={() => {\n                                if (selectedCategory && onSaveCategoryRoleUsable) {\n                                    void onSaveCategoryRoleUsable(selectedCategory.id, selectedCategory.roleUsable === false);\n                                }\n                            }}\n                            className={\`relative h-6 w-11 shrink-0 rounded-full transition-colors \${selectedCategory?.roleUsable === false ? 'bg-slate-300' : 'bg-primary'}\`}\n                            aria-pressed={selectedCategory?.roleUsable !== false}\n                            aria-label="角色可用"\n                        >\n                            <span className={\`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all \${selectedCategory?.roleUsable === false ? 'left-0.5' : 'left-[22px]'}\`} />\n                        </button>\n                    </div>\n                    <button onClick={openVisibilityModal}`,
    'category role usable switch',
  );
  s = replaceExact(s, '                        设置可见角色', '                        设置聊天可见范围', 'visibility button label');
  s = s.replace(/title=\{`"\$\{selectedCategory\?\.name\}" 可见角色`\}/g, 'title={`"${selectedCategory?.name}" 聊天可见范围`}');
  s = s.replace('选择哪些角色可以使用此表情分组。不勾选任何角色表示所有角色均可使用。', '选择这组表情在哪些角色的聊天面板里显示。不勾选任何角色表示所有聊天都显示。');
  write(path, s);
}

// 4) Active-message/fire-pack path bypasses Chat.tsx, so enforce the same hard filter here too.
{
  const path = 'utils/chatPrompts.ts';
  let s = read(path);
  s = replaceExact(
    s,
    `        const visibleCategories = categories.filter(cat => {\n            if (!cat.allowedCharacterIds || cat.allowedCharacterIds.length === 0) return true;\n            return cat.allowedCharacterIds.includes(charId);\n        });`,
    `        const visibleCategories = categories.filter(cat => {\n            if (cat.roleUsable === false) return false;\n            if (!cat.allowedCharacterIds || cat.allowedCharacterIds.length === 0) return true;\n            return cat.allowedCharacterIds.includes(charId);\n        });`,
    'fire-pack role usable filter',
  );
  s = replaceExact(
    s,
    `    // 分类未设 allowedCharacterIds（或为空）= 所有角色可见；否则只有名单内角色可见。\n    // 表情若属于一个对该角色不可见的分类，则一并隐藏（无 categoryId 的表情始终可见）。`,
    `    // roleUsable=false 的分类对所有角色硬隐藏；它只影响角色，不影响用户自己的表情面板。\n    // 其余分类再按 allowedCharacterIds 做聊天可见范围过滤；无 categoryId 的表情始终可见。`,
    'filterVisibleEmojis comment',
  );
  write(path, s);
}

console.log('emoji role availability patch applied');
