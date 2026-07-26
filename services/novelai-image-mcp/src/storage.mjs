import { randomBytes } from "node:crypto";
import { mkdir, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

const FILE_NAME_PATTERN = /^[a-f0-9]{48}\.(png|webp|jpg)$/;

export async function initializeImageStorage(imageDir) {
  await mkdir(imageDir, { recursive: true, mode: 0o700 });
}

export async function saveGeneratedImage({
  imageDir,
  buffer,
  format,
  ttlMs,
  publicBaseUrl
}) {
  if (!["png", "webp", "jpg"].includes(format)) {
    throw new Error(`Unsupported saved image format: ${format}`);
  }

  const id = randomBytes(24).toString("hex");
  const fileName = `${id}.${format}`;
  const finalPath = path.join(imageDir, fileName);
  const temporaryPath = `${finalPath}.tmp`;

  await writeFile(temporaryPath, buffer, { mode: 0o600 });
  await rename(temporaryPath, finalPath);

  return {
    fileName,
    filePath: finalPath,
    url: `${publicBaseUrl}/images/${fileName}`,
    expiresAt: new Date(Date.now() + ttlMs).toISOString()
  };
}

export function resolvePublicImagePath(imageDir, fileName) {
  if (!FILE_NAME_PATTERN.test(fileName)) return null;
  return path.join(imageDir, fileName);
}

export async function cleanupExpiredImages(imageDir, ttlMs, now = Date.now()) {
  let entries;
  try {
    entries = await readdir(imageDir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return 0;
    throw error;
  }

  let removed = 0;
  for (const entry of entries) {
    if (!entry.isFile() || !FILE_NAME_PATTERN.test(entry.name)) continue;
    const filePath = path.join(imageDir, entry.name);

    try {
      const info = await stat(filePath);
      if (now - info.mtimeMs > ttlMs) {
        await unlink(filePath);
        removed += 1;
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return removed;
}
