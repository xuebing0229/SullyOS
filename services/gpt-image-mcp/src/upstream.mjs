import { randomBytes } from "node:crypto";

const DEFAULT_URL_PATHS = ["data[0].url", "images[0].url", "output[0].url", "url"];
const DEFAULT_BASE64_PATHS = [
  "data[0].b64_json",
  "data[0].base64",
  "images[0].b64_json",
  "images[0].base64",
  "output[0].b64_json",
  "output[0].base64",
  "b64_json",
  "base64"
];

function requestId() {
  return randomBytes(8).toString("hex");
}

function normalizePath(pathValue) {
  const value = String(pathValue || "").trim();
  return value.startsWith("/") ? value : `/${value}`;
}

function authValue(prefix, key) {
  return prefix ? `${prefix} ${key}` : key;
}

function pathParts(pathValue) {
  return String(pathValue)
    .replace(/\[(\d+)\]/g, ".$1")
    .split(".")
    .map((part) => part.trim())
    .filter(Boolean);
}

export function deepGet(value, pathValue) {
  return pathParts(pathValue).reduce((current, part) => current?.[part], value);
}

export function deepSet(target, pathValue, value) {
  const parts = pathParts(pathValue);
  if (!parts.length) return target;
  let cursor = target;
  for (let index = 0; index < parts.length - 1; index += 1) {
    const part = parts[index];
    const nextPart = parts[index + 1];
    if (cursor[part] === undefined) {
      cursor[part] = /^\d+$/.test(nextPart) ? [] : {};
    }
    if (cursor[part] === null || typeof cursor[part] !== "object") {
      throw new Error(`Custom request field conflicts at ${parts.slice(0, index + 1).join(".")}`);
    }
    cursor = cursor[part];
  }
  cursor[parts.at(-1)] = value;
  return target;
}

function detectImageFormat(buffer, hintedContentType = "") {
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  ) return "png";
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WEBP"
  ) return "webp";
  if (
    buffer.length >= 3 &&
    buffer[0] === 0xff &&
    buffer[1] === 0xd8 &&
    buffer[2] === 0xff
  ) return "jpg";
  if (hintedContentType.includes("png")) return "png";
  if (hintedContentType.includes("webp")) return "webp";
  if (hintedContentType.includes("jpeg") || hintedContentType.includes("jpg")) return "jpg";
  return null;
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
function decodeBase64Image(value, maxImageBytes) {
  const text = String(value || "").trim();
  const match = text.match(/^data:image\/(png|webp|jpeg|jpg);base64,(.+)$/is);
  const raw = match ? match[2] : text;
  const buffer = Buffer.from(raw.replace(/\s+/g, ""), "base64");
  assertImageSize(buffer, maxImageBytes);
  const format = detectImageFormat(buffer, match ? `image/${match[1]}` : "");
  if (!format || buffer.length < 16) {
    throw new Error("The upstream returned invalid base64 image data");
  }
  return { imageBuffer: buffer, format };
}

function parseJsonOrNdjson(buffer) {
  const text = buffer.toString("utf8").trim();
  if (!text) return [];
  try {
    return [JSON.parse(text)];
  } catch {
    const records = [];
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        records.push(JSON.parse(line));
      } catch {
        return [];
      }
    }
    return records;
  }
}

function extractJsonImage(records, config) {
  const urlPaths = config.mode === "custom"
    ? config.custom.responseUrlPaths
    : DEFAULT_URL_PATHS;
  const base64Paths = config.mode === "custom"
    ? config.custom.responseBase64Paths
    : DEFAULT_BASE64_PATHS;
  let selected = null;
  for (const record of records) {
    for (const pathValue of base64Paths) {
      const value = deepGet(record, pathValue);
      if (typeof value === "string" && value.trim()) {
        selected = { type: "base64", value };
      }
    }
    for (const pathValue of urlPaths) {
      const value = deepGet(record, pathValue);
      if (typeof value === "string" && value.trim()) {
        selected = { type: "url", value };
      }
    }
  }
  return selected;
}

function resolveRemoteImageUrl(value, config) {
  let url;
  try {
    url = new URL(value, config.baseUrl);
  } catch {
    throw new Error("The upstream returned an invalid image URL");
  }
  if (url.protocol !== "https:") {
    throw new Error("Generated image URLs must use HTTPS");
  }
  return url;
}

function buildHeaders(config, correlationId) {
  const headers = {
    Accept: "application/json, image/png, image/jpeg, image/webp",
    "Content-Type": "application/json",
    "X-Correlation-Id": correlationId
  };
  if (!config.apiKey) return headers;
  if (config.mode === "compatible") {
    headers.Authorization = `Bearer ${config.apiKey}`;
    return headers;
  }
  Object.assign(headers, config.custom.extraHeaders);
  if (config.custom.authHeader.toLowerCase() !== "none") {
    headers[config.custom.authHeader] = authValue(
      config.custom.authPrefix,
      config.apiKey
    );
  }
  return headers;
}

export function buildUpstreamRequest({
  prompt,
  size = "1024x1024",
  quality = "auto",
  background = "auto",
  outputFormat = "png",
  config
}) {
  if (!config.apiKey && !(config.mode === "custom" && config.custom.authHeader.toLowerCase() === "none")) {
    throw new Error("The upstream API key has not been configured");
  }

  if (config.mode === "compatible") {
    return {
      url: `${config.baseUrl}/images/generations`,
      payload: {
        model: config.model,
        prompt,
        size,
        quality,
        background,
        output_format: outputFormat,
        n: 1
      }
    };
  }

  const payload = structuredClone(config.custom.extraBody);
  const fields = config.custom.requestFields;
  deepSet(payload, fields.prompt, prompt);
  if (fields.model) deepSet(payload, fields.model, config.model);
  if (fields.size) deepSet(payload, fields.size, size);
  if (fields.quality) deepSet(payload, fields.quality, quality);
  if (fields.background) deepSet(payload, fields.background, background);
  if (fields.outputFormat) deepSet(payload, fields.outputFormat, outputFormat);
  return {
    url: `${config.baseUrl}${normalizePath(config.custom.generatePath)}`,
    payload
  };
}

function remoteErrorMessage(buffer, contentType) {
  const text = buffer.toString("utf8", 0, Math.min(buffer.length, 1500)).trim();
  if (!text) return "no response body";
  if (contentType.includes("json")) {
    try {
      const parsed = JSON.parse(text);
      return String(
        parsed?.error?.message ?? parsed?.message ?? parsed?.error ?? "upstream error"
      ).slice(0, 500);
    } catch {
      return text.slice(0, 500);
    }
  }
  return text.slice(0, 500);
}

async function fetchRemoteImage(urlValue, config, correlationId, timeoutMs, maxImageBytes, maxResponseBytes) {
  const url = resolveRemoteImageUrl(urlValue, config);
  const sameOrigin = url.origin === new URL(config.baseUrl).origin;
  const headers = sameOrigin
    ? buildHeaders(config, correlationId)
    : { Accept: "image/png, image/jpeg, image/webp" };
  delete headers["Content-Type"];
  const response = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(timeoutMs)
  });
  const contentType = (response.headers.get("content-type") || "").toLowerCase();
  const buffer = await readResponseBufferLimited(response, Math.min(maxResponseBytes, maxImageBytes));
  if (!response.ok) {
    throw new Error(`Unable to download generated image: HTTP ${response.status}`);
  }
  assertImageSize(buffer, maxImageBytes);
  const format = detectImageFormat(buffer, contentType);
  if (!format) throw new Error("Generated image URL did not return a supported image");
  return { imageBuffer: buffer, format };
}

export async function parseUpstreamResponse({ response, config, correlationId, timeoutMs, maxImageBytes, maxResponseBytes }) {
  const contentType = (response.headers.get("content-type") || "").toLowerCase();
  const buffer = await readResponseBufferLimited(response, maxResponseBytes);
  if (!response.ok) {
    throw new Error(
      `Upstream rejected the request (${response.status}, correlation ID ${correlationId}): ${remoteErrorMessage(buffer, contentType)}`
    );
  }

  const responseMode = config.mode === "custom" ? config.custom.responseMode : "auto";
  const format = detectImageFormat(buffer, contentType);
  if (responseMode === "image" || contentType.startsWith("image/") || format) {
    if (config.imageDelivery === "direct") {
      throw new Error("The upstream returned bytes, but imageDelivery is direct");
    }
    if (!format) throw new Error("The upstream response is not a supported image");
    assertImageSize(buffer, maxImageBytes);
    return { imageBuffer: buffer, format };
  }

  const records = parseJsonOrNdjson(buffer);
  if (!records.length) throw new Error("The upstream did not return valid image JSON");
  const candidate = extractJsonImage(records, config);
  if (!candidate) throw new Error("No image URL or base64 field was found in the upstream response");
  if (candidate.type === "base64") {
    if (config.imageDelivery === "direct") {
      throw new Error("The upstream returned base64, but imageDelivery is direct");
    }
    return decodeBase64Image(candidate.value, maxImageBytes);
  }

  const url = resolveRemoteImageUrl(candidate.value, config);
  const sameOrigin = url.origin === new URL(config.baseUrl).origin;
  if (config.imageDelivery === "direct") {
    if (!sameOrigin) {
      throw new Error("Direct delivery only accepts same-origin HTTPS image URLs");
    }
    return { imageUrl: url.toString() };
  }
  if (config.imageDelivery === "auto" && sameOrigin) {
    return { imageUrl: url.toString() };
  }
  return fetchRemoteImage(url.toString(), config, correlationId, timeoutMs, maxImageBytes, maxResponseBytes);
}

export async function generateUpstreamImage({ config, input, timeoutMs, maxImageBytes, maxResponseBytes }) {
  const correlationId = requestId();
  const request = buildUpstreamRequest({ ...input, config });
  const response = await fetch(request.url, {
    method: "POST",
    headers: buildHeaders(config, correlationId),
    body: JSON.stringify(request.payload),
    signal: AbortSignal.timeout(timeoutMs)
  });
  const generated = await parseUpstreamResponse({
    response,
    config,
    correlationId,
    timeoutMs,
    maxImageBytes,
    maxResponseBytes
  });
  return { ...generated, correlationId, upstreamUrl: request.url };
}
