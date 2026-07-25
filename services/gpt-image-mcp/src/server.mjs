import { timingSafeEqual } from "node:crypto";
import { access } from "node:fs/promises";
import express from "express";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { bootstrapRuntimeConfig, staticConfig } from "./config.mjs";
import { createRuntimeConfigStore } from "./runtime-config.mjs";
import { generateUpstreamImage } from "./upstream.mjs";
import {
  cleanupExpiredImages,
  initializeImageStorage,
  resolvePublicImagePath,
  saveGeneratedImage
} from "./storage.mjs";

const SERVICE_NAME = "sullyos-gpt-image-mcp";
const SERVICE_VERSION = "1.0.0";

const runtimeStore = createRuntimeConfigStore({
  filePath: staticConfig.runtimeConfigFile,
  defaults: bootstrapRuntimeConfig,
  allowInsecureUpstream: staticConfig.allowInsecureUpstream
});

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

function secureEquals(actual, expected) {
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function requireBearer(req, res, next) {
  const match = (req.get("authorization") || "").match(/^Bearer\s+(.+)$/i);
  const supplied = match?.[1]?.trim() || "";
  if (!supplied || !secureEquals(supplied, staticConfig.mcpBearerToken)) {
    res.setHeader("WWW-Authenticate", 'Bearer realm="sullyos-gpt-image-mcp"');
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
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

async function materializeGeneratedImage(generated) {
  if (generated.imageUrl) {
    return { imageUrl: generated.imageUrl, saved: null };
  }
  const saved = await saveGeneratedImage({
    imageDir: staticConfig.imageDir,
    buffer: generated.imageBuffer,
    format: generated.format,
    ttlMs: staticConfig.imageTtlMs,
    publicBaseUrl: staticConfig.publicImageBaseUrl
  });
  return { imageUrl: saved.url, saved };
}

function createMcpServer() {
  const server = new McpServer({ name: SERVICE_NAME, version: SERVICE_VERSION });
  server.registerTool(
    "generate_image",
    {
      title: "GPT Image Generate",
      description:
        "Generate one general-purpose image with the configured GPT/OpenAI-compatible image API. Prefer this tool for natural-language, realistic, poster, product, scene, or general image requests. When the user explicitly asks for NovelAI, do not use this tool.",
      inputSchema: {
        prompt: z.string().min(1).max(8000).describe("Detailed natural-language image instruction."),
        size: z.enum(["1024x1024", "1536x1024", "1024x1536"]).optional().default("1024x1024"),
        quality: z.enum(["auto", "low", "medium", "high"]).optional().default("auto"),
        background: z.enum(["auto", "opaque", "transparent"]).optional().default("auto"),
        output_format: z.enum(["png", "jpeg", "webp"]).optional().default("png")
      }
    },
    async ({ prompt, size, quality, background, output_format }) => {
      try {
        const runtime = await runtimeStore.load();
        const generated = await serializeGeneration(() =>
          generateUpstreamImage({
            config: runtime,
            input: { prompt, size, quality, background, outputFormat: output_format },
            timeoutMs: staticConfig.upstreamTimeoutMs
          })
        );
        const { imageUrl, saved } = await materializeGeneratedImage(generated);
        log("info", "image_generated", {
          correlationId: generated.correlationId,
          mode: runtime.mode,
          upstreamHost: new URL(runtime.baseUrl).host,
          model: runtime.model,
          size,
          quality,
          delivery: generated.imageUrl ? "direct" : "proxy",
          ...(saved ? { fileName: saved.fileName } : {})
        });
        return {
          structuredContent: {
            imageUrl,
            model: runtime.model,
            size,
            ...(saved ? { expiresAt: saved.expiresAt } : {})
          },
          content: [{
            type: "text",
            text: [
              "Image generated successfully.",
              `Image URL: ${imageUrl}`,
              `Model: ${runtime.model}`,
              `Size: ${size}`,
              ...(saved ? [`Expires at: ${saved.expiresAt}`] : []),
              "Show the image to the user and continue speaking in character."
            ].join("\n")
          }]
        };
      } catch (error) {
        log("error", "generation_failed", safeErrorLogFields(error));
        return {
          isError: true,
          content: [{ type: "text", text: `Image generation failed: ${error?.message || String(error)}` }]
        };
      }
    }
  );
  return server;
}

await initializeImageStorage(staticConfig.imageDir);
await runtimeStore.load();
const initiallyRemoved = await cleanupExpiredImages(
  staticConfig.imageDir,
  staticConfig.imageTtlMs
);
if (initiallyRemoved) log("info", "startup_cleanup", { removed: initiallyRemoved });

const cleanupTimer = setInterval(async () => {
  try {
    const removed = await cleanupExpiredImages(
      staticConfig.imageDir,
      staticConfig.imageTtlMs
    );
    if (removed) log("info", "scheduled_cleanup", { removed });
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
app.use(express.json({ limit: "1mb" }));

app.get("/healthz", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json({ status: "ok", service: SERVICE_NAME, version: SERVICE_VERSION });
});

app.get("/config", requireBearer, async (req, res, next) => {
  try {
    res.setHeader("Cache-Control", "no-store");
    res.json(runtimeStore.toPublic(await runtimeStore.load()));
  } catch (error) { next(error); }
});

app.put("/config", requireBearer, async (req, res, next) => {
  try {
    const updated = await runtimeStore.update(req.body);
    res.setHeader("Cache-Control", "no-store");
    res.json(runtimeStore.toPublic(updated));
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
    const preview = await runtimeStore.preview(req.body || {});
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
        timeoutMs: staticConfig.upstreamTimeoutMs
      })
    );
    const { imageUrl, saved } = await materializeGeneratedImage(generated);
    res.json({
      ok: true,
      message: "A real upstream image was generated successfully",
      imageUrl,
      ...(saved ? { expiresAt: saved.expiresAt } : {})
    });
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
  const runtime = await runtimeStore.load();
  log("info", "server_started", {
    host: staticConfig.host,
    port: staticConfig.port,
    publicImageBaseUrl: staticConfig.publicImageBaseUrl,
    upstreamHost: new URL(runtime.baseUrl).host,
    mode: runtime.mode,
    model: runtime.model,
    imageDir: staticConfig.imageDir
  });
});

httpServer.on("error", (error) => {
  log("fatal", "server_start_failed", safeErrorLogFields(error));
  process.exit(1);
});

function shutdown(signal) {
  log("info", "shutdown_started", { signal });
  clearInterval(cleanupTimer);
  httpServer.close((error) => process.exit(error ? 1 : 0));
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
