from pathlib import Path


def patch(rel: str, old: str, new: str) -> None:
    path = Path(rel)
    text = path.read_text()
    if old not in text:
        raise RuntimeError(f'anchor not found in {rel}: {old[:120]!r}')
    path.write_text(text.replace(old, new, 1))


# This case is testing field fallback, not the cross-turn expiry counter. Give it
# its own character id so prior lifecycle tests cannot consume buff_old's grace round.
patch(
    'utils/emotionApply.test.ts',
    "        await applyEmotionEvalRaw(raw, makeChar());\n        const saved = saveCharacter.mock.calls[0][0];\n        expect(saved.activeBuffs.length).toBe(3);\n        expect(saved.activeBuffs[0].name).toBe('buff_x');",
    "        await applyEmotionEvalRaw(raw, makeChar({ id: 'char-missing-fields' }));\n        const saved = saveCharacter.mock.calls[0][0];\n        expect(saved.activeBuffs.length).toBe(3);\n        expect(saved.activeBuffs[0].name).toBe('buff_x');",
)

# applyEmotionEvalRaw now reads the latest character before applying the result so
# a slow emotion request cannot overwrite settings changed while it was in flight.
# The integration test should model that DB method as well as saveCharacter.
patch(
    'utils/emotionPronounCorrection.integration.test.ts',
    "    DB: {\n        saveCharacter: (char: CharacterProfile) => saveCharacter(char),\n    },",
    "    DB: {\n        saveCharacter: (char: CharacterProfile) => saveCharacter(char),\n        getAllCharacters: async () => [],\n    },",
)
