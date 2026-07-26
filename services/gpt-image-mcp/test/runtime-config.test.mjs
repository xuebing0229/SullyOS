import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRuntimeConfigStore } from '../src/runtime-config.mjs';

const defaults = {
  mode: 'compatible', baseUrl: 'https://api.openai.com/v1', apiKey: '', model: 'gpt-image-2', imageDelivery: 'auto',
  custom: {
    generatePath: '/images/generations', authHeader: 'Authorization', authPrefix: 'Bearer', responseMode: 'auto',
    requestFields: { prompt: 'prompt', model: 'model', size: 'size', quality: 'quality', background: 'background', outputFormat: 'output_format' },
    responseUrlPaths: ['data[0].url'], responseBase64Paths: ['data[0].b64_json'], extraHeaders: {}, extraBody: {}
  }
};

test('runtime config persists atomically and masks key', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'gpt-image-config-'));
  try {
    const filePath = path.join(dir, 'config.json');
    const store = createRuntimeConfigStore({ filePath, defaults, allowInsecureUpstream: false });
    const first = await store.load();
    assert.equal(first.revision, 0);
    const updated = await store.update({ expectedRevision: 0, patch: { model: 'gpt-image-2' }, apiKey: 'TEST_GPT_UPSTREAM_KEY_123456' });
    assert.equal(updated.revision, 1);
    assert.equal(store.toPublic(updated).apiKeyConfigured, true);
    assert.equal(store.toPublic(updated).apiKey, undefined);
    const disk = JSON.parse(await readFile(filePath, 'utf8'));
    assert.equal(disk.apiKey, 'TEST_GPT_UPSTREAM_KEY_123456');
    await assert.rejects(() => store.update({ expectedRevision: 0, patch: { model: 'wrong' } }), /another device/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
