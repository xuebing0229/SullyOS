import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeProfileName,
  resolveProfileSettings
} from "../src/profiles.mjs";

test("official preset fills all standard official values", () => {
  const profile = resolveProfileSettings({
    UPSTREAM_PROFILE: "official"
  });

  assert.equal(profile.baseUrl, "https://image.novelai.net");
  assert.equal(profile.generatePath, "/ai/generate-image");
  assert.equal(profile.authHeader, "Authorization");
  assert.equal(profile.authPrefix, "Bearer");
  assert.equal(profile.modelFull, "nai-diffusion-4-5-full");
});

test("standard preset only needs the station URL", () => {
  const profile = resolveProfileSettings({
    UPSTREAM_PROFILE: "standard",
    UPSTREAM_BASE_URL: "https://station.example"
  });

  assert.equal(profile.baseUrl, "https://station.example");
  assert.equal(profile.generatePath, "/ai/generate-image");
  assert.equal(profile.authHeader, "Authorization");
});

test("custom preset accepts advanced overrides", () => {
  const profile = resolveProfileSettings({
    UPSTREAM_PROFILE: "custom",
    UPSTREAM_BASE_URL: "https://station.example",
    UPSTREAM_GENERATE_PATH: "/v1/custom-image",
    UPSTREAM_AUTH_HEADER: "X-API-Key",
    UPSTREAM_AUTH_PREFIX: "",
    UPSTREAM_MODEL_FULL: "station-model"
  });

  assert.equal(profile.generatePath, "/v1/custom-image");
  assert.equal(profile.authHeader, "X-API-Key");
  assert.equal(profile.authPrefix, "");
  assert.equal(profile.modelFull, "station-model");
});

test("explicit values override preset defaults", () => {
  const profile = resolveProfileSettings({
    UPSTREAM_PROFILE: "official",
    UPSTREAM_RESPONSE_MODE: "zip"
  });
  assert.equal(profile.responseMode, "zip");
});

test("unknown preset is rejected", () => {
  assert.throws(
    () => normalizeProfileName("mystery"),
    /official, standard, or custom/
  );
});
