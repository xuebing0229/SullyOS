import assert from 'node:assert/strict';
import http from 'node:http';
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createBackgroundJobService,
} from '../src/background-jobs.mjs';

const TOKEN = 'test-token-not-secret';

const waitFor = async (fn, timeoutMs = 3000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('waitFor timeout');
};

const fixture = async executeTool => {
  const dir = await mkdtemp(
    path.join(os.tmpdir(), 'sully-image-jobs-'),
  );
  const service = await createBackgroundJobService({
    dataDir: dir,
    allowedToolName: 'generate_image',
    authToken: TOKEN,
    maxConcurrency: 1,
    retentionMs: 60_000,
    maxRecords: 50,
    executeTool,
    logger: {
      info() {},
      warn() {},
      error() {},
    },
  });

  const server = http.createServer(async (req, res) => {
    if (await service.handle(req, res)) return;
    res.statusCode = 404;
    res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;

  const request = async (pathname, init = {}, token = TOKEN) => {
    const response = await fetch(`${base}${pathname}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...(init.headers || {}),
      },
    });
    const body = await response.json().catch(() => null);
    return { response, body };
  };

  const close = async () => {
    await service.stop();
    await new Promise(resolve => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  };

  return { dir, service, request, close };
};

test('creates, executes, persists and queries a job', async () => {
  let calls = 0;
  const fx = await fixture(async (_tool, args) => {
    calls += 1;
    return {
      success: true,
      structuredContent: {
        imageUrl: `https://image.invalid/${args.prompt}.png`,
      },
      content: [],
    };
  });

  try {
    const payload = {
      clientRequestId: 'sully_test_create_001',
      toolName: 'generate_image',
      arguments: { prompt: 'cat' },
    };
    const submitted = await fx.request('/jobs', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    assert.equal(submitted.response.status, 202);
    assert.equal(submitted.body.created, true);
    const id = submitted.body.job.id;

    const succeeded = await waitFor(async () => {
      const current = await fx.request(`/jobs/${id}`);
      return current.body.job.status === 'succeeded'
        ? current.body.job
        : null;
    });

    assert.equal(calls, 1);
    assert.equal(
      succeeded.result.structuredContent.imageUrl,
      'https://image.invalid/cat.png',
    );

    const byClient = await fx.request(
      '/jobs/by-client/sully_test_create_001',
    );
    assert.equal(byClient.response.status, 200);
    assert.equal(byClient.body.job.id, id);

    const names = await readdir(fx.dir);
    assert.equal(names.filter(name => name.endsWith('.json')).length, 1);
    const raw = await readFile(path.join(fx.dir, names[0]), 'utf8');
    assert.equal(raw.includes(TOKEN), false);
  } finally {
    await fx.close();
  }
});

test('same client request is idempotent and does not execute twice', async () => {
  let calls = 0;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const fx = await fixture(async () => {
    calls += 1;
    await gate;
    return {
      success: true,
      structuredContent: { imageUrl: 'https://image.invalid/once.png' },
      content: [],
    };
  });

  try {
    const payload = {
      clientRequestId: 'sully_test_idempotent_001',
      toolName: 'generate_image',
      arguments: { prompt: 'once' },
    };
    const first = await fx.request('/jobs', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    const second = await fx.request('/jobs', {
      method: 'POST',
      body: JSON.stringify(payload),
    });

    assert.equal(first.response.status, 202);
    assert.equal(second.response.status, 200);
    assert.equal(second.body.created, false);
    assert.equal(first.body.job.id, second.body.job.id);

    release();
    await waitFor(async () => {
      const current = await fx.request(`/jobs/${first.body.job.id}`);
      return current.body.job.status === 'succeeded';
    });
    assert.equal(calls, 1);
  } finally {
    release?.();
    await fx.close();
  }
});

test('same client id with different arguments returns 409', async () => {
  const fx = await fixture(async () => ({
    success: true,
    structuredContent: { imageUrl: 'https://image.invalid/x.png' },
    content: [],
  }));

  try {
    const first = await fx.request('/jobs', {
      method: 'POST',
      body: JSON.stringify({
        clientRequestId: 'sully_test_conflict_001',
        toolName: 'generate_image',
        arguments: { prompt: 'cat' },
      }),
    });
    assert.equal(first.response.status, 202);

    const second = await fx.request('/jobs', {
      method: 'POST',
      body: JSON.stringify({
        clientRequestId: 'sully_test_conflict_001',
        toolName: 'generate_image',
        arguments: { prompt: 'dog' },
      }),
    });
    assert.equal(second.response.status, 409);
    assert.equal(second.body.error, 'client_request_conflict');
  } finally {
    await fx.close();
  }
});

test('unknown job uses exact client-compatible 404 shape', async () => {
  const fx = await fixture(async () => ({}));
  try {
    const result = await fx.request('/jobs/imgjob_missing_001');
    assert.equal(result.response.status, 404);
    assert.equal(result.body.error, 'job_not_found');
  } finally {
    await fx.close();
  }
});

test('rejects wrong bearer and unsupported tool without execution', async () => {
  let calls = 0;
  const fx = await fixture(async () => {
    calls += 1;
    return {};
  });

  try {
    const unauthorized = await fx.request(
      '/jobs/imgjob_missing_002',
      {},
      'wrong',
    );
    assert.equal(unauthorized.response.status, 401);

    const unsupported = await fx.request('/jobs', {
      method: 'POST',
      body: JSON.stringify({
        clientRequestId: 'sully_test_bad_tool_001',
        toolName: 'other_tool',
        arguments: {},
      }),
    });
    assert.equal(unsupported.response.status, 400);
    assert.equal(unsupported.body.error, 'unsupported_tool');
    assert.equal(calls, 0);
  } finally {
    await fx.close();
  }
});

test('tool failure becomes a terminal failed job', async () => {
  const fx = await fixture(async () => {
    throw new Error(
      'Authorization: secret Bearer abc123 https://private.invalid/path',
    );
  });

  try {
    const submitted = await fx.request('/jobs', {
      method: 'POST',
      body: JSON.stringify({
        clientRequestId: 'sully_test_failure_001',
        toolName: 'generate_image',
        arguments: { prompt: 'fail' },
      }),
    });
    const id = submitted.body.job.id;

    const failed = await waitFor(async () => {
      const current = await fx.request(`/jobs/${id}`);
      return current.body.job.status === 'failed'
        ? current.body.job
        : null;
    });

    assert.equal(failed.error.code, 'tool_execution_failed');
    assert.equal(failed.error.message.includes('secret'), false);
    assert.equal(failed.error.message.includes('abc123'), false);
    assert.equal(failed.error.message.includes('private.invalid'), false);
  } finally {
    await fx.close();
  }
});

test('running job found on restart is failed and not replayed', async () => {
  const dir = await mkdtemp(
    path.join(os.tmpdir(), 'sully-image-jobs-restart-'),
  );
  const id = 'imgjob_restart_001';
  const job = {
    version: 1,
    id,
    clientRequestId: 'sully_restart_client_001',
    toolName: 'generate_image',
    arguments: { prompt: 'maybe already billed' },
    argumentsHash: 'hash',
    status: 'running',
    createdAt: 1,
    updatedAt: 2,
    startedAt: 2,
  };
  await writeFile(
    path.join(dir, `${id}.json`),
    JSON.stringify(job),
    { mode: 0o600 },
  );

  let calls = 0;
  const service = await createBackgroundJobService({
    dataDir: dir,
    allowedToolName: 'generate_image',
    authToken: TOKEN,
    executeTool: async () => {
      calls += 1;
      return {};
    },
    logger: { info() {}, warn() {}, error() {} },
  });

  try {
    const restored = service.getById(id);
    assert.equal(restored.status, 'failed');
    assert.equal(
      restored.error.code,
      'server_restarted_during_execution',
    );
    assert.equal(calls, 0);
  } finally {
    await service.stop();
    await rm(dir, { recursive: true, force: true });
  }
});
