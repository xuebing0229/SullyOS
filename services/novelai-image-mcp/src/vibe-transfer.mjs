import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

function round2(value) {
  return Math.round(value * 100) / 100;
}

export function normalizeVibeUnit(value, name, fallback) {
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(number) || number < 0 || number > 1) {
    throw new Error(`${name} must be between 0 and 1`);
  }
  return round2(number);
}

export function applyVibeTransfer(parameters, vibe) {
  if (!vibe) return parameters;
  if (!Buffer.isBuffer(vibe.encodedBuffer) || vibe.encodedBuffer.length === 0) {
    throw new Error("encoded vibe is missing");
  }
  return {
    ...parameters,
    normalize_reference_strength_multiple: false,
    reference_image_multiple: [vibe.encodedBuffer.toString("base64")],
    reference_strength_multiple: [normalizeVibeUnit(vibe.strength, "vibe_reference_strength", 0.6)]
  };
}

function cacheKey(imageSha256, modelId, informationExtracted) {
  if (!/^[a-f0-9]{64}$/.test(String(imageSha256 || ""))) {
    throw new Error("vibe image sha256 is invalid");
  }
  const info = normalizeVibeUnit(
    informationExtracted,
    "vibe_reference_information_extracted",
    1
  );
  return createHash("sha256")
    .update(`${imageSha256}:${String(modelId)}:${info.toFixed(2)}`)
    .digest("hex");
}

async function atomicWrite(filePath, buffer) {
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, buffer, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, filePath);
  await chmod(filePath, 0o600);
}

export function createVibeEncodingCache({ directory }) {
  const root = path.resolve(directory);
  let tail = Promise.resolve();

  async function initialize() {
    await mkdir(root, { recursive: true, mode: 0o700 });
    await chmod(root, 0o700);
  }

  async function read(key) {
    try {
      const buffer = await readFile(path.join(root, `${key}.bin`));
      return buffer.length ? buffer : null;
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
  }

  async function getOrCreate({
    imageSha256,
    modelId,
    informationExtracted,
    encode
  }) {
    const key = cacheKey(imageSha256, modelId, informationExtracted);
    const existing = await read(key);
    if (existing) return { buffer: existing, cached: true, key };

    const task = async () => {
      const afterWait = await read(key);
      if (afterWait) return { buffer: afterWait, cached: true, key };
      const encoded = await encode();
      if (!Buffer.isBuffer(encoded) || encoded.length === 0) {
        throw new Error("Vibe encoding returned empty data");
      }
      await initialize();
      await atomicWrite(path.join(root, `${key}.bin`), encoded);
      return { buffer: encoded, cached: false, key };
    };
    const queued = tail.then(task, task);
    tail = queued.catch(() => {});
    return queued;
  }

  return { root, initialize, getOrCreate };
}
