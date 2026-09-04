#!/usr/bin/env node
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';

const path = 'components/date/story/StoryTheaterSession.tsx';
let source = readFileSync(path, 'utf8');
const from = `            const parsedInlineImage = entry.imageGeneration?.enabled
                ? parseStoryInlineImagePlan(rawContent)
                : { content: rawContent };
`;
const to = `            const parsedInlineImage = entry.imageGeneration?.enabled
                ? parseStoryInlineImagePlan(rawContent)
                : { content: rawContent, plan: undefined };
`;
if (source.split(from).length - 1 !== 1) {
  throw new Error(`expected one typing anchor, got ${source.split(from).length - 1}`);
}
source = source.replace(from, to);
writeFileSync(path, source);
for (const temp of [
  'scripts/fix-story-inline-image-plan-type.mjs',
  '.github/workflows/fix-story-inline-image-plan-type.yml',
]) {
  try { unlinkSync(temp); } catch {}
}
