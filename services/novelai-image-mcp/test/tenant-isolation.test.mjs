import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createNovelRuntimeConfigStore } from "../src/runtime-config.mjs";
import { createBearerTenantRegistry, tenantChildPath, tenantConfigPath } from "../src/tenant-auth.mjs";

const bootstrap = {
  profile: "official",
  baseUrl: "https://image.novelai.net",
  apiKey: "OWNER_BOOTSTRAP_KEY",
  generatePath: "/ai/generate-image",
  modelsPath: "/ai/generate-image",
  authHeader: "Authorization",
  authPrefix: "Bearer",
  modelFull: "nai-diffusion-4-5-full",
  modelCurated: "nai-diffusion-4-5-curated",
  responseMode: "auto",
  imageDelivery: "auto",
  accept: "application/json, image/png",
  promptLanguagePolicy: "allow"
};

test("extra NovelAI token gets separate config/reference/vibe roots and no owner API key", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nai-tenant-"));
  try {
    const registry = createBearerTenantRegistry({
      primaryToken: "owner-token",
      env: { MCP_EXTRA_BEARER_TOKENS: "friend-token" }
    });
    const owner = registry.resolve("owner-token");
    const friend = registry.resolve("friend-token");
    const primaryConfig = path.join(root, "config.json");

    const ownerStore = createNovelRuntimeConfigStore({
      filePath: tenantConfigPath(primaryConfig, owner),
      bootstrap,
      allowInsecureUpstream: false
    });
    const friendStore = createNovelRuntimeConfigStore({
      filePath: tenantConfigPath(primaryConfig, friend),
      bootstrap: { ...bootstrap, apiKey: "" },
      allowInsecureUpstream: false
    });

    assert.equal((await ownerStore.load()).apiKey, "OWNER_BOOTSTRAP_KEY");
    assert.equal((await friendStore.load()).apiKey, "");
    await friendStore.update({ expectedRevision: 0, patch: {}, apiKey: "FRIEND_KEY" });
    assert.equal((await friendStore.load()).apiKey, "FRIEND_KEY");
    assert.equal((await ownerStore.load()).apiKey, "OWNER_BOOTSTRAP_KEY");

    const ownerImages = tenantChildPath(path.join(root, "images"), owner);
    const friendImages = tenantChildPath(path.join(root, "images"), friend);
    assert.notEqual(ownerImages, friendImages);
    assert.notEqual(path.join(ownerImages, "references"), path.join(friendImages, "references"));
    assert.notEqual(path.join(ownerImages, "vibe-cache"), path.join(friendImages, "vibe-cache"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
