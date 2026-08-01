import {
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
} from 'node:fs/promises';
import path from 'node:path';

const JOB_VERSION = 1;
const TERMINAL_STATUSES = new Set([
  'succeeded',
  'failed',
  'cancelled',
]);
const PUBLIC_STATUSES = new Set([
  'queued',
  'running',
  'succeeded',
  'failed',
  'cancelled',
]);
const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_RECORDS = 500;
const DEFAULT_MAX_REQUEST_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_RESULT_BYTES = 48 * 1024 * 1024;
const DEFAULT_MAX_CONCURRENCY = 1;
const MAX_ID_LENGTH = 200;
const ID_RE = /^[A-Za-z0-9._:-]+$/;

class HttpError extends Error {
  constructor(status, error, message, details) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.error = error;
    this.details = details;
  }
}

class JobExecutionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'JobExecutionError';
    this.code = code || 'tool_execution_failed';
  }
}

const finiteInt = (value, fallback, min, max) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
};

const now = () => Date.now();

const cloneJson = value => JSON.parse(JSON.stringify(value));

const isPlainObject = value =>
  Boolean(
    value
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype,
  );

const stableValue = value => {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) {
      return String(value);
    }
    return value;
  }
  const output = {};
  for (const key of Object.keys(value).sort()) {
    if (value[key] === undefined) continue;
    output[key] = stableValue(value[key]);
  }
  return output;
};

const stableStringify = value => JSON.stringify(stableValue(value));

const hashRequest = (toolName, args) =>
  createHash('sha256')
    .update(toolName)
    .update('\0')
    .update(stableStringify(args))
    .digest('hex');

const makeJobId = () =>
  `imgjob_${Date.now().toString(36)}_${randomBytes(12).toString('hex')}`;

const safeErrorMessage = value => {
  let text = value instanceof Error
    ? value.message
    : String(value ?? 'Background image job failed');

  text = text
    .replace(
      /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi,
      'Bearer [REDACTED]',
    )
    .replace(
      /\b(api[-_ ]?key|authorization|token|secret|password)\b\s*([:=])\s*([^\s,;]+)/gi,
      (_match, name, separator) => `${name}${separator}[REDACTED]`,
    )
    .replace(/https?:\/\/[^\s<>"')\]]+/gi, '[URL]')
    .replace(/\s+/g, ' ')
    .trim();

  return text.slice(0, 600) || 'Background image job failed';
};

const normalizeExecutionResult = raw => {
  const source = raw?.rawResult && typeof raw.rawResult === 'object'
    ? raw.rawResult
    : raw;

  if (raw?.success === false) {
    throw new JobExecutionError(
      raw?.errorCode || 'tool_execution_failed',
      safeErrorMessage(raw?.error || 'Image tool execution failed'),
    );
  }

  if (!source || typeof source !== 'object') {
    throw new JobExecutionError(
      'invalid_tool_result',
      'Image tool returned an invalid result',
    );
  }

  const nestedResult =
    source.result && typeof source.result === 'object'
      ? source.result
      : null;

  const structuredContent =
    source.structuredContent
    ?? raw?.structuredContent
    ?? nestedResult?.structuredContent
    ?? raw?.data
    ?? source.data;

  const contentCandidate =
    source.content
    ?? raw?.content
    ?? nestedResult?.content;

  const result = {
    structuredContent:
      structuredContent === undefined
        ? undefined
        : cloneJson(structuredContent),
    content: Array.isArray(contentCandidate)
      ? cloneJson(contentCandidate)
      : [],
  };

  if (
    result.structuredContent === undefined
    && result.content.length === 0
  ) {
    throw new JobExecutionError(
      'empty_tool_result',
      'Image tool completed but returned no structuredContent or content',
    );
  }

  if (result.structuredContent === undefined) {
    delete result.structuredContent;
  }

  return result;
};

const publicJob = job => {
  const output = {
    id: job.id,
    clientRequestId: job.clientRequestId,
    toolName: job.toolName,
    status: PUBLIC_STATUSES.has(job.status)
      ? job.status
      : 'failed',
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };

  if (Number.isFinite(job.startedAt)) {
    output.startedAt = job.startedAt;
  }
  if (Number.isFinite(job.completedAt)) {
    output.completedAt = job.completedAt;
  }
  if (job.result && typeof job.result === 'object') {
    output.result = cloneJson(job.result);
  }
  if (job.error && typeof job.error === 'object') {
    output.error = {
      code: String(job.error.code || 'job_failed').slice(0, 120),
      message: safeErrorMessage(job.error.message),
    };
  }

  return output;
};

const safeEqualToken = (provided, expected) => {
  if (!provided || !expected) return false;
  const left = Buffer.from(String(provided));
  const right = Buffer.from(String(expected));
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
};

const readBearer = req => {
  const raw = req.headers?.authorization;
  if (typeof raw !== 'string') return '';
  const match = raw.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
};

const setCors = (res, origin = '*') => {
  res.setHeader('Access-Control-Allow-Origin', origin || '*');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Authorization, Content-Type, Accept',
  );
  res.setHeader(
    'Access-Control-Allow-Methods',
    'GET, POST, OPTIONS',
  );
  res.setHeader('Access-Control-Max-Age', '86400');
  res.setHeader('Cache-Control', 'no-store');
};

const sendJson = (res, status, body, origin = '*') => {
  setCors(res, origin);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
};

const readJsonBody = async (req, maxBytes) => {
  const chunks = [];
  let total = 0;

  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) {
      throw new HttpError(
        413,
        'request_too_large',
        'Request body is too large',
      );
    }
    chunks.push(buffer);
  }

  if (chunks.length === 0) return {};

  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(
      400,
      'invalid_json',
      'Request body must be valid JSON',
    );
  }
};

const validateIdentifier = (value, label) => {
  const text = String(value || '').trim();
  if (
    !text
    || text.length > MAX_ID_LENGTH
    || !ID_RE.test(text)
  ) {
    throw new HttpError(
      400,
      `invalid_${label}`,
      `${label} is invalid`,
    );
  }
  return text;
};

const atomicWriteJson = async (filename, value) => {
  const temp = `${filename}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
  const data = `${JSON.stringify(value)}\n`;
  const handle = await open(temp, 'wx', 0o600);
  try {
    await handle.writeFile(data, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temp, filename);
};

const parseJobFile = async filename => {
  try {
    const raw = JSON.parse(await readFile(filename, 'utf8'));
    if (
      raw?.version !== JOB_VERSION
      || typeof raw.id !== 'string'
      || typeof raw.clientRequestId !== 'string'
      || typeof raw.toolName !== 'string'
      || !isPlainObject(raw.arguments)
      || typeof raw.argumentsHash !== 'string'
      || typeof raw.status !== 'string'
      || !Number.isFinite(raw.createdAt)
      || !Number.isFinite(raw.updatedAt)
    ) {
      return null;
    }
    return raw;
  } catch {
    return null;
  }
};

export class BackgroundJobService {
  constructor(options) {
    if (typeof options?.executeTool !== 'function') {
      throw new TypeError('executeTool must be a function');
    }

    this.dataDir = path.resolve(
      options.dataDir || './data/image-jobs',
    );
    this.allowedToolName = String(
      options.allowedToolName || '',
    ).trim();
    if (!this.allowedToolName) {
      throw new TypeError('allowedToolName is required');
    }

    this.executeTool = options.executeTool;
    this.authToken = String(options.authToken || '');
    if (!this.authToken) {
      throw new TypeError('authToken is required');
    }

    this.corsOrigin = options.corsOrigin || '*';
    this.maxConcurrency = finiteInt(
      options.maxConcurrency,
      DEFAULT_MAX_CONCURRENCY,
      1,
      4,
    );
    this.retentionMs = finiteInt(
      options.retentionMs,
      DEFAULT_RETENTION_MS,
      60_000,
      30 * 24 * 60 * 60 * 1000,
    );
    this.maxRecords = finiteInt(
      options.maxRecords,
      DEFAULT_MAX_RECORDS,
      10,
      5_000,
    );
    this.maxRequestBytes = finiteInt(
      options.maxRequestBytes,
      DEFAULT_MAX_REQUEST_BYTES,
      16 * 1024,
      8 * 1024 * 1024,
    );
    this.maxResultBytes = finiteInt(
      options.maxResultBytes,
      DEFAULT_MAX_RESULT_BYTES,
      1024 * 1024,
      96 * 1024 * 1024,
    );
    this.logger = options.logger || console;

    this.jobs = new Map();
    this.byClient = new Map();
    this.queue = [];
    this.queuedIds = new Set();
    this.running = 0;
    this.started = false;
    this.cleanupTimer = null;
  }

  fileFor(id) {
    return path.join(this.dataDir, `${id}.json`);
  }

  async start() {
    if (this.started) return;
    await mkdir(this.dataDir, {
      recursive: true,
      mode: 0o700,
    });

    const entries = await readdir(this.dataDir, {
      withFileTypes: true,
    });

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) {
        continue;
      }
      const filename = path.join(this.dataDir, entry.name);
      const job = await parseJobFile(filename);
      if (!job) {
        this.logger.warn?.(
          '[ImageJobs] Ignoring invalid job file',
          entry.name,
        );
        continue;
      }

      if (job.status === 'running') {
        job.status = 'failed';
        job.completedAt = now();
        job.updatedAt = job.completedAt;
        job.error = {
          code: 'server_restarted_during_execution',
          message:
            'The image service restarted while this job was running. '
            + 'The job was not replayed to avoid duplicate billing.',
        };
        delete job.result;
        await this.persist(job);
      }

      this.jobs.set(job.id, job);
      this.byClient.set(job.clientRequestId, job.id);

      if (job.status === 'queued') {
        this.enqueue(job.id);
      }
    }

    this.started = true;
    await this.cleanup();

    this.cleanupTimer = setInterval(
      () => this.cleanup().catch(error => {
        this.logger.error?.(
          '[ImageJobs] cleanup failed',
          safeErrorMessage(error),
        );
      }),
      Math.min(this.retentionMs, 10 * 60_000),
    );
    this.cleanupTimer.unref?.();

    this.pump();
  }

  async stop() {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    this.cleanupTimer = null;
  }

  assertAuthorized(req) {
    const provided = readBearer(req);
    if (!safeEqualToken(provided, this.authToken)) {
      throw new HttpError(
        401,
        'unauthorized',
        'Unauthorized',
      );
    }
  }

  async persist(job) {
    const serializable = cloneJson(job);
    const encoded = Buffer.byteLength(
      JSON.stringify(serializable),
      'utf8',
    );
    if (
      job.status === 'succeeded'
      && encoded > this.maxResultBytes
    ) {
      throw new JobExecutionError(
        'result_too_large',
        'Image result is too large for background job storage',
      );
    }
    await atomicWriteJson(this.fileFor(job.id), serializable);
  }

  enqueue(id) {
    if (this.queuedIds.has(id)) return;
    const job = this.jobs.get(id);
    if (!job || job.status !== 'queued') return;
    this.queuedIds.add(id);
    this.queue.push(id);
    if (this.started) this.pump();
  }

  pump() {
    while (
      this.running < this.maxConcurrency
      && this.queue.length > 0
    ) {
      const id = this.queue.shift();
      this.queuedIds.delete(id);
      const job = this.jobs.get(id);
      if (!job || job.status !== 'queued') continue;

      this.running += 1;
      this.runOne(id)
        .catch(error => {
          this.logger.error?.(
            '[ImageJobs] unexpected worker failure',
            safeErrorMessage(error),
          );
        })
        .finally(() => {
          this.running -= 1;
          queueMicrotask(() => this.pump());
        });
    }
  }

  async runOne(id) {
    const job = this.jobs.get(id);
    if (!job || job.status !== 'queued') return;

    const startedAt = now();
    Object.assign(job, {
      status: 'running',
      startedAt,
      updatedAt: startedAt,
    });
    delete job.completedAt;
    delete job.error;
    delete job.result;
    await this.persist(job);

    try {
      const raw = await this.executeTool(
        job.toolName,
        cloneJson(job.arguments),
        {
          jobId: job.id,
          clientRequestId: job.clientRequestId,
        },
      );
      const result = normalizeExecutionResult(raw);

      const completedAt = now();
      Object.assign(job, {
        status: 'succeeded',
        result,
        completedAt,
        updatedAt: completedAt,
      });
      delete job.error;

      await this.persist(job);
      this.logger.info?.(
        `[ImageJobs] succeeded id=${job.id} tool=${job.toolName}`,
      );
    } catch (error) {
      const completedAt = now();
      const code = error instanceof JobExecutionError
        ? error.code
        : 'tool_execution_failed';

      Object.assign(job, {
        status: 'failed',
        completedAt,
        updatedAt: completedAt,
        error: {
          code,
          message: safeErrorMessage(error),
        },
      });
      delete job.result;

      try {
        await this.persist(job);
      } catch (persistError) {
        this.logger.error?.(
          '[ImageJobs] failed to persist terminal failure',
          safeErrorMessage(persistError),
        );
      }

      this.logger.warn?.(
        `[ImageJobs] failed id=${job.id} tool=${job.toolName} code=${code}`,
      );
    }
  }

  async createJob(input) {
    const clientRequestId = validateIdentifier(
      input?.clientRequestId,
      'client_request_id',
    );
    const toolName = String(input?.toolName || '').trim();

    if (toolName !== this.allowedToolName) {
      throw new HttpError(
        400,
        'unsupported_tool',
        'Unsupported image tool',
      );
    }
    if (!isPlainObject(input?.arguments)) {
      throw new HttpError(
        422,
        'invalid_arguments',
        'arguments must be a JSON object',
      );
    }

    const args = cloneJson(input.arguments);
    const argumentsHash = hashRequest(toolName, args);
    const existingId = this.byClient.get(clientRequestId);

    if (existingId) {
      const existing = this.jobs.get(existingId);
      if (existing) {
        if (
          existing.toolName !== toolName
          || existing.argumentsHash !== argumentsHash
        ) {
          throw new HttpError(
            409,
            'client_request_conflict',
            'clientRequestId already belongs to a different request',
          );
        }
        return {
          created: false,
          job: publicJob(existing),
        };
      }
    }

    const timestamp = now();
    const job = {
      version: JOB_VERSION,
      id: makeJobId(),
      clientRequestId,
      toolName,
      arguments: args,
      argumentsHash,
      status: 'queued',
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    await this.persist(job);
    this.jobs.set(job.id, job);
    this.byClient.set(clientRequestId, job.id);
    this.enqueue(job.id);

    return {
      created: true,
      job: publicJob(job),
    };
  }

  getById(id) {
    return this.jobs.get(id) || null;
  }

  getByClientId(clientRequestId) {
    const id = this.byClient.get(clientRequestId);
    return id ? this.jobs.get(id) || null : null;
  }

  async cleanup() {
    const terminal = [...this.jobs.values()]
      .filter(job => TERMINAL_STATUSES.has(job.status))
      .sort((a, b) => b.updatedAt - a.updatedAt);

    const keepIds = new Set(
      terminal.slice(0, this.maxRecords).map(job => job.id),
    );
    const cutoff = now() - this.retentionMs;

    for (const job of terminal) {
      if (keepIds.has(job.id) && job.updatedAt >= cutoff) {
        continue;
      }

      this.jobs.delete(job.id);
      if (this.byClient.get(job.clientRequestId) === job.id) {
        this.byClient.delete(job.clientRequestId);
      }
      await rm(this.fileFor(job.id), { force: true });
    }
  }

  async handle(req, res) {
    const url = new URL(
      req.url || '/',
      'http://127.0.0.1',
    );
    const pathname = url.pathname;

    if (
      pathname !== '/jobs'
      && !pathname.startsWith('/jobs/')
    ) {
      return false;
    }

    if (req.method === 'OPTIONS') {
      setCors(res, this.corsOrigin);
      res.statusCode = 204;
      res.end();
      return true;
    }

    try {
      this.assertAuthorized(req);

      if (req.method === 'POST' && pathname === '/jobs') {
        const input = await readJsonBody(
          req,
          this.maxRequestBytes,
        );
        const result = await this.createJob(input);
        sendJson(
          res,
          result.created ? 202 : 200,
          result,
          this.corsOrigin,
        );
        return true;
      }

      if (
        req.method === 'GET'
        && pathname.startsWith('/jobs/by-client/')
      ) {
        const encoded = pathname.slice(
          '/jobs/by-client/'.length,
        );
        const clientRequestId = validateIdentifier(
          decodeURIComponent(encoded),
          'client_request_id',
        );
        const job = this.getByClientId(clientRequestId);
        if (!job) {
          throw new HttpError(
            404,
            'job_not_found',
            'Job not found',
          );
        }
        sendJson(
          res,
          200,
          { job: publicJob(job) },
          this.corsOrigin,
        );
        return true;
      }

      if (
        req.method === 'GET'
        && pathname.startsWith('/jobs/')
      ) {
        const encoded = pathname.slice('/jobs/'.length);
        const id = validateIdentifier(
          decodeURIComponent(encoded),
          'job_id',
        );
        const job = this.getById(id);
        if (!job) {
          throw new HttpError(
            404,
            'job_not_found',
            'Job not found',
          );
        }
        sendJson(
          res,
          200,
          { job: publicJob(job) },
          this.corsOrigin,
        );
        return true;
      }

      throw new HttpError(
        405,
        'method_not_allowed',
        'Method not allowed',
      );
    } catch (error) {
      const status = error instanceof HttpError
        ? error.status
        : 500;
      const code = error instanceof HttpError
        ? error.error
        : 'internal_error';
      const message = error instanceof HttpError
        ? error.message
        : 'Internal server error';

      if (!(error instanceof HttpError)) {
        this.logger.error?.(
          '[ImageJobs] route error',
          safeErrorMessage(error),
        );
      }

      sendJson(
        res,
        status,
        {
          error: code,
          message,
        },
        this.corsOrigin,
      );
      return true;
    }
  }
}

export const createBackgroundJobService = async options => {
  const service = new BackgroundJobService(options);
  await service.start();
  return service;
};

export const backgroundJobOptionsFromEnv = ({
  executeTool,
  logger = console,
  defaultDir,
  defaultTool,
  corsOrigin = '*',
} = {}) => ({
  executeTool,
  logger,
  dataDir:
    process.env.IMAGE_JOBS_DIR
    || defaultDir
    || './data/image-jobs',
  allowedToolName:
    process.env.IMAGE_JOBS_ALLOWED_TOOL
    || defaultTool,
  authToken: process.env.MCP_BEARER_TOKEN || '',
  corsOrigin:
    process.env.IMAGE_JOBS_CORS_ORIGIN
    || corsOrigin,
  maxConcurrency:
    process.env.IMAGE_JOBS_MAX_CONCURRENCY,
  retentionMs:
    process.env.IMAGE_JOBS_RETENTION_MS,
  maxRecords:
    process.env.IMAGE_JOBS_MAX_RECORDS,
  maxRequestBytes:
    process.env.IMAGE_JOBS_MAX_REQUEST_BYTES,
  maxResultBytes:
    process.env.IMAGE_JOBS_MAX_RESULT_BYTES,
});

export {
  HttpError,
  JobExecutionError,
  normalizeExecutionResult,
  publicJob,
};
