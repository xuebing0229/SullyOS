import fs from 'node:fs';

const path = 'worker/amsg/src/storyJobs.ts';
let source = fs.readFileSync(path, 'utf8');

if (source.includes("import { fetchStoryUpstream } from './storyEgress';")) {
  console.log('[story-egress-patch] storyJobs.ts already patched');
  process.exit(0);
}

const replacements = [
  [
    "import { sendStoryBackgroundStatusPush } from './storyStatusPush';\n",
    "import { sendStoryBackgroundStatusPush } from './storyStatusPush';\nimport { fetchStoryUpstream } from './storyEgress';\n",
  ],
  [
    "  FCM_SERVICE_ACCOUNT_PRIVATE_KEY?: string;\n  DB: StoryJobsDb;\n",
    "  FCM_SERVICE_ACCOUNT_PRIVATE_KEY?: string;\n  STORY_EGRESS_RELAY_URL?: string;\n  STORY_EGRESS_RELAY_TOKEN?: string;\n  DB: StoryJobsDb;\n",
  ],
  [
    "        const upstream = await fetch(`${normalizeBaseUrl(route.baseUrl)}/chat/completions`, {\n",
    "        const targetUrl = `${normalizeBaseUrl(route.baseUrl)}/chat/completions`;\n        const upstream = await fetchStoryUpstream(env, targetUrl, {\n",
  ],
];

for (const [before, after] of replacements) {
  const count = source.split(before).length - 1;
  if (count !== 1) {
    throw new Error(`[story-egress-patch] expected exactly one match, got ${count}: ${JSON.stringify(before)}`);
  }
  source = source.replace(before, after);
}

fs.writeFileSync(path, source);
console.log('[story-egress-patch] patched storyJobs.ts');
