import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { UPSTREAM_PROFILES } from "./profiles.mjs";

const PROFILES = new Set(["official", "standard", "custom"]);
const RESPONSE_MODES = new Set(["auto", "json", "image", "zip"]);
const DELIVERIES = new Set(["auto", "direct", "proxy"]);
const PROMPT_POLICIES = new Set(["allow", "english-only"]);
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const clone = (value) => structuredClone(value);
const stripTrailingSlash = (value) => value.replace(/\/+$/, "");
const normalizePath = (value) => {
  const text = String(value || "/ai/generate-image").trim();
  return text.startsWith("/") ? text : `/${text}`;
};

function validateBaseUrl(value, allowInsecure) {
  let url;
  try { url = new URL(value); } catch { throw new Error("baseUrl must be a valid absolute URL"); }
  if (url.protocol !== "https:" && !(allowInsecure && url.protocol === "http:")) {
    throw new Error("baseUrl must use HTTPS");
  }
  if (url.username || url.password) throw new Error("baseUrl must not contain credentials");
  return stripTrailingSlash(url.toString());
}

export function normalizeNovelRuntimeConfig(input, bootstrap, options) {
  const source = isObject(input) ? input : {};
  const profile = String(source.profile ?? bootstrap.profile ?? "standard").trim().toLowerCase();
  if (!PROFILES.has(profile)) throw new Error("profile must be official, standard, or custom");
  const preset = UPSTREAM_PROFILES[profile];
  const baseUrlRaw = profile === "official"
    ? preset.baseUrl
    : String(source.baseUrl ?? bootstrap.baseUrl ?? preset.baseUrl).trim();
  if (!baseUrlRaw) throw new Error(`baseUrl is required for profile ${profile}`);
  const responseMode = String(source.responseMode ?? bootstrap.responseMode ?? preset.responseMode).toLowerCase();
  const imageDelivery = String(source.imageDelivery ?? bootstrap.imageDelivery ?? "auto").toLowerCase();
  const promptLanguagePolicy = String(source.promptLanguagePolicy ?? bootstrap.promptLanguagePolicy ?? preset.promptLanguagePolicy).toLowerCase();
  if (!RESPONSE_MODES.has(responseMode)) throw new Error("responseMode must be auto, json, image, or zip");
  if (!DELIVERIES.has(imageDelivery)) throw new Error("imageDelivery must be auto, direct, or proxy");
  if (!PROMPT_POLICIES.has(promptLanguagePolicy)) throw new Error("promptLanguagePolicy must be allow or english-only");
  return {
    version: 1,
    revision: Number.isSafeInteger(source.revision) ? source.revision : 0,
    profile,
    baseUrl: validateBaseUrl(baseUrlRaw, options.allowInsecureUpstream),
    apiKey: String(source.apiKey ?? bootstrap.apiKey ?? "").trim(),
    generatePath: normalizePath(source.generatePath ?? bootstrap.generatePath ?? preset.generatePath),
    authHeader: String(source.authHeader ?? bootstrap.authHeader ?? preset.authHeader).trim(),
    authPrefix: String(source.authPrefix ?? bootstrap.authPrefix ?? preset.authPrefix).trim(),
    modelFull: String(source.modelFull ?? bootstrap.modelFull ?? preset.modelFull).trim(),
    modelCurated: String(source.modelCurated ?? bootstrap.modelCurated ?? preset.modelCurated).trim(),
    responseMode,
    imageDelivery,
    accept: String(source.accept ?? bootstrap.accept ?? preset.accept).trim(),
    promptLanguagePolicy
  };
}

function maskSecret(value) {
  if (!value) return null;
  return value.length <= 8 ? "••••" : `${value.slice(0, 3)}••••••${value.slice(-4)}`;
}

export function toPublicNovelConfig(config) {
  const { apiKey, accept, ...safe } = clone(config);
  return {
    ...safe,
    apiKeyConfigured: Boolean(apiKey),
    apiKeyHint: maskSecret(apiKey)
  };
}

export function toUpstreamConfig(runtime, staticConfig) {
  const authDisabled = runtime.authHeader.toLowerCase() === "none";
  return {
    upstreamProfile: runtime.profile,
    upstreamBaseUrl: runtime.baseUrl,
    upstreamGeneratePath: runtime.generatePath,
    upstreamApiKey: runtime.apiKey,
    upstreamAuthHeader: authDisabled ? "" : runtime.authHeader,
    upstreamAuthPrefix: runtime.authPrefix,
    upstreamExtraHeaders: staticConfig.upstreamExtraHeaders,
    upstreamModelFull: runtime.modelFull,
    upstreamModelCurated: runtime.modelCurated,
    upstreamBodyOverrides: staticConfig.upstreamBodyOverrides,
    upstreamParameterOverrides: staticConfig.upstreamParameterOverrides,
    upstreamResponseMode: runtime.responseMode,
    upstreamImageDelivery: runtime.imageDelivery,
    upstreamAccept: runtime.accept,
    upstreamTimeoutMs: staticConfig.upstreamTimeoutMs,
    upstreamParamsVersion: staticConfig.upstreamParamsVersion,
    promptLanguagePolicy: runtime.promptLanguagePolicy,
    requestImageFormat: staticConfig.requestImageFormat
  };
}

export function createNovelRuntimeConfigStore({ filePath, bootstrap, allowInsecureUpstream }) {
  let cached = null;
  let tail = Promise.resolve();
  async function load() {
    if (cached) return clone(cached);
    let disk = null;
    try { disk = JSON.parse(await readFile(filePath, "utf8")); }
    catch (error) { if (error?.code !== "ENOENT") throw error; }
    cached = normalizeNovelRuntimeConfig(disk ?? bootstrap, bootstrap, { allowInsecureUpstream });
    return clone(cached);
  }
  async function persist(config) {
    await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
    const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, filePath);
    await chmod(filePath, 0o600);
  }
  function merge(current, payload) {
    const patch = isObject(payload?.patch) ? payload.patch : {};
    const requestedProfile = String(patch.profile ?? current.profile).trim().toLowerCase();
    const profileChanged = requestedProfile !== current.profile;
    const profileDefaults = profileChanged ? UPSTREAM_PROFILES[requestedProfile] : null;
    const next = {
      ...current,
      ...(profileDefaults ?? {}),
      ...patch,
      apiKey: current.apiKey
    };
    if (payload?.clearApiKey === true) next.apiKey = "";
    if (typeof payload?.apiKey === "string" && payload.apiKey.trim()) next.apiKey = payload.apiKey.trim();
    return normalizeNovelRuntimeConfig(next, bootstrap, { allowInsecureUpstream });
  }
  async function update(payload = {}) {
    const task = async () => {
      const current = await load();
      if (payload.expectedRevision !== undefined && payload.expectedRevision !== current.revision) {
        const error = new Error("Configuration changed on another device; reload and try again");
        error.code = "REVISION_CONFLICT";
        error.currentRevision = current.revision;
        throw error;
      }
      const next = merge(current, payload);
      next.revision = current.revision + 1;
      await persist(next);
      cached = next;
      return clone(next);
    };
    const queued = tail.then(task, task);
    tail = queued.catch(() => {});
    return queued;
  }
  async function preview(payload = {}) { return merge(await load(), payload); }
  return { load, update, preview, toPublic: toPublicNovelConfig };
}
