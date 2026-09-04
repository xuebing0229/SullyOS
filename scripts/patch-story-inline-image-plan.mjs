#!/usr/bin/env node
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';

const path = 'components/date/story/StoryTheaterSession.tsx';
let source = readFileSync(path, 'utf8');

const replaceOnce = (from, to, label) => {
  const first = source.indexOf(from);
  if (first < 0) throw new Error(`missing patch anchor: ${label}`);
  if (source.indexOf(from, first + from.length) >= 0) throw new Error(`patch anchor not unique: ${label}`);
  source = source.slice(0, first) + to + source.slice(first + from.length);
};

replaceOnce(
  "import { generateStoryTheaterImage, resolveStoryImagePlannerApiConfig } from '../../../utils/storyTheaterImage';",
  `import {\n    buildStoryInlineImagePlanInstruction,\n    generateStoryTheaterImage,\n    parseStoryInlineImagePlan,\n    resolveStoryImagePlannerApiConfig,\n    storyInlineImageVisibleText,\n} from '../../../utils/storyTheaterImage';`,
  'story image imports',
);

replaceOnce(
  `            const identityGuard = buildStoryIdentityGuard(effectivePreset.document, promptIdentityName, actors.map(actor => actor.name));\n            const modelInput = appendStoryAffinityInputs(modelText, affinityInputs);\n            const payloadBeforeTurn = [`,
  `            const identityGuard = buildStoryIdentityGuard(effectivePreset.document, promptIdentityName, actors.map(actor => actor.name));\n            let inlineImagePlanInstruction = '';\n            if (entry.imageGeneration?.enabled) {\n                try {\n                    inlineImagePlanInstruction = buildStoryInlineImagePlanInstruction({\n                        entry,\n                        actors,\n                        userProfile,\n                        userName: promptIdentityName,\n                    });\n                } catch (imagePlanInstructionError) {\n                    // 配图配置坏掉不能拖死正文；这轮仍可在正文落库后走旧独立规划器兜底。\n                    console.warn('[StoryTheater] inline image plan instruction unavailable; legacy planner remains available', imagePlanInstructionError);\n                }\n            }\n            const modelInput = appendStoryAffinityInputs(modelText, affinityInputs);\n            const payloadBeforeTurn = [`,
  'inline image instruction build',
);

replaceOnce(
  `                ...(affinityAwarenessReminder ? [{ role: 'system' as const, content: affinityAwarenessReminder }] : []),\n                { role: 'system' as const, content: identityGuard },\n            ];`,
  `                ...(affinityAwarenessReminder ? [{ role: 'system' as const, content: affinityAwarenessReminder }] : []),\n                { role: 'system' as const, content: identityGuard },\n                ...(inlineImagePlanInstruction ? [{ role: 'system' as const, content: inlineImagePlanInstruction }] : []),\n            ];`,
  'inline image instruction injection',
);

replaceOnce(
  `            }, fullText => {\n                const visible = prefill && !fullText.startsWith(prefill) ? \`${'${prefill}${fullText}'}\` : fullText;\n                partialStreamText = visible;\n                streamingTextRef.current = visible;\n                setStreamingText(visible);\n            }, {`,
  `            }, fullText => {\n                const rawVisible = prefill && !fullText.startsWith(prefill) ? \`${'${prefill}${fullText}'}\` : fullText;\n                const visible = entry.imageGeneration?.enabled\n                    ? storyInlineImageVisibleText(rawVisible)\n                    : rawVisible;\n                partialStreamText = visible;\n                streamingTextRef.current = visible;\n                setStreamingText(visible);\n            }, {`,
  'stream plan hiding',
);

replaceOnce(
  `            nativeCompletionReceived = usedNativeBackground;\n            const content = prefill && !generated.startsWith(prefill) ? \`${'${prefill}${generated}'}\` : generated;\n            const rowsBeforeCommit =`,
  `            nativeCompletionReceived = usedNativeBackground;\n            const rawContent = prefill && !generated.startsWith(prefill) ? \`${'${prefill}${generated}'}\` : generated;\n            const parsedInlineImage = entry.imageGeneration?.enabled\n                ? parseStoryInlineImagePlan(rawContent)\n                : { content: rawContent };\n            const content = parsedInlineImage.content.trim();\n            const inlineImagePlan = parsedInlineImage.plan;\n            if (!content) throw new Error('剧情正文为空：模型只返回了配图控制块，没有正文。');\n            const rowsBeforeCommit =`,
  'final plan parse',
);

replaceOnce(
  `                    theaterRequestKey: activeRequestKey,\n                    ...(affinityInputs.length > 0 ? { theaterAffinityInputs: affinityInputs } : {}),\n                });`,
  `                    theaterRequestKey: activeRequestKey,\n                    ...(affinityInputs.length > 0 ? { theaterAffinityInputs: affinityInputs } : {}),\n                    ...(inlineImagePlan ? { theaterInlineImagePlan: inlineImagePlan } : {}),\n                });`,
  'persist inline plan metadata',
);

replaceOnce(
  `                        userName: promptIdentityName,\n                        messages: imageRows,\n                        targetMessageId: assistantMessageId,\n                    });`,
  `                        userName: promptIdentityName,\n                        messages: imageRows,\n                        inlinePlan: inlineImagePlan,\n                        targetMessageId: assistantMessageId,\n                    });`,
  'execute inline plan',
);

replaceOnce(
  `            const returnedPartial = String(\n                error?.partialContent\n                || error?.storyIncompleteCompletion?.content\n                || '',\n            ).trim();\n            const committedPartial = (partialStreamText || streamingTextRef.current || returnedPartial).trim();`,
  `            const returnedPartialRaw = String(\n                error?.partialContent\n                || error?.storyIncompleteCompletion?.content\n                || '',\n            );\n            const returnedPartial = entry.imageGeneration?.enabled\n                ? storyInlineImageVisibleText(returnedPartialRaw).trim()\n                : returnedPartialRaw.trim();\n            const committedPartial = (partialStreamText || streamingTextRef.current || returnedPartial).trim();`,
  'partial plan hiding',
);

writeFileSync(path, source);

// One-shot patch helper: keep the actual source change, remove the temporary machinery.
for (const temp of [
  'scripts/patch-story-inline-image-plan.mjs',
  '.github/workflows/patch-story-inline-image-plan.yml',
]) {
  try { unlinkSync(temp); } catch {}
}
