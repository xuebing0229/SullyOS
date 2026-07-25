import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createNovelRuntimeConfigStore, toUpstreamConfig } from '../src/runtime-config.mjs';

const bootstrap = {
  profile: 'official', baseUrl: 'https://image.novelai.net', apiKey: '', generatePath: '/ai/generate-image',
  authHeader: 'Authorization', authPrefix: 'Bearer', modelFull: 'nai-diffusion-4-5-full',
  modelCurated: 'nai-diffusion-4-5-curated', responseMode: 'auto', imageDelivery: 'auto',
  accept: 'application/json, image/png, application/zip', promptLanguagePolicy: 'allow'
};

test('official profile fixes official host and keeps key secret', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'nai-config-'));
  try {
    const store = createNovelRuntimeConfigStore({ filePath: path.join(dir, 'config.json'), bootstrap, allowInsecureUpstream: false });
    const updated = await store.update({ expectedRevision: 0, patch: { profile: 'official', baseUrl: 'https://evil.example' }, apiKey: 'TEST_NOVELAI_UPSTREAM_KEY_123456' });
    assert.equal(updated.baseUrl, 'https://image.novelai.net');
    const publicValue = store.toPublic(updated);
    assert.equal(publicValue.apiKey, undefined);
    assert.equal(publicValue.apiKeyConfigured, true);
    const effective = toUpstreamConfig(updated, {
      upstreamExtraHeaders: {}, upstreamBodyOverrides: {}, upstreamParameterOverrides: {}, upstreamTimeoutMs: 1000,
      upstreamParamsVersion: 3, requestImageFormat: 'webp'
    });
    assert.equal(effective.upstreamModelFull, 'nai-diffusion-4-5-full');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
