import path from "node:path";
import { resolveProfileSettings } from "./profiles.mjs";

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
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
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
function jsonObject(name, fallback = {}) {
  const raw = optional(name);
  if (!raw) return fallback;
  const value = JSON.parse(raw);
  if (!value || Array.isArray(value) || typeof value !== "object") throw new Error(`${name} must be a JSON object`);
  return value;
}
function stripTrailingSlash(value) { return value.replace(/\/+$/, ""); }
function normalizeToken(value) { return value.replace(/^Bearer\s+/i, "").trim(); }

const profile = resolveProfileSettings(process.env);
const publicBaseUrl = stripTrailingSlash(required("PUBLIC_BASE_URL"));
if (!publicBaseUrl.startsWith("https://") && !publicBaseUrl.startsWith("http://localhost")) {
  throw new Error("PUBLIC_BASE_URL must use HTTPS, except localhost testing");
}

export const staticConfig = Object.freeze({
  host: optional("HOST", "127.0.0.1"),
  port: portNumber("PORT", 18121),
  publicBaseUrl,
  mcpBearerToken: normalizeToken(required("MCP_BEARER_TOKEN")),
  runtimeConfigFile: path.resolve(optional("RUNTIME_CONFIG_FILE", "/var/lib/novelai-image-mcp/config.json")),
  imageDir: path.resolve(optional("IMAGE_DIR", "./data/images")),
  imageTtlMs: positiveInteger("IMAGE_TTL_HOURS", 24) * 3_600_000,
  allowInsecureUpstream: booleanValue("ALLOW_INSECURE_UPSTREAM", false),
  upstreamTimeoutMs: positiveInteger("UPSTREAM_TIMEOUT_MS", 180_000),
  upstreamParamsVersion: positiveInteger("UPSTREAM_PARAMS_VERSION", 3),
  requestImageFormat: optional("REQUEST_IMAGE_FORMAT", "webp").toLowerCase(),
  upstreamExtraHeaders: jsonObject("UPSTREAM_EXTRA_HEADERS_JSON"),
  upstreamBodyOverrides: jsonObject("UPSTREAM_BODY_OVERRIDES_JSON"),
  upstreamParameterOverrides: jsonObject("UPSTREAM_PARAMETER_OVERRIDES_JSON")
});

export const bootstrapRuntimeConfig = Object.freeze({
  profile: profile.profileName,
  baseUrl: stripTrailingSlash(profile.baseUrl || optional("UPSTREAM_BASE_URL")),
  apiKey: optional("UPSTREAM_API_KEY"),
  generatePath: profile.generatePath,
  authHeader: profile.authHeader,
  authPrefix: profile.authPrefix,
  modelFull: profile.modelFull,
  modelCurated: profile.modelCurated,
  responseMode: profile.responseMode,
  imageDelivery: optional("UPSTREAM_IMAGE_DELIVERY", "auto").toLowerCase(),
  accept: profile.accept,
  promptLanguagePolicy: profile.promptLanguagePolicy
});
