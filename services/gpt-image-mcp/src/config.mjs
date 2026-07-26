import path from "node:path";

function optional(name, fallback = "") {
  const value = process.env[name];
  return value === undefined ? fallback : value.trim();
}

function required(name) {
  const value = optional(name);
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function positiveInteger(name, fallback) {
  const raw = optional(name);
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function portNumber(name, fallback) {
  const value = positiveInteger(name, fallback);
  if (value > 65535) throw new Error(`${name} must be between 1 and 65535`);
  return value;
}

function booleanValue(name, fallback = false) {
  const raw = optional(name).toLowerCase();
  if (!raw) return fallback;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  throw new Error(`${name} must be true or false`);
}

function stripTrailingSlash(value) {
  return value.replace(/\/+$/, "");
}

function normalizeToken(value) {
  return value.replace(/^Bearer\s+/i, "").trim();
}

const publicImageBaseUrl = stripTrailingSlash(required("PUBLIC_IMAGE_BASE_URL"));
if (
  !publicImageBaseUrl.startsWith("https://") &&
  !publicImageBaseUrl.startsWith("http://localhost")
) {
  throw new Error("PUBLIC_IMAGE_BASE_URL must use HTTPS, except localhost testing");
}

export const staticConfig = Object.freeze({
  host: optional("HOST", "127.0.0.1"),
  port: portNumber("PORT", 18120),
  mcpBearerToken: normalizeToken(required("MCP_BEARER_TOKEN")),
  publicImageBaseUrl,
  runtimeConfigFile: path.resolve(
    optional("RUNTIME_CONFIG_FILE", "./data/config.json")
  ),
  imageDir: path.resolve(optional("IMAGE_DIR", "./data/images")),
  imageTtlMs: positiveInteger("IMAGE_TTL_HOURS", 24) * 3_600_000,
  upstreamTimeoutMs: positiveInteger("UPSTREAM_TIMEOUT_MS", 180_000),
  allowInsecureUpstream: booleanValue("ALLOW_INSECURE_UPSTREAM", false)
});

export const bootstrapRuntimeConfig = Object.freeze({
  mode: optional("BOOTSTRAP_MODE", "compatible").toLowerCase(),
  baseUrl: stripTrailingSlash(
    optional("BOOTSTRAP_BASE_URL", "https://api.openai.com/v1")
  ),
  apiKey: optional("BOOTSTRAP_API_KEY"),
  model: optional("BOOTSTRAP_MODEL", "gpt-image-2"),
  imageDelivery: optional("BOOTSTRAP_IMAGE_DELIVERY", "auto").toLowerCase(),
  custom: {
    generatePath: "/images/generations",
    authHeader: "Authorization",
    authPrefix: "Bearer",
    responseMode: "auto",
    requestFields: {
      prompt: "prompt",
      model: "model",
      size: "size",
      quality: "quality",
      background: "background",
      outputFormat: "output_format"
    },
    responseUrlPaths: ["data[0].url", "images[0].url", "url"],
    responseBase64Paths: [
      "data[0].b64_json",
      "data[0].base64",
      "images[0].b64_json",
      "images[0].base64",
      "b64_json",
      "base64"
    ],
    extraHeaders: {},
    extraBody: {}
  }
});
