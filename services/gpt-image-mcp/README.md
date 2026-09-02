# SullyOS GPT Image MCP

A standalone Streamable HTTP MCP for `gpt-image-2` and OpenAI-compatible image APIs.

Public routing is intentionally split:

- MCP: `https://ag.apixb.top/mcp` (keeps the existing SullyOS endpoint)
- control/config: `https://ag.apixb.top/gpt-image/config`
- temporary images: `https://ag.apixb.top/gpt-image/images/<random>.<ext>`

The normal mode always calls:

```text
POST {Base URL}/images/generations
Authorization: Bearer <API key>
```

Custom mode can change the generation path, auth header/prefix, request field paths,
extra JSON body, and response URL/base64 paths. It does not execute user-supplied JavaScript.

Runtime configuration is stored as a mode-0600 JSON file. `GET /config` never returns the
full upstream API key. Omitting `apiKey` on `PUT /config` keeps the old key.

## Multi-user token isolation

The service can authorize multiple SullyOS clients without sharing their image-provider credentials.

- `MCP_BEARER_TOKEN` is the primary/owner token and keeps the existing legacy data paths.
- Add friend/device tokens with `MCP_EXTRA_BEARER_TOKENS` (comma/space separated), or `MCP_BEARER_TOKENS_JSON`.
- Every extra token receives its own runtime config file, temporary image directory, and background-job store.
- Extra tenants never inherit the primary bootstrap upstream API key; they must save their own key from SullyOS settings.
- Token namespaces are derived from a one-way SHA-256 hash; raw tokens are never used as directory names.

Adding or removing authorized tokens requires updating the service environment and restarting the service. Existing primary-token data needs no migration.

## Local development

```bash
cp .env.example .env
set -a; . ./.env; set +a
npm install
npm run check
npm test
npm start
```

## Persistent background image jobs

Authenticated clients can create and recover idempotent jobs through `POST /jobs`, `GET /jobs/:jobId`, and `GET /jobs/by-client/:clientRequestId`. Each job freezes the runtime configuration and API key that were active at creation time. Background execution always forces proxy delivery so the generated image is stored by this service before the phone downloads it. Public job responses never expose the frozen execution context.

Configure `JOB_DIR`, `JOB_TTL_HOURS`, `MAX_RETAINED_JOBS`, `MAX_IMAGE_BYTES`, and `MAX_UPSTREAM_RESPONSE_BYTES`. The supplied systemd unit limits memory and task count for small 2-core/2-GB hosts. `/mcp` remains synchronous for compatibility.
