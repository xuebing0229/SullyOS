import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createPersistentImageJobQueue
} from "../src/jobs.mjs";

const tempDir = () =>
  mkdtemp(path.join(os.tmpdir(), "sully-image-jobs-"));

async function waitFor(predicate, timeoutMs = 2000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = await predicate();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for condition");
}

test("enqueue returns before executor completes", async () => {
  const directory = await tempDir();
  let release;
  const gate = new Promise(resolve => { release = resolve; });

  const queue = createPersistentImageJobQueue({
    directory,
    ttlMs: 60_000,
    execute: async input => {
      assert.equal(input.executionContext.runtime.apiKey, "secret-key");
      await gate;
      return {
        structuredContent: {
          imageUrl: "https://example.test/image.png"
        }
      };
    }
  });

  await queue.initialize();
  const startedAt = Date.now();
  const result = await queue.enqueue({
    clientRequestId: "client_request_0001",
    toolName: "generate_image",
    arguments: { prompt: "hello" },
    executionContext: {
      runtime: {
        revision: 1,
        apiKey: "secret-key"
      }
    }
  });

  assert.equal(result.created, true);
  assert.ok(Date.now() - startedAt < 500);
  assert.equal(result.job.executionContext, undefined);
  assert.equal(result.job.arguments, undefined);
  assert.equal(JSON.stringify(result.job).includes("secret-key"), false);

  release();
  const completed = await waitFor(() => {
    const job = queue.getById(result.job.id);
    return job?.status === "succeeded" ? job : null;
  });

  assert.equal(
    completed.result.structuredContent.imageUrl,
    "https://example.test/image.png"
  );

  await rm(directory, { recursive: true, force: true });
});

test("same clientRequestId is idempotent", async () => {
  const directory = await tempDir();
  let calls = 0;

  const queue = createPersistentImageJobQueue({
    directory,
    ttlMs: 60_000,
    execute: async () => {
      calls++;
      return { ok: true };
    }
  });

  await queue.initialize();

  const input = {
    clientRequestId: "client_request_0002",
    toolName: "generate_image",
    arguments: { prompt: "same" },
    executionContext: {
      runtime: {
        revision: 1,
        apiKey: "old-key"
      }
    }
  };

  const first = await queue.enqueue(input);

  // 重交时即使外部当前配置已经变化，也必须返回原任务。
  const second = await queue.enqueue({
    ...input,
    executionContext: {
      runtime: {
        revision: 2,
        apiKey: "new-key"
      }
    }
  });

  assert.equal(first.job.id, second.job.id);
  assert.equal(second.created, false);

  await waitFor(
    () => queue.getById(first.job.id)?.status === "succeeded"
  );

  assert.equal(calls, 1);
  await rm(directory, { recursive: true, force: true });
});

test("same clientRequestId with different args conflicts", async () => {
  const directory = await tempDir();
  const queue = createPersistentImageJobQueue({
    directory,
    ttlMs: 60_000,
    execute: async () => ({ ok: true })
  });

  await queue.initialize();

  await queue.enqueue({
    clientRequestId: "client_request_0003",
    toolName: "generate_image",
    arguments: { prompt: "A" },
    executionContext: { runtime: { apiKey: "key" } }
  });

  await assert.rejects(
    () => queue.enqueue({
      clientRequestId: "client_request_0003",
      toolName: "generate_image",
      arguments: { prompt: "B" },
      executionContext: { runtime: { apiKey: "key" } }
    }),
    error => error.code === "IDEMPOTENCY_CONFLICT"
  );
  await waitFor(
    () => queue.getByClientRequestId("client_request_0003")?.status === "succeeded"
  );
  queue.shutdown();
  await rm(directory, { recursive: true, force: true });
});

test("job file stores private snapshot but public API hides it", async () => {
  const directory = await tempDir();
  let release;
  const gate = new Promise(resolve => { release = resolve; });

  const queue = createPersistentImageJobQueue({
    directory,
    ttlMs: 60_000,
    execute: async () => {
      await gate;
      return { ok: true };
    }
  });

  await queue.initialize();
  const created = await queue.enqueue({
    clientRequestId: "client_request_0004",
    toolName: "generate_image",
    arguments: { prompt: "private" },
    executionContext: {
      runtime: { apiKey: "snapshot-secret" }
    }
  });

  const raw = await readFile(
    path.join(directory, `${created.job.id}.json`),
    "utf8"
  );

  assert.equal(raw.includes("snapshot-secret"), true);
  assert.equal(JSON.stringify(queue.getById(created.job.id)).includes("snapshot-secret"), false);

  release();
  await rm(directory, { recursive: true, force: true });
});
