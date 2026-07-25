import path from "node:path";
import { resolveProfileSettings } from "./profiles.mjs";

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function optional(name, fallback = "") {
  const value = process.env[name];
  return value === undefined ? fallback : value.trim();
}

function positiveInteger(name, fallback) {
  const raw = process.env[name]?.trim();
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
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  throw new Error(`${name} must be true or false`);
}

function jsonObject(name, fallback = {}) {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${name} must contain valid JSON: ${error.message}`);
  }

  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new Error(`${name} must be a JSON object`);
  }
  return parsed;
}

function stripTrailingSlash(value) {
  return value.replace(/\/+$/, "");
}

function normalizePath(value) {
  const trimmed = value.trim();
  if (!trimmed) return "/ai/generate-image";
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function normalizeMcpToken(value) {
  return value.replace(/^Bearer\s+/i, "").trim();
}

const profile = resolveProfileSettings(process.env);

if (!profile.baseUrl) {
  throw new Error(
    `UPSTREAM_BASE_URL is required when UPSTREAM_PROFILE=${profile.profileName}`
  );
}

if (!["auto", "json", "image", "zip"].includes(profile.responseMode)) {
  throw new Error("UPSTREAM_RESPONSE_MODE must be auto, json, image, or zip");
}

if (!["allow", "english-only"].includes(profile.promptLanguagePolicy)) {
  throw new Error("PROMPT_LANGUAGE_POLICY must be allow or english-only");
}

const upstreamImageDelivery = optional(
  "UPSTREAM_IMAGE_DELIVERY",
  "auto"
).toLowerCase();
if (!["auto", "direct", "proxy"].includes(upstreamImageDelivery)) {
  throw new Error(
    "UPSTREAM_IMAGE_DELIVERY must be auto, direct, or proxy"
  );
}

const requestImageFormat = optional("REQUEST_IMAGE_FORMAT", "webp").toLowerCase();
if (!["png", "webp"].includes(requestImageFormat)) {
  throw new Error("REQUEST_IMAGE_FORMAT must be png or webp");
}

const upstreamBaseUrl = stripTrailingSlash(profile.baseUrl);
const allowInsecureUpstream = booleanValue("ALLOW_INSECURE_UPSTREAM", false);
const upstreamUrl = new URL(upstreamBaseUrl);

if (
  upstreamUrl.protocol !== "https:" &&
  !(allowInsecureUpstream && upstreamUrl.protocol === "http:")
) {
  throw new Error(
    "UPSTREAM_BASE_URL must use HTTPS. Set ALLOW_INSECURE_UPSTREAM=true only for a trusted HTTP service."
  );
}

const authDisabled = profile.authHeader.toLowerCase() === "none";
const upstreamApiKey = authDisabled
  ? optional("UPSTREAM_API_KEY")
  : required("UPSTREAM_API_KEY");

export const config = Object.freeze({
  upstreamProfile: profile.profileName,

  host: optional("HOST", "127.0.0.1"),
  port: portNumber("PORT", 18121),
  publicBaseUrl: stripTrailingSlash(required("PUBLIC_BASE_URL")),
  mcpBearerToken: normalizeMcpToken(required("MCP_BEARER_TOKEN")),

  upstreamBaseUrl,
  upstreamGeneratePath: normalizePath(profile.generatePath),
  upstreamApiKey,
  upstreamAuthHeader: authDisabled ? "" : profile.authHeader,
  upstreamAuthPrefix: profile.authPrefix,
  upstreamExtraHeaders: jsonObject("UPSTREAM_EXTRA_HEADERS_JSON"),
  upstreamModelFull: profile.modelFull,
  upstreamModelCurated: profile.modelCurated,
  upstreamBodyOverrides: jsonObject("UPSTREAM_BODY_OVERRIDES_JSON"),
  upstreamParameterOverrides: jsonObject("UPSTREAM_PARAMETER_OVERRIDES_JSON"),
  upstreamResponseMode: profile.responseMode,
  upstreamImageDelivery,
  upstreamAccept: profile.accept,
  upstreamTimeoutMs: positiveInteger("UPSTREAM_TIMEOUT_MS", 180_000),
  upstreamParamsVersion: positiveInteger("UPSTREAM_PARAMS_VERSION", 3),
  promptLanguagePolicy: profile.promptLanguagePolicy,
  requestImageFormat,

  imageDir: path.resolve(optional("IMAGE_DIR", "./data/images")),
  imageTtlMs: positiveInteger("IMAGE_TTL_HOURS", 24) * 60 * 60 * 1000
});

if (
  !config.publicBaseUrl.startsWith("https://") &&
  !config.publicBaseUrl.startsWith("http://localhost")
) {
  throw new Error(
    "PUBLIC_BASE_URL must use https://, except http://localhost for local testing"
  );
}

if (
  config.upstreamApiKey &&
  config.upstreamApiKey === config.mcpBearerToken
) {
  throw new Error("UPSTREAM_API_KEY and MCP_BEARER_TOKEN must be different");
}
