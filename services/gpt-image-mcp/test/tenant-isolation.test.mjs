import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRuntimeConfigStore } from "../src/runtime-config.mjs";
import { createBearerTenantRegistry, tenantChildPath, tenantConfigPath } from "../src/tenant-auth.mjs";

const defaults = {
  mode: "compatible",
  baseUrl: "https://api.openai.com/v1",
  apiKey: "OWNER_BOOTSTRAP_KEY",
  model: "gpt-image-2",
  imageDelivery: "auto",
  custom: {
    generatePath: "/images/generations",
    authHeader: "Authorization",
    authPrefix: "Bearer",
    responseMode: "auto",
    requestFields: { prompt: "prompt", model: "model", size: "size", quality: "quality", background: "background", outputFormat: "output_format" },
    responseUrlPaths: ["data[0].url"],
    responseBase64Paths: ["data[0].b64_json"],
    extraHeaders: {},
    extraBody: {}
  }
};

test("extra GPT token gets a separate config and does not inherit owner API key", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gpt-tenant-"));
  try {
    const registry = createBearerTenantRegistry({
      primaryToken: "owner-token",
      env: { MCP_EXTRA_BEARER_TOKENS: "friend-token" }
    });
    const owner = registry.resolve("owner-token");
    const friend = registry.resolve("friend-token");
    const primaryConfig = path.join(root, "config.json");

    const ownerStore = createRuntimeConfigStore({
      filePath: tenantConfigPath(primaryConfig, owner),
      defaults,
      allowInsecureUpstream: false
    });
    const friendStore = createRuntimeConfigStore({
      filePath: tenantConfigPath(primaryConfig, friend),
      defaults: { ...defaults, apiKey: "" },
      allowInsecureUpstream: false
    });

    assert.equal((await ownerStore.load()).apiKey, "OWNER_BOOTSTRAP_KEY");
    assert.equal((await friendStore.load()).apiKey, "");
    await friendStore.update({ expectedRevision: 0, patch: {}, apiKey: "FRIEND_KEY" });
    assert.equal((await friendStore.load()).apiKey, "FRIEND_KEY");
    assert.equal((await ownerStore.load()).apiKey, "OWNER_BOOTSTRAP_KEY");
    assert.notEqual(tenantChildPath(path.join(root, "images"), owner), tenantChildPath(path.join(root, "images"), friend));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
