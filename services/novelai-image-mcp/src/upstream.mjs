import { randomBytes, randomInt } from "node:crypto";
import { unzipSync } from "fflate";
import { applyPreciseReference } from "./precise-reference.mjs";

export const SIZE_PRESETS = Object.freeze({
  portrait: { width: 832, height: 1216 },
  landscape: { width: 1216, height: 832 },
  square: { width: 1024, height: 1024 }
});

const UC_PRESETS = Object.freeze({
  heavy:
    "lowres, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, dithering, halftone, screentone, multiple views, logo, too many watermarks, negative space, blank page",
  light:
    "lowres, artistic error, scan artifacts, worst quality, bad quality, jpeg artifacts, multiple views, very displeasing, too many watermarks, negative space, blank page",
  human:
    "lowres, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, multiple views, logo, too many watermarks, bad anatomy, bad hands, mismatched pupils, negative space, blank page",
  none: ""
});

const CJK_PATTERN =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

export function correlationId() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  for (let index = 0; index < 6; index += 1) {
    result += chars[randomInt(0, chars.length)];
  }
  return result;
}

function joinPromptParts(...parts) {
  return parts
    .map((part) => part?.trim())
    .filter(Boolean)
    .join(", ");
}

function deepMergePayload(base, overrides) {
  const result = { ...base, ...overrides };
  if (base.parameters || overrides.parameters) {
    result.parameters = {
      ...(base.parameters ?? {}),
      ...(overrides.parameters ?? {})
    };
  }
  return result;
}

function authValue(prefix, key) {
  return prefix ? `${prefix} ${key}` : key;
}

export function buildUpstreamHeaders(config, requestId) {
  const headers = {
    Accept: config.upstreamAccept,
    "Content-Type": "application/json",
    "X-Correlation-Id": requestId,
    ...config.upstreamExtraHeaders
  };

  if (config.upstreamAuthHeader && config.upstreamApiKey) {
    headers[config.upstreamAuthHeader] = authValue(
      config.upstreamAuthPrefix,
      config.upstreamApiKey
    );
  }

  return headers;
}

export function assertPromptPolicy(prompt, policy) {
  if (policy === "english-only" && CJK_PATTERN.test(prompt)) {
    throw new Error(
      "This MCP is configured for English-only prompts. Translate the prompt before calling the upstream API."
    );
  }
}

export function buildUpstreamRequest({
  prompt,
  undesiredContent = "",
  model = "full",
  size = "portrait",
  seed,
  steps = 23,
  guidance = 5,
  ucPreset = "heavy",
  qualityTags = true,
  preciseReference = null,
  config
}) {
  assertPromptPolicy(prompt, config.promptLanguagePolicy);

  const dimensions = SIZE_PRESETS[size];
  if (!dimensions) throw new Error(`Unsupported size preset: ${size}`);

  const modelId =
    model === "curated"
      ? config.upstreamModelCurated
      : config.upstreamModelFull;

  const chosenSeed =
    seed === undefined ? randomInt(0, 0x1_0000_0000) : seed;
  const negativePrompt = joinPromptParts(
    UC_PRESETS[ucPreset],
    undesiredContent
  );

  let parameters = {
    params_version: config.upstreamParamsVersion,
    width: dimensions.width,
    height: dimensions.height,
    scale: guidance,
    sampler: "k_euler_ancestral",
    steps,
    seed: chosenSeed,
    n_samples: 1,
    qualityToggle: qualityTags,
    negative_prompt: negativePrompt,
    prompt,
    noise_schedule: "karras",
    legacy: false,
    cfg_rescale: 0,
    dynamic_thresholding: false,
    ...(config.upstreamProfile === "official" && config.requestImageFormat
      ? { image_format: config.requestImageFormat }
      : {}),
    v4_prompt: {
      caption: {
        base_caption: prompt,
        char_captions: []
      },
      use_coords: false,
      use_order: true
    },
    v4_negative_prompt: {
      caption: {
        base_caption: negativePrompt,
        char_captions: []
      },
      legacy_uc: false,
      use_coords: false,
      use_order: false
    },
    ...config.upstreamParameterOverrides
  };

  if (preciseReference) {
    parameters = applyPreciseReference(parameters, preciseReference);
  }

  const basePayload = {
    action: "generate",
    input: prompt,
    model: modelId,
    parameters
  };

  const payload = deepMergePayload(
    basePayload,
    config.upstreamBodyOverrides
  );

  return {
    seed: chosenSeed,
    dimensions,
    modelId,
    negativePrompt,
    payload
  };
}

function detectImageFormat(buffer, hintedContentType = "") {
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  ) {
    return "png";
  }

  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "webp";
  }

  if (
    buffer.length >= 3 &&
    buffer[0] === 0xff &&
    buffer[1] === 0xd8 &&
    buffer[2] === 0xff
  ) {
    return "jpg";
  }

  if (hintedContentType.includes("png")) return "png";
  if (hintedContentType.includes("webp")) return "webp";
  if (
    hintedContentType.includes("jpeg") ||
    hintedContentType.includes("jpg")
  ) {
    return "jpg";
  }
  return null;
}

function isZip(buffer) {
  return (
    buffer.length >= 4 &&
    buffer[0] === 0x50 &&
    buffer[1] === 0x4b &&
    [0x03, 0x05, 0x07].includes(buffer[2])
  );
}

async function readResponseBufferLimited(response, maxBytes) {
  const contentLength = Number(response.headers.get("content-length") || 0);
  if (contentLength > maxBytes) throw new Error(`Upstream response exceeds ${maxBytes} bytes`);
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error(`Upstream response exceeds ${maxBytes} bytes`);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}
function assertImageSize(buffer, maxImageBytes) {
  if (buffer.length <= 0) throw new Error("The upstream returned an empty image");
  if (buffer.length > maxImageBytes) throw new Error(`Generated image exceeds ${maxImageBytes} bytes`);
}
function decodeBase64Image(value, maxImageBytes = Number.MAX_SAFE_INTEGER) {
  const match = value.match(
    /^data:image\/(png|webp|jpeg|jpg);base64,(.+)$/is
  );
  const raw = match ? match[2] : value;
  const buffer = Buffer.from(raw.replace(/\s+/g, ""), "base64");
  assertImageSize(buffer, maxImageBytes);
  const format = detectImageFormat(
    buffer,
    match ? `image/${match[1]}` : ""
  );

  if (!format || buffer.length < 16) {
    throw new Error("The upstream returned invalid base64 image data");
  }
  return { imageBuffer: buffer, format };
}

const IMAGE_CONTAINER_KEYS = new Set([
  "data", "output", "result", "images"
]);
const URL_KEYS = new Set(["url", "imageurl", "image_url"]);
const BASE64_KEYS = new Set(["b64_json", "base64"]);

function looksLikeBase64Image(value) {
  const compact = value.replace(/\s+/g, "");
  return compact.length >= 24 && compact.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(compact);
}

function imageStringCandidate(value, key = "") {
  if (typeof value !== "string" || !value.trim()) return null;
  const text = value.trim();
  const normalizedKey = key.toLowerCase();
  if (/^data:image\/(?:png|webp|jpeg|jpg);base64,/i.test(text)) return { type: "base64", value: text };
  if (URL_KEYS.has(normalizedKey)) return { type: "url", value: text };
  if (BASE64_KEYS.has(normalizedKey)) return { type: "base64", value: text };
  if (normalizedKey === "image") {
    if (/^(?:https:\/\/|\/)/i.test(text)) return { type: "url", value: text };
    if (looksLikeBase64Image(text)) return { type: "base64", value: text };
  }
  return null;
}

function extractJsonCandidate(value, key = "", seen = new Set()) {
  const direct = imageStringCandidate(value, key);
  if (direct) return direct;
  if (!value || typeof value !== "object" || seen.has(value)) return null;
  seen.add(value);
  if (Array.isArray(value)) {
    for (let index = value.length - 1; index >= 0; index -= 1) {
      const candidate = extractJsonCandidate(value[index], key, seen);
      if (candidate) return candidate;
    }
    return null;
  }
  const entries = Object.entries(value);
  const priority = entries.filter(([name]) => URL_KEYS.has(name.toLowerCase()) || BASE64_KEYS.has(name.toLowerCase()) || name.toLowerCase() === "image");
  for (const [name, child] of priority) {
    const candidate = extractJsonCandidate(child, name, seen);
    if (candidate) return candidate;
  }
  const containers = entries.filter(([name]) => IMAGE_CONTAINER_KEYS.has(name.toLowerCase()));
  for (let index = containers.length - 1; index >= 0; index -= 1) {
    const [name, child] = containers[index];
    const candidate = extractJsonCandidate(child, name, seen);
    if (candidate) return candidate;
  }
  const skipped = new Set([...priority, ...containers].map(([name]) => name));
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const [name, child] = entries[index];
    if (skipped.has(name)) continue;
    const candidate = extractJsonCandidate(child, name, seen);
    if (candidate) return candidate;
  }
  return null;
}

function extractSeed(body, fallback) {
  const candidates = [
    body?.images?.[0]?.seed,
    body?.data?.[0]?.seed,
    body?.output?.[0]?.seed,
    body?.seed
  ];
  return candidates.find(Number.isInteger) ?? fallback;
}

function summarizeNdjsonRecord(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return { keys: [] };
  const summary = { keys: Object.keys(record).slice(0, 20) };
  if (typeof record.type === "string") summary.type = record.type.slice(0, 80);
  if (typeof record.status === "string") summary.status = record.status.slice(0, 80);
  return summary;
}

function isKeepaliveLine(line) {
  const normalized = line.trim().toLowerCase();
  return !normalized || normalized.startsWith(":") || normalized === "keepalive" || normalized === "ping" || normalized === "[keepalive]";
}

function parseJsonOrNdjson(buffer) {
  const text = buffer.toString("utf8").trim();
  if (!text) return { records: [], summaries: [], invalidLines: 0 };
  try {
    const record = JSON.parse(text);
    return { records: [record], summaries: [summarizeNdjsonRecord(record)], invalidLines: 0 };
  } catch {
    const records = [];
    let invalidLines = 0;
    for (const rawLine of text.split(/\r?\n/)) {
      if (isKeepaliveLine(rawLine)) continue;
      const trimmed = rawLine.trim();
      const line = trimmed.startsWith("data:") ? trimmed.slice(5).trim() : trimmed;
      if (isKeepaliveLine(line)) continue;
      try { records.push(JSON.parse(line)); }
      catch { invalidLines += 1; }
    }
    return { records, summaries: records.map(summarizeNdjsonRecord), invalidLines };
  }
}

function ndjsonParseError(message, parsed) {
  const error = new Error(message);
  error.ndjsonSummary = { records: parsed.summaries.slice(-20), invalidLines: parsed.invalidLines };
  return error;
}

function safeTerminalError(records) {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (!record || typeof record !== "object" || Array.isArray(record)) continue;
    const status = String(record.status ?? record.type ?? "").toLowerCase();
    if (!["error", "failed", "failure"].includes(status)) continue;
    const candidates = [
      record.message,
      record.error,
      record.data,
      record.data?.message,
      record.data?.error,
      record.result,
      record.result?.message,
      record.result?.error
    ];
    for (const value of candidates) {
      if (typeof value !== "string" || !value.trim()) continue;
      const safe = value
        .replace(/data:image\/[^;]+;base64,[A-Za-z0-9+/=\s]+/gi, "[image data omitted]")
        .replace(/[A-Za-z0-9+/]{256,}={0,2}/g, "[large encoded value omitted]")
        .slice(0, 500);
      return safe;
    }
    return "The upstream reported a terminal error without a message";
  }
  return null;
}

function extractCandidateFromRecords(records) {
  let selected = null;
  let seed;

  for (const record of records) {
    const candidate = extractJsonCandidate(record);
    if (candidate) selected = candidate;
    const recordSeed = extractSeed(record, undefined);
    if (Number.isInteger(recordSeed)) seed = recordSeed;
  }

  return { candidate: selected, seed };
}

function extractFirstImageFromZip(buffer) {
  let archive;
  try {
    archive = unzipSync(new Uint8Array(buffer));
  } catch (error) {
    throw new Error(`Unable to unpack upstream ZIP response: ${error.message}`);
  }

  for (const [name, bytes] of Object.entries(archive)) {
    const imageBuffer = Buffer.from(bytes);
    const format = detectImageFormat(imageBuffer);
    if (format) return { imageBuffer, format, archiveEntry: name };
  }

  throw new Error("The upstream ZIP response contained no supported image");
}

function resolveRemoteImageUrl(urlValue, config) {
  let url;
  try {
    url = new URL(urlValue, config.upstreamBaseUrl);
  } catch {
    throw new Error("The upstream returned an invalid image URL");
  }
  if (url.protocol !== "https:") {
    throw new Error("Direct upstream image URLs must use HTTPS");
  }
  return url;
}

function canReturnDirectImageUrl(url, config) {
  return url.origin === new URL(config.upstreamBaseUrl).origin;
}

async function fetchRemoteImage(urlValue, config, requestId) {
  const url = resolveRemoteImageUrl(urlValue, config);

  const upstreamOrigin = new URL(config.upstreamBaseUrl).origin;
  const headers =
    url.origin === upstreamOrigin
      ? buildUpstreamHeaders(config, requestId)
      : { Accept: "image/*, application/zip" };

  delete headers["Content-Type"];

  const response = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(config.upstreamTimeoutMs)
  });

  if (!response.ok) {
    throw new Error(
      `Unable to download the generated image URL: HTTP ${response.status}`
    );
  }

  const contentType = (
    response.headers.get("content-type") ?? ""
  ).toLowerCase();
  const buffer = await readResponseBufferLimited(
    response,
    Math.min(config.maxUpstreamResponseBytes, config.maxImageBytes)
  );
  const format = detectImageFormat(buffer, contentType);
  if (format) {
    assertImageSize(buffer, config.maxImageBytes);
    return { imageBuffer: buffer, format };
  }
  if (isZip(buffer)) {
    const extracted = extractFirstImageFromZip(buffer);
    assertImageSize(extracted.imageBuffer, config.maxImageBytes);
    return extracted;
  }

  throw new Error("The generated image URL did not return an image");
}

function remoteErrorMessage(buffer, contentType) {
  const text = buffer.toString("utf8", 0, Math.min(buffer.length, 1000));
  if (contentType.includes("json")) {
    try {
      const parsed = JSON.parse(text);
      return (
        parsed?.message ||
        parsed?.error?.message ||
        parsed?.error ||
        text.slice(0, 500)
      );
    } catch {
      return text.slice(0, 500);
    }
  }
  return text.slice(0, 500);
}

export async function parseUpstreamResponse({
  response,
  config,
  requestId,
  fallbackSeed
}) {
  const contentType = (
    response.headers.get("content-type") ?? ""
  ).toLowerCase();
  const buffer = await readResponseBufferLimited(
    response,
    config.maxUpstreamResponseBytes
  );

  if (!response.ok) {
    throw new Error(
      `Upstream rejected the request (${response.status}, correlation ID ${requestId}): ${remoteErrorMessage(buffer, contentType) || "no response body"}`
    );
  }

  const forcedMode = config.upstreamResponseMode;
  const requireDirectUrl = config.upstreamImageDelivery === "direct";

  if (
    forcedMode === "image" ||
    contentType.startsWith("image/") ||
    detectImageFormat(buffer, contentType)
  ) {
    if (requireDirectUrl) {
      throw new Error("The upstream did not return an image URL");
    }
    const format = detectImageFormat(buffer, contentType);
    if (!format) throw new Error("Upstream response is not a supported image");
    assertImageSize(buffer, config.maxImageBytes);
    return { imageBuffer: buffer, format, seed: fallbackSeed };
  }

  if (
    forcedMode === "zip" ||
    contentType.includes("zip") ||
    isZip(buffer)
  ) {
    if (requireDirectUrl) {
      throw new Error("The upstream did not return an image URL");
    }
    const extracted = extractFirstImageFromZip(buffer);
    assertImageSize(extracted.imageBuffer, config.maxImageBytes);
    return {
      ...extracted,
      seed: fallbackSeed
    };
  }

  if (
    forcedMode === "json" ||
    forcedMode === "auto" ||
    contentType.includes("json") ||
    contentType.startsWith("text/")
  ) {
    const parsed = parseJsonOrNdjson(buffer);
    if (parsed.records.length === 0 && forcedMode === "json") {
      throw ndjsonParseError("Upstream response was not valid JSON or NDJSON", parsed);
    }

    if (parsed.records.length > 0) {
      const extracted = extractCandidateFromRecords(parsed.records);
      const seed = extracted.seed ?? fallbackSeed;

      if (extracted.candidate?.type === "base64") {
        if (requireDirectUrl) {
          throw new Error("The upstream did not return an image URL");
        }
        return {
          ...decodeBase64Image(extracted.candidate.value, config.maxImageBytes),
          seed
        };
      }

      if (extracted.candidate?.type === "url") {
        const remoteUrl = resolveRemoteImageUrl(
          extracted.candidate.value,
          config
        );
        const directAllowed = canReturnDirectImageUrl(remoteUrl, config);

        if (config.upstreamImageDelivery === "direct") {
          if (!directAllowed) {
            throw new Error(
              "Direct image delivery only permits same-origin HTTPS URLs"
            );
          }
          return { imageUrl: remoteUrl.href, seed };
        }

        if (
          config.upstreamImageDelivery === "auto" &&
          directAllowed
        ) {
          return { imageUrl: remoteUrl.href, seed };
        }

        return {
          ...(await fetchRemoteImage(remoteUrl.href, config, requestId)),
          seed
        };
      }

      const terminalError = safeTerminalError(parsed.records);
      if (terminalError) {
        throw ndjsonParseError(
          `Upstream generation failed (correlation ID ${requestId}): ${terminalError}`,
          parsed
        );
      }
    }
  }

  const parsed = parseJsonOrNdjson(buffer);
  throw ndjsonParseError(
    `Unsupported upstream response format (content-type: ${contentType || "unknown"})`,
    parsed
  );
}

export async function generateUpstreamImage({ config, request }) {
  const requestId = correlationId();
  const url = `${config.upstreamBaseUrl}${config.upstreamGeneratePath}`;

  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: buildUpstreamHeaders(config, requestId),
      body: JSON.stringify(request.payload),
      signal: AbortSignal.timeout(config.upstreamTimeoutMs)
    });
  } catch (error) {
    if (error?.name === "TimeoutError" || error?.name === "AbortError") {
      throw new Error(
        `Upstream request timed out (correlation ID ${requestId}). It is not retried automatically because the upstream may already have charged quota.`
      );
    }

    throw new Error(
      `Upstream network request failed (correlation ID ${requestId}): ${error?.message ?? String(error)}`
    );
  }

  return {
    requestId,
    ...(await parseUpstreamResponse({
      response,
      config,
      requestId,
      fallbackSeed: request.seed
    }))
  };
}
