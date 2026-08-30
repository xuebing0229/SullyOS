import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const SLOT_RE = /^[a-f0-9]{64}$/;
const LEGACY_FLAT_CACHE_RE = /^[a-f0-9]{64}\.bin$/;

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

function assertSlotId(slotId) {
  const value = String(slotId || "");
  if (!SLOT_RE.test(value)) throw new Error("vibe reference slot id is invalid");
  return value;
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

  function slotDirectory(slotId) {
    return path.join(root, assertSlotId(slotId));
  }

  async function initialize() {
    await mkdir(root, { recursive: true, mode: 0o700 });
    await chmod(root, 0o700);

    // v1 used anonymous flat files, so deleting a Vibe image could not identify
    // which encodings belonged to it. Remove those once so no ghost cache survives
    // the ownership migration.
    const entries = await readdir(root, { withFileTypes: true });
    await Promise.all(entries
      .filter(entry => entry.isFile() && LEGACY_FLAT_CACHE_RE.test(entry.name))
      .map(entry => rm(path.join(root, entry.name), { force: true })));
  }

  async function read(slotId, key) {
    try {
      const buffer = await readFile(path.join(slotDirectory(slotId), `${key}.bin`));
      return buffer.length ? buffer : null;
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
  }

  async function getOrCreate({
    slotId,
    imageSha256,
    modelId,
    informationExtracted,
    encode
  }) {
    const ownerSlot = assertSlotId(slotId);
    const key = cacheKey(imageSha256, modelId, informationExtracted);
    const existing = await read(ownerSlot, key);
    if (existing) return { buffer: existing, cached: true, key };

    const task = async () => {
      const afterWait = await read(ownerSlot, key);
      if (afterWait) return { buffer: afterWait, cached: true, key };
      const encoded = await encode();
      if (!Buffer.isBuffer(encoded) || encoded.length === 0) {
        throw new Error("Vibe encoding returned empty data");
      }
      const ownerDir = slotDirectory(ownerSlot);
      await mkdir(ownerDir, { recursive: true, mode: 0o700 });
      await chmod(ownerDir, 0o700);
      await atomicWrite(path.join(ownerDir, `${key}.bin`), encoded);
      return { buffer: encoded, cached: false, key };
    };
    const queued = tail.then(task, task);
    tail = queued.catch(() => {});
    return queued;
  }

  async function removeBySlotId(slotId) {
    await rm(slotDirectory(slotId), { recursive: true, force: true });
  }

  return { root, initialize, getOrCreate, removeBySlotId };
}
