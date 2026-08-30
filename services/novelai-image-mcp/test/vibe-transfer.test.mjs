import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createVibeEncodingCache } from "../src/vibe-transfer.mjs";

test("persistent vibe cache keeps information/model variants and reuses them after switching back", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "nai-vibe-cache-"));
  let calls = 0;
  try {
    const cache = createVibeEncodingCache({ directory: dir });
    await cache.initialize();
    const common = {
      slotId: "b".repeat(64),
      imageSha256: "a".repeat(64),
      modelId: "nai-diffusion-4-5-full",
      informationExtracted: 1,
      encode: async () => {
        calls += 1;
        return Buffer.from(`encoded-${calls}`);
      }
    };

    const first = await cache.getOrCreate(common);
    assert.equal(first.cached, false);

    const differentInfo = await cache.getOrCreate({
      ...common,
      informationExtracted: 0.8
    });
    assert.equal(differentInfo.cached, false);

    const differentModel = await cache.getOrCreate({
      ...common,
      modelId: "nai-diffusion-4-5-curated"
    });
    assert.equal(differentModel.cached, false);
    assert.equal(calls, 3);

    const backToOriginal = await cache.getOrCreate(common);
    assert.equal(backToOriginal.cached, true);
    assert.equal(calls, 3);

    const reopened = createVibeEncodingCache({ directory: dir });
    await reopened.initialize();
    const afterRestart = await reopened.getOrCreate(common);
    assert.equal(afterRestart.cached, true);
    assert.equal(calls, 3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("deleting one vibe slot removes every cached model/info variant owned by that image only", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "nai-vibe-cache-delete-"));
  let calls = 0;
  try {
    const cache = createVibeEncodingCache({ directory: dir });
    await cache.initialize();
    const firstSlot = "c".repeat(64);
    const secondSlot = "d".repeat(64);
    const encode = async () => {
      calls += 1;
      return Buffer.from(`encoded-${calls}`);
    };

    await cache.getOrCreate({
      slotId: firstSlot,
      imageSha256: "1".repeat(64),
      modelId: "model-a",
      informationExtracted: 1,
      encode
    });
    await cache.getOrCreate({
      slotId: firstSlot,
      imageSha256: "1".repeat(64),
      modelId: "model-b",
      informationExtracted: 0.7,
      encode
    });
    await cache.getOrCreate({
      slotId: secondSlot,
      imageSha256: "2".repeat(64),
      modelId: "model-a",
      informationExtracted: 1,
      encode
    });
    assert.equal(calls, 3);

    await cache.removeBySlotId(firstSlot);

    const firstSlotAgain = await cache.getOrCreate({
      slotId: firstSlot,
      imageSha256: "1".repeat(64),
      modelId: "model-a",
      informationExtracted: 1,
      encode
    });
    assert.equal(firstSlotAgain.cached, false);

    const secondSlotStillThere = await cache.getOrCreate({
      slotId: secondSlot,
      imageSha256: "2".repeat(64),
      modelId: "model-a",
      informationExtracted: 1,
      encode
    });
    assert.equal(secondSlotStillThere.cached, true);
    assert.equal(calls, 4);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("initialization removes legacy flat anonymous cache files so they cannot become ghosts", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "nai-vibe-cache-legacy-"));
  try {
    const legacy = path.join(dir, `${"e".repeat(64)}.bin`);
    await writeFile(legacy, Buffer.from("old-cache"));
    const cache = createVibeEncodingCache({ directory: dir });
    await cache.initialize();
    await assert.rejects(
      import("node:fs/promises").then(({ readFile }) => readFile(legacy)),
      error => error?.code === "ENOENT"
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
