import { timingSafeEqual } from "node:crypto";
import { access } from "node:fs/promises";
import express from "express";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { config } from "./config.mjs";
import {
  buildUpstreamRequest,
  generateUpstreamImage
} from "./upstream.mjs";
import {
  cleanupExpiredImages,
  initializeImageStorage,
  resolvePublicImagePath,
  saveGeneratedImage
} from "./storage.mjs";

const SERVICE_NAME = "novelai-compatible-image-mcp";
const SERVICE_VERSION = "0.3.0";

function log(level, event, fields = {}) {
  console.log(
    JSON.stringify({
      time: new Date().toISOString(),
      level,
      service: SERVICE_NAME,
      event,
      ...fields
    })
  );
}

function safeErrorLogFields(error) {
  const message = error?.message ?? "";
  const correlationId = message.match(/correlation ID ([a-f0-9]{16})/i)?.[1];
  return {
    errorName: error?.name || "Error",
    ...(correlationId ? { correlationId } : {})
  };
}

function secureTokenEquals(actual, expected) {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return (
    actualBuffer.length === expectedBuffer.length &&
    timingSafeEqual(actualBuffer, expectedBuffer)
  );
}

function requireMcpBearerToken(req, res, next) {
  const authorization = req.get("authorization") || "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  const supplied = match?.[1]?.trim() || "";

  if (!supplied || !secureTokenEquals(supplied, config.mcpBearerToken)) {
    res.setHeader(
      "WWW-Authenticate",
      'Bearer realm="novelai-compatible-image-mcp"'
    );
    return res.status(401).json({
      error: "unauthorized",
      message: "A valid MCP Bearer token is required"
    });
  }
  next();
}

function mcpMethodNotAllowed(res) {
  return res.status(405).json({
    jsonrpc: "2.0",
    error: {
      code: -32000,
      message: "Method not allowed. Use Streamable HTTP POST."
    },
    id: null
  });
}

let generationTail = Promise.resolve();
function serializeGeneration(task) {
  const next = generationTail.then(task, task);
  generationTail = next.catch(() => {});
  return next;
}

function createMcpServer() {
  const server = new McpServer({
    name: SERVICE_NAME,
    version: SERVICE_VERSION
  });

  server.registerTool(
    "novelai_generate_image",
    {
      title: "NovelAI-compatible Generate Image",
      description:
        "Generate one image through the configured NovelAI-compatible API station. Prompt language and exact model support depend on that station. Returns a temporary HTTPS image URL, never base64.",
      inputSchema: {
        prompt: z
          .string()
          .min(1)
          .max(5000)
          .describe(
            "Image prompt. It is forwarded as-is unless the server is configured for English-only prompts."
          ),
        undesired_content: z
          .string()
          .max(3000)
          .optional()
          .default("")
          .describe("Optional additional negative prompt."),
        model: z.enum(["full", "curated"]).optional().default("full"),
        size: z
          .enum(["portrait", "landscape", "square"])
          .optional()
          .default("portrait"),
        seed: z
          .number()
          .int()
          .min(0)
          .max(4_294_967_295)
          .optional(),
        steps: z.number().int().min(1).max(50).optional().default(23),
        guidance: z.number().min(1).max(10).optional().default(5),
        uc_preset: z
          .enum(["heavy", "light", "human", "none"])
          .optional()
          .default("heavy"),
        quality_tags: z.boolean().optional().default(true)
      }
    },
    async ({
      prompt,
      undesired_content,
      model,
      size,
      seed,
      steps,
      guidance,
      uc_preset,
      quality_tags
    }) => {
      try {
        const request = buildUpstreamRequest({
          prompt,
          undesiredContent: undesired_content,
          model,
          size,
          seed,
          steps,
          guidance,
          ucPreset: uc_preset,
          qualityTags: quality_tags,
          config
        });

        const generated = await serializeGeneration(() =>
          generateUpstreamImage({ config, request })
        );

        const saved = generated.imageUrl
          ? null
          : await saveGeneratedImage({
              imageDir: config.imageDir,
              buffer: generated.imageBuffer,
              format: generated.format,
              ttlMs: config.imageTtlMs,
              publicBaseUrl: config.publicBaseUrl
            });
        const imageUrl = generated.imageUrl ?? saved.url;

        log("info", "image_generated", {
          correlationId: generated.requestId,
          modelPreset: model,
          upstreamModel: request.modelId,
          size,
          width: request.dimensions.width,
          height: request.dimensions.height,
          steps,
          seed: generated.seed,
          delivery: generated.imageUrl ? "direct" : "proxy",
          ...(generated.format ? { format: generated.format } : {}),
          ...(saved ? { fileName: saved.fileName } : {})
        });

        return {
          content: [
            {
              type: "text",
              text: [
                "Image generated successfully.",
                `Image URL: ${imageUrl}`,
                `Seed: ${generated.seed}`,
                `Model: ${request.modelId}`,
                `Size: ${request.dimensions.width}x${request.dimensions.height}`,
                ...(saved ? [`Expires at: ${saved.expiresAt}`] : []),
                "Show the image URL to the user. Do not expose or invent base64 data."
              ].join("\n")
            }
          ]
        };
      } catch (error) {
        log("error", "generation_failed", safeErrorLogFields(error));

        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Image generation failed: ${error?.message ?? String(error)}`
            }
          ]
        };
      }
    }
  );

  return server;
}

await initializeImageStorage(config.imageDir);
const initiallyRemoved = await cleanupExpiredImages(
  config.imageDir,
  config.imageTtlMs
);
if (initiallyRemoved > 0) {
  log("info", "startup_cleanup", { removed: initiallyRemoved });
}

const cleanupTimer = setInterval(async () => {
  try {
    const removed = await cleanupExpiredImages(
      config.imageDir,
      config.imageTtlMs
    );
    if (removed > 0) log("info", "scheduled_cleanup", { removed });
  } catch (error) {
    log("error", "cleanup_failed", safeErrorLogFields(error));
  }
}, 60 * 60 * 1000);
cleanupTimer.unref();

const app = express();
app.disable("x-powered-by");

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader(
    "Access-Control-Allow-Methods",
    "POST, GET, DELETE, OPTIONS"
  );
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Accept, Authorization, Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID, XBY-APIKEY"
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
  res.json({
    status: "ok",
    service: SERVICE_NAME,
    version: SERVICE_VERSION
  });
});

app.get("/images/:fileName", async (req, res) => {
  const filePath = resolvePublicImagePath(
    config.imageDir,
    req.params.fileName
  );
  if (!filePath) return res.sendStatus(404);

  try {
    await access(filePath);
  } catch {
    return res.sendStatus(404);
  }

  res.setHeader("Cache-Control", "public, max-age=3600, immutable");
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  return res.sendFile(filePath);
});

app.post("/mcp", requireMcpBearerToken, async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const mcpServer = createMcpServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined
  });

  try {
    await mcpServer.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    log("error", "mcp_request_failed", safeErrorLogFields(error));

    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: {
          code: -32603,
          message: "Internal server error"
        },
        id: null
      });
    }
  } finally {
    res.on("close", () => {
      Promise.allSettled([
        transport.close(),
        mcpServer.close()
      ]).catch(() => {});
    });
  }
});

app.get("/mcp", requireMcpBearerToken, (req, res) =>
  mcpMethodNotAllowed(res)
);
app.delete("/mcp", requireMcpBearerToken, (req, res) =>
  mcpMethodNotAllowed(res)
);

app.use((error, req, res, next) => {
  log("error", "http_error", safeErrorLogFields(error));
  if (res.headersSent) return next(error);
  res.status(500).json({ error: "internal_server_error" });
});

const httpServer = app.listen(config.port, config.host, () => {
  log("info", "server_started", {
    host: config.host,
    port: config.port,
    publicBaseUrl: config.publicBaseUrl,
    upstreamProfile: config.upstreamProfile,
    upstreamHost: new URL(config.upstreamBaseUrl).host,
    upstreamPath: config.upstreamGeneratePath,
    imageDir: config.imageDir,
    imageTtlHours: config.imageTtlMs / 3_600_000
  });
});

httpServer.on("error", (error) => {
  log("fatal", "server_start_failed", safeErrorLogFields(error));
  process.exit(1);
});

async function shutdown(signal) {
  log("info", "shutdown_started", { signal });
  clearInterval(cleanupTimer);
  httpServer.close((error) => {
    if (error) {
      log("error", "shutdown_failed", safeErrorLogFields(error));
      process.exit(1);
    }
    process.exit(0);
  });
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
