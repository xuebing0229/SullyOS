import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const TERMINAL_STATUSES = new Set(["succeeded", "failed", "cancelled"]);
const CLIENT_REQUEST_ID_RE = /^[A-Za-z0-9._:-]{8,160}$/;

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (isPlainObject(value)) {
    const output = {};
    for (const key of Object.keys(value).sort()) output[key] = stableValue(value[key]);
    return output;
  }
  return value;
}

function requestHash(toolName, args) {
  return createHash("sha256")
    .update(JSON.stringify(stableValue({ toolName, arguments: args })))
    .digest("hex");
}

function validateLoadedJob(value) {
  if (!isPlainObject(value)) return null;
  if (typeof value.id !== "string" || !value.id) return null;
  if (typeof value.clientRequestId !== "string" || !CLIENT_REQUEST_ID_RE.test(value.clientRequestId)) return null;
  if (typeof value.toolName !== "string" || !value.toolName) return null;
  if (!isPlainObject(value.arguments)) return null;
  if (!isPlainObject(value.executionContext)) return null;
  if (typeof value.requestHash !== "string" || !/^[a-f0-9]{64}$/i.test(value.requestHash)) return null;
  if (typeof value.status !== "string") return null;
  if (!Number.isFinite(value.createdAt) || !Number.isFinite(value.updatedAt)) return null;
  return value;
}

function safeFileName(jobId) {
  if (!/^[a-f0-9-]{16,80}$/i.test(jobId)) throw new Error("Invalid job id");
  return `${jobId}.json`;
}

function jobPath(directory, jobId) {
  return path.join(directory, safeFileName(jobId));
}

async function writeJsonAtomic(directory, job) {
  const target = jobPath(directory, job.id);
  const temporary = path.join(directory, `.${safeFileName(job.id)}.${process.pid}.${Date.now()}.tmp`);
  await writeFile(temporary, JSON.stringify(job), { encoding: "utf8", mode: 0o600 });
  await rename(temporary, target);
}

function defaultPublicError(error) {
  const raw = String(error?.message || "Image generation failed");
  const correlationId = raw.match(/correlation ID ([a-f0-9]{8,64})/i)?.[1];
  return {
    code: typeof error?.code === "string" ? error.code.slice(0, 80) : "generation_failed",
    message: correlationId
      ? `Image generation failed (correlation ID ${correlationId})`
      : raw.slice(0, 500)
  };
}

function toPublicJob(job) {
  return {
    id: job.id,
    clientRequestId: job.clientRequestId,
    toolName: job.toolName,
    status: job.status,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    ...(job.startedAt ? { startedAt: job.startedAt } : {}),
    ...(job.completedAt ? { completedAt: job.completedAt } : {}),
    ...(job.result !== undefined ? { result: clone(job.result) } : {}),
    ...(job.error ? { error: clone(job.error) } : {})
  };
}

export function createPersistentImageJobQueue({
  directory,
  ttlMs,
  execute,
  log = () => {},
  toPublicError = defaultPublicError,
  maxRetainedJobs = 300
}) {
  if (!directory) throw new Error("Job directory is required");
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new Error("Job ttlMs must be positive");
  if (!Number.isSafeInteger(maxRetainedJobs) || maxRetainedJobs <= 0) throw new Error("maxRetainedJobs must be positive");
  if (typeof execute !== "function") throw new Error("Job execute function is required");

  const jobsById = new Map();
  const jobIdByClientRequestId = new Map();
  let initialized = false;
  let pumping = false;
  let accepting = true;

  const persist = async job => {
    job.updatedAt = Date.now();
    await writeJsonAtomic(directory, job);
  };

  const indexJob = job => {
    jobsById.set(job.id, job);
    jobIdByClientRequestId.set(job.clientRequestId, job.id);
  };

  const removeIndexedJob = async job => {
    jobsById.delete(job.id);
    if (jobIdByClientRequestId.get(job.clientRequestId) === job.id) {
      jobIdByClientRequestId.delete(job.clientRequestId);
    }
    await rm(jobPath(directory, job.id), { force: true });
  };

  const nextQueuedJob = () => [...jobsById.values()]
    .filter(job => job.status === "queued")
    .sort((a, b) => a.createdAt - b.createdAt)[0];

  const runJob = async job => {
    job.status = "running";
    job.startedAt = Date.now();
    delete job.completedAt;
    delete job.error;
    delete job.result;
    await persist(job);

    log("info", "background_job_started", { jobId: job.id, toolName: job.toolName });

    try {
      const result = await execute({
        jobId: job.id,
        clientRequestId: job.clientRequestId,
        toolName: job.toolName,
        arguments: clone(job.arguments),
        executionContext: clone(job.executionContext)
      });
      job.status = "succeeded";
      job.result = clone(result);
      job.completedAt = Date.now();
      await persist(job);
      log("info", "background_job_succeeded", { jobId: job.id, toolName: job.toolName });
    } catch (error) {
      job.status = "failed";
      job.error = toPublicError(error);
      job.completedAt = Date.now();
      await persist(job);
      log("error", "background_job_failed", {
        jobId: job.id,
        toolName: job.toolName,
        errorName: error?.name || "Error"
      });
    }
  };

  const pump = async () => {
    if (!initialized || pumping || !accepting) return;
    pumping = true;
    try {
      while (accepting) {
        const job = nextQueuedJob();
        if (!job) break;
        await runJob(job);
      }
    } finally {
      pumping = false;
      if (accepting && nextQueuedJob()) queueMicrotask(() => void pump());
    }
  };

  const initialize = async () => {
    if (initialized) return;
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const files = await readdir(directory, { withFileTypes: true });

    for (const entry of files) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      try {
        const parsed = JSON.parse(await readFile(path.join(directory, entry.name), "utf8"));
        const job = validateLoadedJob(parsed);
        if (!job) {
          log("error", "background_job_invalid_file", { fileName: entry.name });
          continue;
        }
        if (job.status === "running") {
          job.status = "failed";
          job.completedAt = Date.now();
          job.error = {
            code: "service_restarted",
            message: "Image service restarted while the job was running"
          };
          await persist(job);
        }
        indexJob(job);
      } catch (error) {
        log("error", "background_job_load_failed", {
          fileName: entry.name,
          errorName: error?.name || "Error"
        });
      }
    }

    initialized = true;
    queueMicrotask(() => void pump());
  };

  const enqueue = async ({ clientRequestId, toolName, arguments: args, executionContext }) => {
    if (!initialized) throw new Error("Background image job queue is not initialized");
    if (!accepting) throw new Error("Background image job queue is shutting down");
    if (typeof clientRequestId !== "string" || !CLIENT_REQUEST_ID_RE.test(clientRequestId)) {
      const error = new Error("Invalid clientRequestId");
      error.code = "invalid_client_request_id";
      throw error;
    }
    if (typeof toolName !== "string" || !toolName.trim()) {
      const error = new Error("Invalid toolName");
      error.code = "invalid_tool_name";
      throw error;
    }
    if (!isPlainObject(args)) {
      const error = new Error("arguments must be an object");
      error.code = "invalid_arguments";
      throw error;
    }
    if (!isPlainObject(executionContext)) {
      const error = new Error("executionContext must be an object");
      error.code = "invalid_execution_context";
      throw error;
    }

    const normalizedTool = toolName.trim();
    const hash = requestHash(normalizedTool, args);
    const existingId = jobIdByClientRequestId.get(clientRequestId);

    if (existingId) {
      const existing = jobsById.get(existingId);
      if (existing) {
        if (existing.requestHash !== hash) {
          const error = new Error("clientRequestId was already used for a different request");
          error.code = "IDEMPOTENCY_CONFLICT";
          throw error;
        }
        return { created: false, job: toPublicJob(existing) };
      }
    }

    const timestamp = Date.now();
    const job = {
      id: randomUUID(),
      clientRequestId,
      toolName: normalizedTool,
      arguments: clone(args),
      executionContext: clone(executionContext),
      requestHash: hash,
      status: "queued",
      createdAt: timestamp,
      updatedAt: timestamp
    };

    indexJob(job);
    await persist(job);
    log("info", "background_job_queued", { jobId: job.id, toolName: job.toolName });
    queueMicrotask(() => void pump());
    return { created: true, job: toPublicJob(job) };
  };

  const getById = jobId => {
    const job = jobsById.get(jobId);
    return job ? toPublicJob(job) : null;
  };

  const getByClientRequestId = clientRequestId => {
    const id = jobIdByClientRequestId.get(clientRequestId);
    const job = id ? jobsById.get(id) : null;
    return job ? toPublicJob(job) : null;
  };

  const cleanup = async () => {
    if (!initialized) return 0;
    const timestamp = Date.now();
    let removed = 0;
    const terminal = [...jobsById.values()]
      .filter(job => TERMINAL_STATUSES.has(job.status))
      .sort((a, b) => a.updatedAt - b.updatedAt);

    for (const job of terminal) {
      const expired = timestamp - job.updatedAt >= ttlMs;
      const overLimit = jobsById.size > maxRetainedJobs;
      if (!expired && !overLimit) continue;
      await removeIndexedJob(job);
      removed++;
    }
    return removed;
  };

  return {
    initialize,
    enqueue,
    getById,
    getByClientRequestId,
    cleanup,
    shutdown: () => { accepting = false; }
  };
}
