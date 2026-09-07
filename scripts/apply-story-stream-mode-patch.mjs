import fs from 'node:fs';

const patchFile = (path, replacements) => {
  let source = fs.readFileSync(path, 'utf8');
  let changed = false;
  for (const [before, after] of replacements) {
    const count = source.split(before).length - 1;
    if (count === 0 && source.includes(after)) continue;
    if (count !== 1) {
      throw new Error(`[story-stream-patch] ${path}: expected exactly one match, got ${count}: ${JSON.stringify(before)}`);
    }
    source = source.replace(before, after);
    changed = true;
  }
  if (changed) fs.writeFileSync(path, source);
  console.log(`[story-stream-patch] ${path}: ${changed ? 'patched' : 'already patched'}`);
};

patchFile('utils/backgroundStoryJobs.ts', [
  [
    "            model: route.api.model,\n            ...(typeof route.api.temperature === 'number'\n",
    "            model: route.api.model,\n            ...(typeof route.api.stream === 'boolean'\n                ? { stream: route.api.stream }\n                : {}),\n            ...(typeof route.api.temperature === 'number'\n",
  ],
]);

patchFile('worker/amsg/src/storyJobs.ts', [
  [
    "  model: string;\n  temperature?: number;\n",
    "  model: string;\n  stream?: boolean;\n  temperature?: number;\n",
  ],
  [
    "      model,\n      temperature: Number.isFinite(Number(route.temperature))\n",
    "      model,\n      stream: typeof route.stream === 'boolean' ? route.stream : undefined,\n      temperature: Number.isFinite(Number(route.temperature))\n",
  ],
  [
    "      const body: Record<string, unknown> = {\n        ...spec.baseBody,\n        model: route.model,\n        stream: true,\n      };\n",
    "      const body: Record<string, unknown> = {\n        ...spec.baseBody,\n        model: route.model,\n      };\n      const useStream = typeof route.stream === 'boolean'\n        ? route.stream\n        : typeof spec.baseBody.stream === 'boolean'\n          ? Boolean(spec.baseBody.stream)\n          : true;\n      body.stream = useStream;\n",
  ],
  [
    "      if (includeUsage) {\n        body.stream_options = {\n",
    "      if (includeUsage && useStream) {\n        body.stream_options = {\n",
  ],
]);
