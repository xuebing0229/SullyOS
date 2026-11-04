import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOTS = ['api', 'apps', 'components', 'context', 'features', 'hooks', 'server', 'services', 'utils', 'worker'];
const SOURCE_EXT = /\.(?:ts|tsx|js|jsx|mjs|cjs)$/;
const EXCLUDED = /(?:^|\/)(?:node_modules|dist|test|__tests__)(?:\/|$)|(?:\.test|\.spec)\.(?:ts|tsx|js|jsx|mjs|cjs)$|\.bundle\.(?:js|mjs|cjs)$/;

const runtimeFiles = (): string[] => {
  const out: string[] = [];
  const walk = (absolute: string) => {
    for (const name of readdirSync(absolute)) {
      const full = join(absolute, name);
      const rel = relative(process.cwd(), full).replace(/\\/g, '/');
      if (EXCLUDED.test(rel)) continue;
      const stat = statSync(full);
      if (stat.isDirectory()) walk(full);
      else if (SOURCE_EXT.test(rel)) out.push(rel);
    }
  };
  for (const root of ROOTS) walk(join(process.cwd(), root));
  return out.sort();
};

describe('ElevenLabs account preset routing guard', () => {
  const files = runtimeFiles();

  it('does not let runtime features read legacy ElevenLabs key / Voice ID fields directly', () => {
    const allowed = new Set([
      'apps/Settings.tsx',       // one-time migration + settings editor compatibility mirror
      'context/OSContext.tsx',   // initializes the legacy compatibility mirror field
      'utils/elevenLabsTts.ts',  // single compatibility fallback and canonical resolver
    ]);
    const violations: string[] = [];
    for (const file of files) {
      if (allowed.has(file)) continue;
      const source = readFileSync(file, 'utf8');
      if (/\belevenLabsVoiceId\b|\belevenLabsApiKey\b/.test(source)) violations.push(file);
    }
    expect(violations).toEqual([]);
  });

  it('does not let UI feature code call ElevenLabs endpoints or xi-api-key directly', () => {
    const featureRoots = /^(?:apps|components|context|features|hooks)\//;
    const violations: string[] = [];
    for (const file of files) {
      if (!featureRoots.test(file)) continue;
      const source = readFileSync(file, 'utf8');
      if (/api\.elevenlabs\.io|xi-api-key/i.test(source)) violations.push(file);
    }
    expect(violations).toEqual([]);
  });

  it('keeps Date and Story user speech on the canonical user voice target', () => {
    const date = readFileSync('components/date/DateSession.tsx', 'utf8');
    const story = readFileSync('components/date/story/StoryTheaterSession.tsx', 'utf8');
    expect(date).toContain("speaker === 'user' ? createUserVoiceTarget(userProfile) : char");
    expect(date).not.toContain(':user-voice');
    expect(story).toContain("resolvedSpeaker === 'user' ? createUserVoiceTarget(userProfile)");
  });

  it('isolates Story ElevenLabs persisted audio by active preset and resolved Voice ID', () => {
    const story = readFileSync('components/date/story/StoryTheaterSession.tsx', 'utf8');
    expect(story).toContain("apiConfig.activeElevenLabsAccountPresetId || 'legacy'");
    expect(story).toContain('resolveElevenLabsVoiceIdForTarget(actor, storyTtsApiConfig)');
    expect(story).toContain('storyVoiceAssetKey(entry.id, messageId, dialogueIndex, storyTtsProvider, elevenLabsVoiceIdentity)');
  });
});
