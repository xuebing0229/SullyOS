import { createHash, timingSafeEqual } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import path from "node:path";

export const REFERENCE_SLOT_RE = /^[a-f0-9]{64}$/;
export const REFERENCE_MAX_BYTES = 20 * 1024 * 1024;
export const REFERENCE_CANVASES = new Set([
  "1024x1536",
  "1472x1472",
  "1536x1024"
]);

function clone(value) {
  return structuredClone(value);
}

function assertSlotId(slotId) {
  if (!REFERENCE_SLOT_RE.test(String(slotId || ""))) {
    const error = new Error("reference slot id must be 64 lowercase hexadecimal characters");
    error.statusCode = 400;
    throw error;
  }
  return slotId;
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function secureHexEquals(left, right) {
  if (!/^[a-f0-9]{64}$/.test(left) || !/^[a-f0-9]{64}$/.test(right)) return false;
  const a = Buffer.from(left, "hex");
  const b = Buffer.from(right, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

function readPngDimensions(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 24) {
    throw new Error("reference image is empty or truncated");
  }
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!buffer.subarray(0, 8).equals(signature)) {
    throw new Error("reference image must be PNG");
  }
  if (buffer.subarray(12, 16).toString("ascii") !== "IHDR") {
    throw new Error("reference PNG has no valid IHDR");
  }
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20)
  };
}

function validateImage(buffer, maxBytes) {
  if (!Buffer.isBuffer(buffer)) throw new Error("reference request body must be binary");
  if (buffer.length < 64) throw new Error("reference image is too small");
  if (buffer.length > maxBytes) {
    const error = new Error(`reference image exceeds ${Math.floor(maxBytes / 1024 / 1024)} MiB`);
    error.statusCode = 413;
    throw error;
  }
  const dimensions = readPngDimensions(buffer);
  if (!REFERENCE_CANVASES.has(`${dimensions.width}x${dimensions.height}`)) {
    throw new Error(
      "reference image must be 1024x1536, 1472x1472, or 1536x1024"
    );
  }
  return dimensions;
}

async function atomicWrite(filePath, data, mode = 0o600) {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.${Math.random()
    .toString(36)
    .slice(2)}.tmp`;
  await writeFile(temporary, data, { mode });
  await chmod(temporary, mode);
  await rename(temporary, filePath);
  await chmod(filePath, mode);
}

export function createReferenceStore({
  directory,
  maxBytes = REFERENCE_MAX_BYTES
}) {
  const root = path.resolve(directory);

  function paths(slotId) {
    const id = assertSlotId(slotId);
    return {
      image: path.join(root, `${id}.png`),
      metadata: path.join(root, `${id}.json`)
    };
  }

  async function initialize() {
    await mkdir(root, { recursive: true, mode: 0o700 });
    await chmod(root, 0o700);
  }

  async function getMetadata(slotId) {
    const target = paths(slotId);
    try {
      const parsed = JSON.parse(await readFile(target.metadata, "utf8"));
      if (
        parsed?.version !== 1 ||
        !/^[a-f0-9]{64}$/.test(parsed.sha256 || "") ||
        !REFERENCE_CANVASES.has(`${parsed.width}x${parsed.height}`)
      ) {
        throw new Error("reference metadata is invalid");
      }
      await stat(target.image);
      return clone(parsed);
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
  }

  async function readImage(slotId) {
    const target = paths(slotId);
    const metadata = await getMetadata(slotId);
    if (!metadata) return null;
    const buffer = await readFile(target.image);
    const actualSha = sha256(buffer);
    if (!secureHexEquals(actualSha, metadata.sha256)) {
      throw new Error("stored reference image checksum mismatch");
    }
    return { metadata, buffer };
  }

  async function put(slotId, buffer, expectedSha = "") {
    const target = paths(slotId);
    const dimensions = validateImage(buffer, maxBytes);
    const actualSha = sha256(buffer);
    const normalizedExpected = String(expectedSha || "").trim().toLowerCase();
    if (normalizedExpected && !secureHexEquals(normalizedExpected, actualSha)) {
      throw new Error("X-Reference-Sha256 does not match request body");
    }

    const existed = Boolean(await getMetadata(slotId));
    const metadata = {
      version: 1,
      sha256: actualSha,
      mimeType: "image/png",
      width: dimensions.width,
      height: dimensions.height,
      sizeBytes: buffer.length,
      updatedAt: Date.now()
    };

    await initialize();
    await atomicWrite(target.image, buffer);
    await atomicWrite(target.metadata, `${JSON.stringify(metadata, null, 2)}\n`);
    return { existed, metadata: clone(metadata) };
  }

  async function remove(slotId) {
    const target = paths(slotId);
    await Promise.all([
      rm(target.image, { force: true }),
      rm(target.metadata, { force: true })
    ]);
  }

  return {
    root,
    initialize,
    getMetadata,
    readImage,
    put,
    remove
  };
}
