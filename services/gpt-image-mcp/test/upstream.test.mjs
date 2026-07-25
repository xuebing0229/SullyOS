import assert from 'node:assert/strict';
import test from 'node:test';
import { buildUpstreamRequest, deepGet, deepSet } from '../src/upstream.mjs';

const compatible = { mode: 'compatible', baseUrl: 'https://api.example/v1', apiKey: 'secret', model: 'gpt-image-2', imageDelivery: 'auto' };

test('compatible mode uses OpenAI Images path and body', () => {
  const request = buildUpstreamRequest({ prompt: 'cat', config: compatible });
  assert.equal(request.url, 'https://api.example/v1/images/generations');
  assert.equal(request.payload.model, 'gpt-image-2');
  assert.equal(request.payload.prompt, 'cat');
});

test('custom mode maps fields without executing code', () => {
  const config = {
    ...compatible,
    mode: 'custom',
    custom: {
      generatePath: '/draw', authHeader: 'X-Key', authPrefix: '', responseMode: 'json',
      requestFields: { prompt: 'input.text', model: 'model_id', size: 'options.size', quality: '', background: '', outputFormat: '' },
      responseUrlPaths: ['result.url'], responseBase64Paths: ['result.base64'], extraHeaders: {}, extraBody: { fixed: true }
    }
  };
  const request = buildUpstreamRequest({ prompt: 'cat', size: '1024x1024', config });
  assert.equal(request.url, 'https://api.example/v1/draw');
  assert.equal(deepGet(request.payload, 'input.text'), 'cat');
  assert.equal(deepGet(request.payload, 'options.size'), '1024x1024');
  assert.equal(request.payload.fixed, true);
  const target = {};
  deepSet(target, 'data[0].url', 'https://x/image.png');
  assert.equal(deepGet(target, 'data[0].url'), 'https://x/image.png');
});
