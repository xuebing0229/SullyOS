import { timingSafeEqual } from "node:crypto";
import { access } from "node:fs/promises";
import path from "node:path";
import express from "express";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { bootstrapRuntimeConfig, staticConfig } from "./config.mjs";
import { createNovelRuntimeConfigStore, toUpstreamConfig } from "./runtime-config.mjs";
import { buildUpstreamHeaders, buildUpstreamRequest, generateUpstreamImage } from "./upstream.mjs";
import {
  backgroundJobOptionsFromEnv,
  createBackgroundJobService
} from "./background-jobs.mjs";
import { createReferenceStore } from "./reference-store.mjs";
import { isNovelAiV45Model, preciseReferenceUnsupportedMessage } from "./precise-reference.mjs";
import {
  cleanupExpiredImages,
  initializeImageStorage,
  resolvePublicImagePath,
  saveGeneratedImage
} from "./storage.mjs";

const SERVICE_NAME = "novelai-compatible-image-mcp";
const SERVICE_VERSION = "0.5.0";
const runtimeStore = createNovelRuntimeConfigStore({
  filePath: staticConfig.runtimeConfigFile,
  bootstrap: bootstrapRuntimeConfig,
  allowInsecureUpstream: staticConfig.allowInsecureUpstream
});
const referenceStore = createReferenceStore({
  directory: path.join(staticConfig.imageDir, "references")
});

function log(level, event, fields = {}) {
  console.log(JSON.stringify({ time: new Date().toISOString(), level, service: SERVICE_NAME, event, ...fields }));
}
function safeErrorLogFields(error) {
  const message = String(error?.message || "");
  const correlationId = message.match(/correlation ID ([A-Za-z0-9]{6})/)?.[1];
  const ndjson = error?.ndjsonSummary;
  return {
    errorName: error?.name || "Error",
    ...(correlationId ? { correlationId } : {}),
    ...(ndjson ? {
      ndjsonRecords: Array.isArray(ndjson.records) ? ndjson.records : [],
      invalidNdjsonLines: Number(ndjson.invalidLines) || 0
    } : {})
  };
}
function secureEquals(actual, expected) {
  const left = Buffer.from(actual); const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}
function requireBearer(req, res, next) {
  const match = (req.get("authorization") || "").match(/^Bearer\s+(.+)$/i);
  const supplied = match?.[1]?.trim() || "";
  if (!supplied || !secureEquals(supplied, staticConfig.mcpBearerToken)) {
    res.setHeader("WWW-Authenticate", 'Bearer realm="novelai-compatible-image-mcp"');
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
}
function methodNotAllowed(res) {
  return res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed. Use Streamable HTTP POST." }, id: null });
}
let generationTail = Promise.resolve();
function serializeGeneration(task) {
  const next = generationTail.then(task, task); generationTail = next.catch(() => {}); return next;
}
async function materialize(generated) {
  if (generated.imageUrl) return { imageUrl: generated.imageUrl, saved: null };
  const saved = await saveGeneratedImage({
    imageDir: staticConfig.imageDir,
    buffer: generated.imageBuffer,
    format: generated.format,
    ttlMs: staticConfig.imageTtlMs,
    publicBaseUrl: staticConfig.publicBaseUrl
  });
  return { imageUrl: saved.url, saved };
}
const NOVELAI_TOOL_NAME = "novelai_generate_image";
const novelAiInputShape = {
  prompt: z.string().min(1).max(5000),
  undesired_content: z.string().max(3000).optional().default(""),
  model: z.enum(["full", "curated"]).optional().default("full"),
  size: z.enum(["portrait", "landscape", "square"]).optional().default("portrait"),
  seed: z.number().int().min(0).max(4_294_967_295).optional(),
  steps: z.number().int().min(1).max(50).optional().default(23),
  guidance: z.number().min(1).max(10).optional().default(5),
  uc_preset: z.enum(["heavy", "light", "human", "none"]).optional().default("heavy"),
  quality_tags: z.boolean().optional().default(true),
  reference_id: z.string().regex(/^[a-f0-9]{64}$/).optional().describe("SullyOS-managed private reference slot. Never invent or expose it."),
  reference_type: z.enum(["character", "style", "character&style"]).optional().default("character"),
  reference_strength: z.number().min(0).max(1).optional().default(0.75),
  reference_fidelity: z.number().min(0).max(1).optional().default(0.85)
};
const novelAiArgumentsSchema = z.object(novelAiInputShape).strict();
async function effectiveUpstreamConfig(runtimeOverride, { forcePersist = false } = {}) {
  const runtime = runtimeOverride ? structuredClone(runtimeOverride) : await runtimeStore.load();
  const config = toUpstreamConfig(runtime, staticConfig);
  if (forcePersist) config.upstreamImageDelivery = "proxy";
  if (!config.upstreamApiKey && config.upstreamAuthHeader) throw new Error("The upstream API key has not been configured");
  return { runtime, config };
}
async function executeNovelAiGeneration(rawArgs, { runtimeOverride, forcePersist = false } = {}) {
  const args = novelAiArgumentsSchema.parse(rawArgs);
  const { runtime, config } = await effectiveUpstreamConfig(runtimeOverride, { forcePersist });
  let preciseReference = null;
  if (args.reference_id) {
    const upstreamModel = args.model === "curated" ? config.upstreamModelCurated : config.upstreamModelFull;
    if (!isNovelAiV45Model(upstreamModel)) throw new Error("NovelAI Precise Reference is only supported by V4.5 Full/Curated models");
    const stored = await referenceStore.readImage(args.reference_id);
    if (!stored) throw new Error("The character reference image is missing on the MCP server. Reopen the character settings and sync it again.");
    preciseReference = { imageBuffer: stored.buffer, type: args.reference_type, strength: args.reference_strength, fidelity: args.reference_fidelity };
  }
  const request = buildUpstreamRequest({
    prompt: args.prompt, undesiredContent: args.undesired_content, model: args.model,
    size: args.size, seed: args.seed, steps: args.steps, guidance: args.guidance,
    ucPreset: args.uc_preset, qualityTags: args.quality_tags, preciseReference, config
  });
  let generated;
  try { generated = await serializeGeneration(() => generateUpstreamImage({ config, request })); }
  catch (error) {
    if (preciseReference && /(400|422|director_reference|reference.*unsupported|unknown field)/i.test(String(error?.message || ""))) throw new Error(preciseReferenceUnsupportedMessage());
    throw error;
  }
  const { imageUrl, saved } = await materialize(generated);
  log("info", "image_generated", {
    correlationId: generated.requestId, profile: runtime.profile,
    upstreamHost: new URL(runtime.baseUrl).host, modelPreset: args.model,
    upstreamModel: request.modelId, size: args.size, seed: generated.seed,
    delivery: forcePersist ? "background-proxy" : generated.imageUrl ? "direct" : "proxy",
    referenceUsed: Boolean(preciseReference),
    ...(preciseReference ? { referenceType: preciseReference.type } : {}),
    ...(saved ? { fileName: saved.fileName } : {})
  });
  return {
    structuredContent: { imageUrl, requestId: generated.requestId, seed: generated.seed, model: request.modelId, size: `${request.dimensions.width}x${request.dimensions.height}`, referenceUsed: Boolean(preciseReference), ...(saved ? { expiresAt: saved.expiresAt } : {}) },
    content: [{ type: "text", text: ["Image generated successfully.", `Image URL: ${imageUrl}`, `Seed: ${generated.seed}`, `Model: ${request.modelId}`, `Size: ${request.dimensions.width}x${request.dimensions.height}`, ...(saved ? [`Expires at: ${saved.expiresAt}`] : []), "Show the image to the user and continue speaking in character."].join("\n") }]
  };
}
async function executeMcpTool(toolName, args, context = {}) {
  if (toolName !== NOVELAI_TOOL_NAME) {
    return { success: false, error: "Unknown tool" };
  }
  return executeNovelAiGeneration(args, {
    forcePersist: Boolean(context.jobId)
  });
}
function createMcpServer() {
  const server = new McpServer({ name: SERVICE_NAME, version: SERVICE_VERSION });
  server.registerTool(NOVELAI_TOOL_NAME, {
    title: "NovelAI Generate Image",
    description: "Generate one anime/illustration image through the configured NovelAI-compatible API.",
    inputSchema: novelAiInputShape
  }, async args => {
    try { return await executeMcpTool(NOVELAI_TOOL_NAME, args); }
    catch (error) {
      log("error", "generation_failed", safeErrorLogFields(error));
      return { isError: true, content: [{ type: "text", text: `Image generation failed: ${error?.message || String(error)}` }] };
    }
  });
  return server;
}
await initializeImageStorage(staticConfig.imageDir);
await referenceStore.initialize();
await runtimeStore.load();
const imageJobs = await createBackgroundJobService({
  ...backgroundJobOptionsFromEnv({
    defaultDir: process.env.IMAGE_JOBS_DIR || "/var/lib/sullyos-image-jobs/novelai",
    defaultTool: NOVELAI_TOOL_NAME,
    executeTool: executeMcpTool,
    logger: console
  }),
  authToken: staticConfig.mcpBearerToken
});
const initiallyRemoved = await cleanupExpiredImages(staticConfig.imageDir, staticConfig.imageTtlMs);
if (initiallyRemoved) log("info", "startup_cleanup", { removed: initiallyRemoved });
const cleanupTimer = setInterval(async () => {
  try {
    const removedImages = await cleanupExpiredImages(staticConfig.imageDir, staticConfig.imageTtlMs);
    if (removedImages) log("info", "scheduled_image_cleanup", { removed: removedImages });
  } catch (error) { log("error", "cleanup_failed", safeErrorLogFields(error)); }
}, 3_600_000);
cleanupTimer.unref();

const app = express();
app.disable("x-powered-by");
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, HEAD, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept, Authorization, Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID, XBY-APIKEY, X-Reference-Sha256");
  res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id, X-Reference-Sha256, X-Reference-Updated-At");
  res.setHeader("Access-Control-Max-Age", "86400");
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});
app.use(async (req, res, next) => {
  try {
    if (await imageJobs.handle(req, res)) return;
    next();
  } catch (error) {
    next(error);
  }
});
app.use(express.json({ limit: "1mb" }));
app.get("/healthz", (req, res) => res.json({ status: "ok", service: SERVICE_NAME, version: SERVICE_VERSION }));
function setReferenceHeaders(res, metadata) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Reference-Sha256", metadata.sha256);
  res.setHeader("X-Reference-Updated-At", String(metadata.updatedAt));
}
app.head("/references/:slotId", requireBearer, async (req, res, next) => {
  try { const metadata = await referenceStore.getMetadata(req.params.slotId); if (!metadata) return res.sendStatus(404); setReferenceHeaders(res, metadata); return res.sendStatus(200); } catch (error) { next(error); }
});
app.get("/references/:slotId", requireBearer, async (req, res, next) => {
  try { const metadata = await referenceStore.getMetadata(req.params.slotId); if (!metadata) return res.sendStatus(404); setReferenceHeaders(res, metadata); return res.json(metadata); } catch (error) { next(error); }
});
app.put("/references/:slotId", requireBearer, express.raw({ type: "image/png", limit: "20mb" }), async (req, res, next) => {
  try {
    if (!Buffer.isBuffer(req.body)) return res.status(415).json({ error: "unsupported_media_type", message: "Content-Type must be image/png" });
    const result = await referenceStore.put(req.params.slotId, req.body, req.get("X-Reference-Sha256") || "");
    setReferenceHeaders(res, result.metadata);
    return res.status(result.existed ? 200 : 201).json(result.metadata);
  } catch (error) { next(error); }
});
app.delete("/references/:slotId", requireBearer, async (req, res, next) => {
  try { await referenceStore.remove(req.params.slotId); return res.sendStatus(204); } catch (error) { next(error); }
});


app.get("/config", requireBearer, async (req, res, next) => {
  try { res.setHeader("Cache-Control", "no-store"); res.json(runtimeStore.toPublic(await runtimeStore.load())); }
  catch (error) { next(error); }
});
app.put("/config", requireBearer, async (req, res, next) => {
  try { res.setHeader("Cache-Control", "no-store"); res.json(runtimeStore.toPublic(await runtimeStore.update(req.body))); }
  catch (error) {
    if (error?.code === "REVISION_CONFLICT") return res.status(409).json({ error: "revision_conflict", message: error.message, currentRevision: error.currentRevision });
    next(error);
  }
});
app.post("/models", requireBearer, async (req, res, next) => {
  try {
    const runtime = await runtimeStore.preview(req.body || {});
    const { config } = await effectiveUpstreamConfig(runtime);
    const configuredModels = [...new Set([runtime.modelFull, runtime.modelCurated].filter(Boolean))];
    const url = `${config.upstreamBaseUrl}${config.upstreamModelsPath}`;
    const response = await fetch(url, {
      method: "GET",
      headers: buildUpstreamHeaders(config, `models-${Date.now()}`),
      signal: AbortSignal.timeout(Math.min(config.upstreamTimeoutMs, 30_000))
    });
    const text = await response.text();
    if (!response.ok) {
      if (response.status === 404 || response.status === 405) {
        res.setHeader("Cache-Control", "no-store");
        return res.json({ models: configuredModels, source: "configured" });
      }
      throw new Error(`Model discovery failed: HTTP ${response.status}${text ? ` - ${text.slice(0, 200)}` : ""}`);
    }
    let payload;
    try { payload = text ? JSON.parse(text) : null; } catch { throw new Error("Model discovery returned invalid JSON"); }
    const candidates = Array.isArray(payload) ? payload : Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.models) ? payload.models : [];
    const models = [...new Set(candidates.map(item => typeof item === "string" ? item : item?.id ?? item?.name).filter(item => typeof item === "string" && item.trim()).map(item => item.trim()))].sort();
    res.setHeader("Cache-Control", "no-store");
    return res.json(models.length ? { models, source: "remote" } : { models: configuredModels, source: "configured" });
  } catch (error) { next(error); }
});
app.post("/config/test", requireBearer, async (req, res, next) => {
  try {
    const runtime = await runtimeStore.preview(req.body || {});
    const { config } = await effectiveUpstreamConfig(runtime);
    if ((req.body?.mode || "validate") === "validate") {
      return res.json({
        ok: true,
        message: config.upstreamApiKey || !config.upstreamAuthHeader ? "Configuration is valid" : "Configuration is valid, but no API key is configured",
        profile: runtime.profile,
        upstreamHost: new URL(runtime.baseUrl).host,
        apiKeyConfigured: Boolean(config.upstreamApiKey)
      });
    }
    const request = buildUpstreamRequest({
      prompt: "1girl, solo, simple white background, upper body, high quality",
      undesiredContent: "text, watermark",
      model: "full",
      size: "portrait",
      steps: 8,
      guidance: 5,
      ucPreset: "light",
      qualityTags: true,
      config
    });
    const generated = await serializeGeneration(() => generateUpstreamImage({ config, request }));
    const { imageUrl, saved } = await materialize(generated);
    res.json({ ok: true, message: "A real upstream image was generated successfully", imageUrl, ...(saved ? { expiresAt: saved.expiresAt } : {}) });
  } catch (error) { next(error); }
});

app.get("/images/:fileName", async (req, res) => {
  const filePath = resolvePublicImagePath(staticConfig.imageDir, req.params.fileName);
  if (!filePath) return res.sendStatus(404);
  try { await access(filePath); } catch { return res.sendStatus(404); }
  res.setHeader("Cache-Control", "public, max-age=3600, immutable");
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  return res.sendFile(filePath);
});
app.post("/mcp", requireBearer, async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const mcpServer = createMcpServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  try { await mcpServer.connect(transport); await transport.handleRequest(req, res, req.body); }
  catch (error) {
    log("error", "mcp_request_failed", safeErrorLogFields(error));
    if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
  } finally {
    res.on("close", () => Promise.allSettled([transport.close(), mcpServer.close()]).catch(() => {}));
  }
});
app.get("/mcp", requireBearer, (req, res) => methodNotAllowed(res));
app.delete("/mcp", requireBearer, (req, res) => methodNotAllowed(res));
app.use((error, req, res, next) => {
  log("error", "http_error", safeErrorLogFields(error));
  if (res.headersSent) return next(error);
  const status = Number.isInteger(error?.statusCode) ? error.statusCode : 400;
  res.status(status).json({ error: status === 413 ? "payload_too_large" : "request_failed", message: error?.message || "Request failed" });
});

const httpServer = app.listen(staticConfig.port, staticConfig.host, async () => {
  const runtime = await runtimeStore.load();
  log("info", "server_started", {
    host: staticConfig.host,
    port: staticConfig.port,
    publicBaseUrl: staticConfig.publicBaseUrl,
    profile: runtime.profile,
    upstreamHost: new URL(runtime.baseUrl).host,
    imageDir: staticConfig.imageDir
  });
});
httpServer.on("error", (error) => { log("fatal", "server_start_failed", safeErrorLogFields(error)); process.exit(1); });
async function shutdown(signal) {
  log("info", "shutdown_started", { signal });
  clearInterval(cleanupTimer);
  await imageJobs.stop();
  httpServer.close((error) => process.exit(error ? 1 : 0));
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
