import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createReferenceStore } from "../src/reference-store.mjs";

function fakePng(width, height, payloadBytes = 64) {
  const buffer = Buffer.alloc(Math.max(64, payloadBytes));
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0);
  buffer.writeUInt32BE(13, 8);
  buffer.write("IHDR", 12, "ascii");
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

test("stores, heads, replaces, reads, and removes a reference slot", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "nai-ref-"));
  try {
    const store = createReferenceStore({ directory: dir });
    await store.initialize();
    const id = "a".repeat(64);

    const first = await store.put(id, fakePng(1024, 1536));
    assert.equal(first.existed, false);
    assert.equal(first.metadata.width, 1024);

    const loaded = await store.readImage(id);
    assert.equal(loaded.metadata.sha256, first.metadata.sha256);

    const secondImage = fakePng(1472, 1472, 128);
    secondImage[63] = 1;
    const second = await store.put(id, secondImage);
    assert.equal(second.existed, true);
    assert.notEqual(second.metadata.sha256, first.metadata.sha256);

    const names = await readdir(dir);
    assert.deepEqual(names.sort(), [`${id}.json`, `${id}.png`]);

    await store.remove(id);
    assert.equal(await store.getMetadata(id), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("rejects invalid slots, formats, dimensions, and checksum mismatch", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "nai-ref-"));
  try {
    const store = createReferenceStore({ directory: dir, maxBytes: 1024 });
    await assert.rejects(() => store.put("../oops", fakePng(1024, 1536)));
    await assert.rejects(() => store.put("b".repeat(64), Buffer.alloc(100)));
    await assert.rejects(() => store.put("b".repeat(64), fakePng(100, 100)));
    await assert.rejects(() =>
      store.put("b".repeat(64), fakePng(1024, 1536), "c".repeat(64))
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
