#!/usr/bin/env node
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';

const path = 'components/date/story/StoryTheaterSession.tsx';
let source = readFileSync(path, 'utf8');
const from = `            const returnedPartialRaw = String(
                error?.partialContent
                || error?.storyIncompleteCompletion?.content
                || '',
            );
            const returnedPartial = entry.imageGeneration?.enabled
                ? storyInlineImageVisibleText(returnedPartialRaw).trim()
                : returnedPartialRaw.trim();
`;
const to = `            const returnedPartial = entry.imageGeneration?.enabled
                ? storyInlineImageVisibleText(String(
                    error?.partialContent
                    || error?.storyIncompleteCompletion?.content
                    || '',
                )).trim()
                : String(
                    error?.partialContent
                    || error?.storyIncompleteCompletion?.content
                    || '',
                ).trim();
`;
const count = source.split(from).length - 1;
if (count !== 1) throw new Error(`expected one partial anchor, got ${count}`);
source = source.replace(from, to);
writeFileSync(path, source);
for (const temp of [
  'scripts/fix-story-inline-image-plan-partial.mjs',
  '.github/workflows/fix-story-inline-image-plan-partial.yml',
]) {
  try { unlinkSync(temp); } catch {}
}
