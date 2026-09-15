from pathlib import Path

path = Path('scripts/story-tts-hotfix-once.py')
text = path.read_text(encoding='utf-8')
old = ".join('\\n')"
new = ".join('\\\\n')"
count = text.count(old)
if count < 1:
    raise SystemExit('classifier newline join escape not found')
path.write_text(text.replace(old, new), encoding='utf-8')
