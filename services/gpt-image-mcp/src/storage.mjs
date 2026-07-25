import { randomBytes } from "node:crypto";
import { mkdir, readdir, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

const SAFE_FILE_RE = /^[a-f0-9]{32}\.(?:png|webp|jpg)$/;

export async function initializeImageStorage(imageDir) {
  await mkdir(imageDir, { recursive: true, mode: 0o700 });
}

export function resolvePublicImagePath(imageDir, fileName) {
  if (!SAFE_FILE_RE.test(fileName)) return null;
  const root = path.resolve(imageDir);
  const resolved = path.resolve(root, fileName);
  return resolved.startsWith(`${root}${path.sep}`) ? resolved : null;
}

export async function saveGeneratedImage({
  imageDir,
  buffer,
  format,
  ttlMs,
  publicBaseUrl
}) {
  await initializeImageStorage(imageDir);
  const fileName = `${randomBytes(16).toString("hex")}.${format}`;
  const filePath = path.join(imageDir, fileName);
  await writeFile(filePath, buffer, { mode: 0o600, flag: "wx" });
  return {
    fileName,
    filePath,
    url: `${publicBaseUrl}/images/${fileName}`,
    expiresAt: new Date(Date.now() + ttlMs).toISOString()
  };
}

export async function cleanupExpiredImages(imageDir, ttlMs) {
  await initializeImageStorage(imageDir);
  const now = Date.now();
  let removed = 0;
  for (const fileName of await readdir(imageDir)) {
    if (!SAFE_FILE_RE.test(fileName)) continue;
    const filePath = path.join(imageDir, fileName);
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
