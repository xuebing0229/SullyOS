import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createVibeEncodingCache } from "../src/vibe-transfer.mjs";

test("persistent vibe cache reuses image + model + information-extracted encodings", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "nai-vibe-cache-"));
  let calls = 0;
  try {
    const cache = createVibeEncodingCache({ directory: dir });
    await cache.initialize();
    const common = {
      imageSha256: "a".repeat(64),
      modelId: "nai-diffusion-4-5-full",
      informationExtracted: 1,
      encode: async () => {
        calls += 1;
        return Buffer.from("encoded");
      }
    };
    const first = await cache.getOrCreate(common);
    const second = await cache.getOrCreate(common);
    assert.equal(first.cached, false);
    assert.equal(second.cached, true);
    assert.equal(calls, 1);
    assert.deepEqual(first.buffer, second.buffer);

    const changedInfo = await cache.getOrCreate({
      ...common,
      informationExtracted: 0.8
    });
    assert.equal(changedInfo.cached, false);
    assert.equal(calls, 2);

    const reopened = createVibeEncodingCache({ directory: dir });
    await reopened.initialize();
    const third = await reopened.getOrCreate(common);
    assert.equal(third.cached, true);
    assert.equal(calls, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
