import { access } from "node:fs/promises";
import express from "express";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { bootstrapRuntimeConfig, staticConfig } from "./config.mjs";
import { createRuntimeConfigStore } from "./runtime-config.mjs";
import { generateUpstreamImage } from "./upstream.mjs";
import {
  backgroundJobOptionsFromEnv,
  createBackgroundJobService
} from "./background-jobs.mjs";
import {
  cleanupExpiredImages,
  initializeImageStorage,
  resolvePublicImagePath,
  saveGeneratedImage
} from "./storage.mjs";
import {
  createBearerTenantRegistry,
  tenantChildPath,
  tenantConfigPath
} from "./tenant-auth.mjs";

const SERVICE_NAME = "sullyos-gpt-image-mcp";
const SERVICE_VERSION = "1.1.0";


function log(level, event, fields = {}) {
  console.log(JSON.stringify({
    time: new Date().toISOString(),
    level,
    service: SERVICE_NAME,
    event,
    ...fields
  }));
}

function safeErrorLogFields(error) {
  const message = String(error?.message || "");
  const correlationId = message.match(/correlation ID ([a-f0-9]{16})/i)?.[1];
  return {
    errorName: error?.name || "Error",
    ...(correlationId ? { correlationId } : {})
  };
}

const tenantRegistry = createBearerTenantRegistry({
  primaryToken: staticConfig.mcpBearerToken
});
const tenantContexts = new Map();
const jobBaseDir = process.env.IMAGE_JOBS_DIR || "/var/lib/sullyos-image-jobs/gpt";

function publicBaseForTenant(tenant) {
  return tenant.primary
    ? staticConfig.publicImageBaseUrl
    : staticConfig.publicImageBaseUrl + "/t/" + tenant.id;
}

async function createTenantContext(tenant) {
  const runtimeStore = createRuntimeConfigStore({
    filePath: tenantConfigPath(staticConfig.runtimeConfigFile, tenant),
    defaults: tenant.primary
      ? bootstrapRuntimeConfig
      : { ...bootstrapRuntimeConfig, apiKey: "" },
    allowInsecureUpstream: staticConfig.allowInsecureUpstream
  });
  const imageDir = tenantChildPath(staticConfig.imageDir, tenant);
  await initializeImageStorage(imageDir);
  await runtimeStore.load();

  const context = {
    tenant,
    runtimeStore,
    imageDir,
    publicBaseUrl: publicBaseForTenant(tenant),
    imageJobs: null
  };
  context.imageJobs = await createBackgroundJobService({
    ...backgroundJobOptionsFromEnv({
      defaultDir: tenantChildPath(jobBaseDir, tenant),
      defaultTool: GPT_IMAGE_TOOL_NAME,
      executeTool: (toolName, args, jobContext) =>
        executeMcpTool(context, toolName, args, jobContext),
      logger: console
    }),
    dataDir: tenantChildPath(jobBaseDir, tenant),
    authToken: tenant.token
  });
  return context;
}

function getTenantContext(tenant) {
  if (!tenant) return Promise.reject(new Error("Unknown image tenant"));
  const existing = tenantContexts.get(tenant.id);
  if (existing) return existing;
  const created = createTenantContext(tenant).catch(error => {
    tenantContexts.delete(tenant.id);
    throw error;
  });
  tenantContexts.set(tenant.id, created);
  return created;
}

async function requireBearer(req, res, next) {
  const tenant = tenantRegistry.resolveRequest(req);
  if (!tenant) {
    res.setHeader("WWW-Authenticate", 'Bearer realm="sullyos-gpt-image-mcp"');
    return res.status(401).json({ error: "unauthorized" });
  }
  try {
    req.imageTenant = await getTenantContext(tenant);
    next();
  } catch (error) {
    next(error);
  }
}

function methodNotAllowed(res) {
  return res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed. Use Streamable HTTP POST." },
    id: null
  });
}

let generationTail = Promise.resolve();
function serializeGeneration(task) {
  const next = generationTail.then(task, task);
  generationTail = next.catch(() => {});
  return next;
}

async function materializeGeneratedImage(generated, tenantContext) {
  if (generated.imageUrl) {
    return { imageUrl: generated.imageUrl, saved: null };
  }
  const saved = await saveGeneratedImage({
    imageDir: tenantContext.imageDir,
    buffer: generated.imageBuffer,
    format: generated.format,
    ttlMs: staticConfig.imageTtlMs,
    publicBaseUrl: tenantContext.publicBaseUrl
  });
  return { imageUrl: saved.url, saved };
}

const GPT_IMAGE_TOOL_NAME = "generate_image";
const gptImageInputShape = {
  prompt: z.string().min(1).max(8000),
  size: z.enum(["1024x1024", "1536x1024", "1024x1536"]).optional().default("1024x1024"),
  quality: z.enum(["auto", "low", "medium", "high"]).optional().default("auto"),
  background: z.enum(["auto", "opaque", "transparent"]).optional().default("auto"),
  output_format: z.enum(["png", "jpeg", "webp"]).optional().default("png")
};
const gptImageArgumentsSchema = z.object(gptImageInputShape).strict();
async function executeGptImageGeneration(rawArgs, tenantContext, { runtimeOverride, forcePersist = false } = {}) {
  const args = gptImageArgumentsSchema.parse(rawArgs);
  const runtime = runtimeOverride ? structuredClone(runtimeOverride) : await tenantContext.runtimeStore.load();
  const effectiveRuntime = forcePersist ? { ...runtime, imageDelivery: "proxy" } : runtime;
  const generated = await serializeGeneration(() => generateUpstreamImage({
    config: effectiveRuntime,
    input: { prompt: args.prompt, size: args.size, quality: args.quality, background: args.background, outputFormat: args.output_format },
    timeoutMs: staticConfig.upstreamTimeoutMs,
    maxImageBytes: staticConfig.maxImageBytes,
    maxResponseBytes: staticConfig.maxUpstreamResponseBytes
  }));
  const { imageUrl, saved } = await materializeGeneratedImage(generated, tenantContext);
  log("info", "image_generated", {
    tenantId: tenantContext.tenant.id,
    correlationId: generated.correlationId, mode: runtime.mode,
    upstreamHost: new URL(runtime.baseUrl).host, model: runtime.model,
    size: args.size, quality: args.quality,
    delivery: forcePersist ? "background-proxy" : generated.imageUrl ? "direct" : "proxy",
    ...(saved ? { fileName: saved.fileName } : {})
  });
  return {
    structuredContent: { imageUrl, requestId: generated.correlationId, model: runtime.model, size: args.size, ...(saved ? { expiresAt: saved.expiresAt } : {}) },
    content: [{ type: "text", text: ["Image generated successfully.", `Image URL: ${imageUrl}`, `Model: ${runtime.model}`, `Size: ${args.size}`, ...(saved ? [`Expires at: ${saved.expiresAt}`] : []), "Show the image to the user and continue speaking in character."].join("\n") }]
  };
}
async function executeMcpTool(tenantContext, toolName, args, context = {}) {
  if (toolName !== GPT_IMAGE_TOOL_NAME) {
    return { success: false, error: "Unknown tool" };
  }
  return executeGptImageGeneration(args, tenantContext, {
    forcePersist: Boolean(context.jobId)
  });
}
function createMcpServer(tenantContext) {
  const server = new McpServer({ name: SERVICE_NAME, version: SERVICE_VERSION });
  server.registerTool(GPT_IMAGE_TOOL_NAME, {
    title: "GPT Image Generate",
    description: "Generate one general-purpose image with the configured GPT/OpenAI-compatible image API.",
    inputSchema: gptImageInputShape
  }, async args => {
    try { return await executeMcpTool(tenantContext, GPT_IMAGE_TOOL_NAME, args); }
    catch (error) {
      log("error", "generation_failed", safeErrorLogFields(error));
      return { isError: true, content: [{ type: "text", text: `Image generation failed: ${error?.message || String(error)}` }] };
    }
  });
  return server;
}
const primaryTenant = tenantRegistry.resolve(staticConfig.mcpBearerToken);
const primaryContext = await getTenantContext(primaryTenant);
let initiallyRemoved = 0;
for (const tenantId of tenantRegistry.listTenantIds()) {
  const tenant = tenantRegistry.resolveId(tenantId);
  initiallyRemoved += await cleanupExpiredImages(
    tenantChildPath(staticConfig.imageDir, tenant),
    staticConfig.imageTtlMs
  );
}
if (initiallyRemoved) log("info", "startup_cleanup", { removed: initiallyRemoved });

const cleanupTimer = setInterval(async () => {
  try {
    let removedImages = 0;
    for (const tenantId of tenantRegistry.listTenantIds()) {
      const tenant = tenantRegistry.resolveId(tenantId);
      removedImages += await cleanupExpiredImages(
        tenantChildPath(staticConfig.imageDir, tenant),
        staticConfig.imageTtlMs
      );
    }
    if (removedImages) log("info", "scheduled_image_cleanup", { removed: removedImages });
  } catch (error) {
    log("error", "cleanup_failed", safeErrorLogFields(error));
  }
}, 3_600_000);
cleanupTimer.unref();

const app = express();
app.disable("x-powered-by");
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, PUT, DELETE, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Accept, Authorization, Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID"
  );
  res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
  res.setHeader("Access-Control-Max-Age", "86400");
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});
app.use(async (req, res, next) => {
  const pathname = new URL(req.url || "/", "http://127.0.0.1").pathname;
  if (pathname !== "/jobs" && !pathname.startsWith("/jobs/")) return next();
  const tenant = tenantRegistry.resolveRequest(req);
  if (!tenant) return res.status(401).json({ error: "unauthorized" });
  try {
    const context = await getTenantContext(tenant);
    if (await context.imageJobs.handle(req, res)) return;
    next();
  } catch (error) {
    next(error);
  }
});
app.use(express.json({ limit: "1mb" }));

app.get("/healthz", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json({ status: "ok", service: SERVICE_NAME, version: SERVICE_VERSION });
});

app.get("/config", requireBearer, async (req, res, next) => {
  try {
    res.setHeader("Cache-Control", "no-store");
    const store = req.imageTenant.runtimeStore;
    res.json(store.toPublic(await store.load()));
  } catch (error) { next(error); }
});

app.put("/config", requireBearer, async (req, res, next) => {
  try {
    const store = req.imageTenant.runtimeStore;
    const updated = await store.update(req.body);
    res.setHeader("Cache-Control", "no-store");
    res.json(store.toPublic(updated));
  } catch (error) {
    if (error?.code === "REVISION_CONFLICT") {
      return res.status(409).json({
        error: "revision_conflict",
        message: error.message,
        currentRevision: error.currentRevision
      });
    }
    next(error);
  }
});

app.post("/config/test", requireBearer, async (req, res, next) => {
  try {
    const preview = await req.imageTenant.runtimeStore.preview(req.body || {});
    if ((req.body?.mode || "validate") === "validate") {
      return res.json({
        ok: true,
        mode: preview.mode,
        upstreamHost: new URL(preview.baseUrl).host,
        model: preview.model,
        apiKeyConfigured: Boolean(preview.apiKey),
        message: preview.apiKey || preview.custom.authHeader.toLowerCase() === "none"
          ? "Configuration is valid"
          : "Configuration is valid, but no API key is configured"
      });
    }

    const generated = await serializeGeneration(() =>
      generateUpstreamImage({
        config: preview,
        input: {
          prompt: "A small white ceramic cup on a plain studio background, product photo",
          size: "1024x1024",
          quality: "low",
          background: "opaque",
          outputFormat: "png"
        },
        timeoutMs: staticConfig.upstreamTimeoutMs,
        maxImageBytes: staticConfig.maxImageBytes,
        maxResponseBytes: staticConfig.maxUpstreamResponseBytes
      })
    );
    const { imageUrl, saved } = await materializeGeneratedImage(generated, req.imageTenant);
    res.json({
      ok: true,
      message: "A real upstream image was generated successfully",
      imageUrl,
      ...(saved ? { expiresAt: saved.expiresAt } : {})
    });
  } catch (error) { next(error); }
});

async function sendTenantImage(res, imageDir, fileName) {
  const filePath = resolvePublicImagePath(imageDir, fileName);
  if (!filePath) return res.sendStatus(404);
  try { await access(filePath); } catch { return res.sendStatus(404); }
  res.setHeader("Cache-Control", "public, max-age=3600, immutable");
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  return res.sendFile(filePath);
}
app.get("/images/:fileName", async (req, res) =>
  sendTenantImage(res, staticConfig.imageDir, req.params.fileName)
);
app.get("/t/:tenantId/images/:fileName", async (req, res) => {
  const tenant = tenantRegistry.resolveId(req.params.tenantId);
  if (!tenant || tenant.primary) return res.sendStatus(404);
  return sendTenantImage(
    res,
    tenantChildPath(staticConfig.imageDir, tenant),
    req.params.fileName
  );
});

app.post("/mcp", requireBearer, async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const mcpServer = createMcpServer(req.imageTenant);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  try {
    await mcpServer.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    log("error", "mcp_request_failed", safeErrorLogFields(error));
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null
      });
    }
  } finally {
    res.on("close", () => {
      Promise.allSettled([transport.close(), mcpServer.close()]).catch(() => {});
    });
  }
});
app.get("/mcp", requireBearer, (req, res) => methodNotAllowed(res));
app.delete("/mcp", requireBearer, (req, res) => methodNotAllowed(res));

app.use((error, req, res, next) => {
  log("error", "http_error", safeErrorLogFields(error));
  if (res.headersSent) return next(error);
  res.status(400).json({
    error: "request_failed",
    message: error?.message || "Request failed"
  });
});

const httpServer = app.listen(staticConfig.port, staticConfig.host, async () => {
  const runtime = await primaryContext.runtimeStore.load();
  log("info", "server_started", {
    host: staticConfig.host,
    port: staticConfig.port,
    publicImageBaseUrl: staticConfig.publicImageBaseUrl,
    upstreamHost: new URL(runtime.baseUrl).host,
    mode: runtime.mode,
    model: runtime.model,
    imageDir: staticConfig.imageDir,
    tenantCount: tenantRegistry.size
  });
});

httpServer.on("error", (error) => {
  log("fatal", "server_start_failed", safeErrorLogFields(error));
  process.exit(1);
});

async function shutdown(signal) {
  log("info", "shutdown_started", { signal });
  clearInterval(cleanupTimer);
  const contexts = await Promise.allSettled([...tenantContexts.values()]);
  await Promise.allSettled(contexts
    .filter(item => item.status === "fulfilled")
    .map(item => item.value.imageJobs.stop()));
  httpServer.close((error) => process.exit(error ? 1 : 0));
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
