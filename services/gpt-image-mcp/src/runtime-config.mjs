import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const MODES = new Set(["compatible", "custom"]);
const DELIVERIES = new Set(["auto", "direct", "proxy"]);
const RESPONSE_MODES = new Set(["auto", "json", "image"]);

const isPlainObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function clone(value) {
  return structuredClone(value);
}

function stripTrailingSlash(value) {
  return value.replace(/\/+$/, "");
}

function normalizePath(value, fallback) {
  const text = String(value || fallback).trim();
  return text.startsWith("/") ? text : `/${text}`;
}

function assertJsonObject(value, field) {
  if (!isPlainObject(value)) throw new Error(`${field} must be a JSON object`);
  return value;
}

function normalizeStringRecord(value, field) {
  const object = assertJsonObject(value ?? {}, field);
  const result = {};
  for (const [key, child] of Object.entries(object)) {
    const name = String(key).trim();
    if (!name) continue;
    if (!["string", "number", "boolean"].includes(typeof child)) {
      throw new Error(`${field}.${name} must be a scalar value`);
    }
    result[name] = child;
  }
  return result;
}

function normalizePaths(value, fallback, field) {
  const values = value === undefined ? fallback : value;
  if (!Array.isArray(values)) throw new Error(`${field} must be an array`);
  const cleaned = values.map((item) => String(item).trim()).filter(Boolean);
  if (!cleaned.length) throw new Error(`${field} must not be empty`);
  return [...new Set(cleaned)].slice(0, 32);
}

function validateBaseUrl(value, allowInsecure) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("baseUrl must be a valid absolute URL");
  }
  const allowed = url.protocol === "https:" || (allowInsecure && url.protocol === "http:");
  if (!allowed) {
    throw new Error(
      "baseUrl must use HTTPS. ALLOW_INSECURE_UPSTREAM=true is only for a trusted HTTP service."
    );
  }
  if (url.username || url.password) {
    throw new Error("baseUrl must not contain embedded credentials");
  }
  return stripTrailingSlash(url.toString());
}

function normalizeRequestFields(value, fallback) {
  const object = { ...fallback, ...(isPlainObject(value) ? value : {}) };
  const allowed = ["prompt", "model", "size", "quality", "background", "outputFormat"];
  const result = {};
  for (const key of allowed) {
    const fieldPath = String(object[key] ?? "").trim();
    if (key === "prompt" && !fieldPath) {
      throw new Error("custom.requestFields.prompt is required");
    }
    result[key] = fieldPath;
  }
  return result;
}

export function normalizeRuntimeConfig(input, defaults, options) {
  const source = isPlainObject(input) ? input : {};
  const customSource = isPlainObject(source.custom) ? source.custom : {};
  const customDefaults = defaults.custom;
  const mode = String(source.mode ?? defaults.mode).trim().toLowerCase();
  const imageDelivery = String(
    source.imageDelivery ?? defaults.imageDelivery
  ).trim().toLowerCase();
  const responseMode = String(
    customSource.responseMode ?? customDefaults.responseMode
  ).trim().toLowerCase();

  if (!MODES.has(mode)) throw new Error("mode must be compatible or custom");
  if (!DELIVERIES.has(imageDelivery)) {
    throw new Error("imageDelivery must be auto, direct, or proxy");
  }
  if (!RESPONSE_MODES.has(responseMode)) {
    throw new Error("custom.responseMode must be auto, json, or image");
  }

  const normalized = {
    version: 1,
    revision: Number.isSafeInteger(source.revision) ? source.revision : 0,
    mode,
    baseUrl: validateBaseUrl(
      String(source.baseUrl ?? defaults.baseUrl).trim(),
      options.allowInsecureUpstream
    ),
    apiKey: String(source.apiKey ?? defaults.apiKey ?? "").trim(),
    model: String(source.model ?? defaults.model).trim(),
    imageDelivery,
    custom: {
      generatePath: normalizePath(
        customSource.generatePath,
        customDefaults.generatePath
      ),
      authHeader: String(
        customSource.authHeader ?? customDefaults.authHeader
      ).trim(),
      authPrefix: String(
        customSource.authPrefix ?? customDefaults.authPrefix
      ).trim(),
      responseMode,
      requestFields: normalizeRequestFields(
        customSource.requestFields,
        customDefaults.requestFields
      ),
      responseUrlPaths: normalizePaths(
        customSource.responseUrlPaths,
        customDefaults.responseUrlPaths,
        "custom.responseUrlPaths"
      ),
      responseBase64Paths: normalizePaths(
        customSource.responseBase64Paths,
        customDefaults.responseBase64Paths,
        "custom.responseBase64Paths"
      ),
      extraHeaders: normalizeStringRecord(
        customSource.extraHeaders ?? customDefaults.extraHeaders,
        "custom.extraHeaders"
      ),
      extraBody: assertJsonObject(
        customSource.extraBody ?? customDefaults.extraBody,
        "custom.extraBody"
      )
    }
  };

  if (!normalized.model) throw new Error("model is required");
  if (normalized.mode === "custom" && !normalized.custom.authHeader) {
    normalized.custom.authHeader = "none";
  }
  return normalized;
}

export function maskSecret(secret) {
  if (!secret) return null;
  if (secret.length <= 8) return "••••";
  return `${secret.slice(0, 3)}••••••${secret.slice(-4)}`;
}

export function toPublicRuntimeConfig(config) {
  const { apiKey, ...safe } = clone(config);
  return {
    ...safe,
    apiKeyConfigured: Boolean(apiKey),
    // This is intentionally plaintext for this private SullyOS deployment so
    // the settings screen can load, edit, and copy the configured upstream key.
    apiKeyHint: apiKey || null
  };
}

export function createRuntimeConfigStore({ filePath, defaults, allowInsecureUpstream }) {
  let cached = null;
  let writeTail = Promise.resolve();

  async function readDisk() {
    try {
      const raw = await readFile(filePath, "utf8");
      return JSON.parse(raw);
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
  }

  async function load() {
    if (cached) return clone(cached);
    const fromDisk = await readDisk();
    cached = normalizeRuntimeConfig(fromDisk ?? defaults, defaults, {
      allowInsecureUpstream
    });
    return clone(cached);
  }

  async function persist(config) {
    await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
    const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(config, null, 2)}\n`, {
      mode: 0o600
    });
    await chmod(tempPath, 0o600);
    await rename(tempPath, filePath);
    await chmod(filePath, 0o600);
  }

  async function update(payload = {}) {
    const task = async () => {
      const current = await load();
      const expected = payload.expectedRevision;
      if (expected !== undefined && expected !== current.revision) {
        const error = new Error("Configuration changed on another device; reload and try again");
        error.code = "REVISION_CONFLICT";
        error.currentRevision = current.revision;
        throw error;
      }

      const patch = isPlainObject(payload.patch) ? payload.patch : {};
      const nextInput = {
        ...current,
        ...patch,
        custom: {
          ...current.custom,
          ...(isPlainObject(patch.custom) ? patch.custom : {})
        },
        apiKey: current.apiKey
      };

      if (payload.clearApiKey === true) nextInput.apiKey = "";
      if (typeof payload.apiKey === "string" && payload.apiKey.trim()) {
        nextInput.apiKey = payload.apiKey.trim();
      }

      const next = normalizeRuntimeConfig(nextInput, defaults, {
        allowInsecureUpstream
      });
      next.revision = current.revision + 1;
      await persist(next);
      cached = next;
      return clone(next);
    };

    const queued = writeTail.then(task, task);
    writeTail = queued.catch(() => {});
    return queued;
  }

  async function preview(payload = {}) {
    const current = await load();
    const patch = isPlainObject(payload.patch) ? payload.patch : {};
    const input = {
      ...current,
      ...patch,
      custom: {
        ...current.custom,
        ...(isPlainObject(patch.custom) ? patch.custom : {})
      },
      apiKey: current.apiKey
    };
    if (typeof payload.apiKey === "string" && payload.apiKey.trim()) {
      input.apiKey = payload.apiKey.trim();
    }
    if (payload.clearApiKey === true) input.apiKey = "";
    return normalizeRuntimeConfig(input, defaults, { allowInsecureUpstream });
  }

  return { load, update, preview, toPublic: toPublicRuntimeConfig };
}
