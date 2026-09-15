from pathlib import Path

path = Path('scripts/story-tts-hotfix-once.py')
text = path.read_text(encoding='utf-8')
old = ".join('\\n');"
new = ".join('\\\\n');"
count = text.count(old)
if count != 2:
    raise SystemExit(f'expected 2 classifier join newline escapes, got {count}')
path.write_text(text.replace(old, new), encoding='utf-8')
