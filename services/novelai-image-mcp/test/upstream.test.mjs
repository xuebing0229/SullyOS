import assert from "node:assert/strict";
import test from "node:test";
import { zipSync } from "fflate";

import {
  assertPromptPolicy,
  buildUpstreamHeaders,
  buildUpstreamRequest,
  parseUpstreamResponse
} from "../src/upstream.mjs";

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z8ZkAAAAASUVORK5CYII=",
  "base64"
);

const baseConfig = {
  upstreamAccept: "application/json",
  upstreamExtraHeaders: {},
  upstreamAuthHeader: "Authorization",
  upstreamAuthPrefix: "Bearer",
  upstreamApiKey: "test-key",
  upstreamModelFull: "custom-full",
  upstreamModelCurated: "custom-curated",
  upstreamParamsVersion: 3,
  upstreamParameterOverrides: {},
  upstreamBodyOverrides: {},
  promptLanguagePolicy: "allow",
  requestImageFormat: "webp",
  upstreamResponseMode: "auto",
  upstreamBaseUrl: "https://api.example.com",
  upstreamTimeoutMs: 30_000
};

test("custom sk-style keys are accepted without prefix validation", () => {
  const headers = buildUpstreamHeaders(
    { ...baseConfig, upstreamApiKey: "sk-example" },
    "abc"
  );
  assert.equal(headers.Authorization, "Bearer sk-example");
});

test("custom auth header and empty prefix are supported", () => {
  const headers = buildUpstreamHeaders(
    {
      ...baseConfig,
      upstreamAuthHeader: "X-API-Key",
      upstreamAuthPrefix: ""
    },
    "abc"
  );
  assert.equal(headers["X-API-Key"], "test-key");
});

test("CJK prompts are allowed by default", () => {
  assert.doesNotThrow(() => assertPromptPolicy("一个女孩", "allow"));
});

test("english-only remains available as an opt-in policy", () => {
  assert.throws(
    () => assertPromptPolicy("一个女孩", "english-only"),
    /English-only/
  );
});

test("custom model mapping and payload overrides are applied", () => {
  const result = buildUpstreamRequest({
    prompt: "1girl",
    model: "full",
    size: "portrait",
    seed: 7,
    config: {
      ...baseConfig,
      upstreamBodyOverrides: { extra_mode: "station-specific" },
      upstreamParameterOverrides: { custom_flag: true }
    }
  });

  assert.equal(result.payload.model, "custom-full");
  assert.equal(result.payload.extra_mode, "station-specific");
  assert.equal(result.payload.parameters.custom_flag, true);
});

test("NovelAI-style JSON base64 is parsed", async () => {
  const response = new Response(
    JSON.stringify({
      images: [{ image: PNG_1X1.toString("base64"), seed: 123 }]
    }),
    {
      status: 200,
      headers: { "content-type": "application/json" }
    }
  );

  const parsed = await parseUpstreamResponse({
    response,
    config: baseConfig,
    requestId: "abc",
    fallbackSeed: 1
  });

  assert.equal(parsed.format, "png");
  assert.equal(parsed.seed, 123);
});

test("OpenAI-like data[0].b64_json is parsed", async () => {
  const response = new Response(
    JSON.stringify({
      data: [{ b64_json: PNG_1X1.toString("base64") }]
    }),
    {
      status: 200,
      headers: { "content-type": "application/json" }
    }
  );

  const parsed = await parseUpstreamResponse({
    response,
    config: baseConfig,
    requestId: "abc",
    fallbackSeed: 9
  });

  assert.equal(parsed.format, "png");
  assert.equal(parsed.seed, 9);
});

test("raw image responses are parsed", async () => {
  const response = new Response(PNG_1X1, {
    status: 200,
    headers: { "content-type": "image/png" }
  });

  const parsed = await parseUpstreamResponse({
    response,
    config: baseConfig,
    requestId: "abc",
    fallbackSeed: 9
  });

  assert.equal(parsed.format, "png");
});

test("ZIP image responses are parsed", async () => {
  const zip = zipSync({ "image.png": new Uint8Array(PNG_1X1) });
  const response = new Response(zip, {
    status: 200,
    headers: { "content-type": "application/zip" }
  });

  const parsed = await parseUpstreamResponse({
    response,
    config: baseConfig,
    requestId: "abc",
    fallbackSeed: 9
  });

  assert.equal(parsed.format, "png");
});


test("JSON image URL responses are downloaded without leaking auth to a foreign CDN", async () => {
  const originalFetch = globalThis.fetch;
  let receivedHeaders;
  globalThis.fetch = async (_url, options) => {
    receivedHeaders = options?.headers;
    return new Response(PNG_1X1, {
      status: 200,
      headers: { "content-type": "image/png" }
    });
  };

  try {
    const response = new Response(
      JSON.stringify({ data: [{ url: "https://cdn.example.net/generated.png", seed: 77 }] }),
      { status: 200, headers: { "content-type": "application/json" } }
    );

    const parsed = await parseUpstreamResponse({
      response,
      config: baseConfig,
      requestId: "abc",
      fallbackSeed: 9
    });

    assert.equal(parsed.format, "png");
    assert.equal(parsed.seed, 77);
    assert.equal(receivedHeaders.Authorization, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});


test("streaming NDJSON with a relative success URL is parsed", async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl;
  let receivedHeaders;
  globalThis.fetch = async (url, options) => {
    requestedUrl = String(url);
    receivedHeaders = options?.headers;
    return new Response(PNG_1X1, {
      status: 200,
      headers: { "content-type": "image/png" }
    });
  };

  try {
    const response = new Response(
      [
        JSON.stringify({ status: "queued", position: 1 }),
        JSON.stringify({ status: "running" }),
        JSON.stringify({ status: "success", url: "/img/result.png" })
      ].join("\n") + "\n",
      {
        status: 200,
        headers: { "content-type": "application/x-ndjson" }
      }
    );

    const parsed = await parseUpstreamResponse({
      response,
      config: baseConfig,
      requestId: "abc",
      fallbackSeed: 19
    });

    assert.equal(parsed.format, "png");
    assert.equal(parsed.seed, 19);
    assert.equal(requestedUrl, "https://api.example.com/img/result.png");
    assert.equal(receivedHeaders.Authorization, "Bearer test-key");
  } finally {
    globalThis.fetch = originalFetch;
  }
});


test("image delivery auto returns same-origin HTTPS URLs directly", async () => {
  const response = new Response(
    JSON.stringify({ url: "/img/direct.png", seed: 31 }),
    { status: 200, headers: { "content-type": "application/json" } }
  );

  const parsed = await parseUpstreamResponse({
    response,
    config: { ...baseConfig, upstreamImageDelivery: "auto" },
    requestId: "abc",
    fallbackSeed: 1
  });

  assert.equal(parsed.imageUrl, "https://api.example.com/img/direct.png");
  assert.equal(parsed.imageBuffer, undefined);
  assert.equal(parsed.seed, 31);
});

test("image delivery proxy downloads same-origin URL responses", async () => {
  const originalFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    return new Response(PNG_1X1, {
      status: 200,
      headers: { "content-type": "image/png" }
    });
  };

  try {
    const response = new Response(
      JSON.stringify({ url: "/img/proxy.png" }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
    const parsed = await parseUpstreamResponse({
      response,
      config: { ...baseConfig, upstreamImageDelivery: "proxy" },
      requestId: "abc",
      fallbackSeed: 2
    });
    assert.equal(called, true);
    assert.equal(parsed.format, "png");
    assert.ok(Buffer.isBuffer(parsed.imageBuffer));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("image delivery direct rejects binary-only responses", async () => {
  const response = new Response(PNG_1X1, {
    status: 200,
    headers: { "content-type": "image/png" }
  });

  await assert.rejects(
    parseUpstreamResponse({
      response,
      config: { ...baseConfig, upstreamImageDelivery: "direct" },
      requestId: "abc",
      fallbackSeed: 3
    }),
    /did not return an image URL/
  );
});

test("image delivery direct rejects cross-origin image URLs", async () => {
  const response = new Response(
    JSON.stringify({ url: "https://cdn.example.net/image.png" }),
    { status: 200, headers: { "content-type": "application/json" } }
  );

  await assert.rejects(
    parseUpstreamResponse({
      response,
      config: { ...baseConfig, upstreamImageDelivery: "direct" },
      requestId: "abc",
      fallbackSeed: 4
    }),
    /same-origin HTTPS/
  );
});
