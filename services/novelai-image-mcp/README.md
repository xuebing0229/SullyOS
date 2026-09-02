# NovelAI-compatible Image MCP for SullyOS

This service supports three upstream presets and runtime configuration from the SullyOS settings page.


## Multi-user token isolation

The service can authorize multiple SullyOS clients without sharing their image-provider credentials.

- `MCP_BEARER_TOKEN` is the primary/owner token and keeps the existing legacy data paths.
- Add friend/device tokens with `MCP_EXTRA_BEARER_TOKENS` (comma/space separated), or `MCP_BEARER_TOKENS_JSON`.
- Every extra token receives its own runtime config file, temporary image directory, and background-job store.
- NovelAI Precise Reference images and Vibe encoding caches are isolated per token too.
- Extra tenants never inherit the primary bootstrap upstream API key; they must save their own key from SullyOS settings.
- Token namespaces are derived from a one-way SHA-256 hash; raw tokens are never used as directory names.

Adding or removing authorized tokens requires updating the service environment and restarting the service. Existing primary-token data needs no migration.

## Runtime configuration from SullyOS

Environment variables are bootstrap defaults only. The built-in **Settings → Image generation → NovelAI** panel uses the bearer-protected endpoints below:

```text
GET  /config
PUT  /config
POST /config/test
```

The upstream API key is stored only in `RUNTIME_CONFIG_FILE` on the server. The file is written atomically with mode `0600`; `GET /config` returns only `apiKeyConfigured` and a masked `apiKeyHint`. Updates support `expectedRevision` conflict protection. Omitting `apiKey` keeps the existing key, while `clearApiKey: true` explicitly removes it.

The phone stores the MCP bearer token used to access this service, but it never receives or stores the upstream API key.

## Official NovelAI

Only fill the key:

```env
UPSTREAM_PROFILE=official
UPSTREAM_API_KEY=pst-REPLACE_ME
```

The official URL, path, Bearer authentication, and V4.5 Full/Curated model names
are filled automatically.

## Standard API station

Usually only fill the station URL and key:

```env
UPSTREAM_PROFILE=standard
UPSTREAM_BASE_URL=https://api-station.example
UPSTREAM_API_KEY=sk-REPLACE_ME
```

It assumes a common NovelAI-compatible `/ai/generate-image` endpoint and
`Authorization: Bearer <key>` authentication.

## Custom API station

Only unusual stations need advanced settings:

```env
UPSTREAM_PROFILE=custom
UPSTREAM_BASE_URL=https://api-station.example
UPSTREAM_API_KEY=sk-REPLACE_ME
UPSTREAM_GENERATE_PATH=/v1/custom-image
UPSTREAM_AUTH_HEADER=X-API-Key
UPSTREAM_AUTH_PREFIX=
UPSTREAM_MODEL_FULL=station-model
UPSTREAM_MODEL_CURATED=station-model
```

Explicit environment variables override preset values.

## SullyOS-facing settings

```env
MCP_BEARER_TOKEN=REPLACE_WITH_A_DIFFERENT_LONG_RANDOM_TOKEN
PUBLIC_BASE_URL=https://example.com/novelai
```

SullyOS connects to:

```text
https://example.com/novelai/mcp
```

## Run

```bash
cp .env.example .env
npm install
npm run check
npm test
npm run dev
```

For local development, you may override `IMAGE_DIR=./data/images` and
`RUNTIME_CONFIG_FILE=./data/config.json`. The systemd deployment keeps both under
`/var/lib/novelai-image-mcp`, matching its write sandbox.

The service supports common JSON base64, JSON/NDJSON image URL, raw image,
and ZIP responses. Relative image URLs are resolved against the configured upstream. Images can either be returned as safe same-origin HTTPS URLs or saved locally and
returned to SullyOS as temporary HTTPS URLs, according to the selected delivery mode.


## Image delivery mode

Select image delivery in the SullyOS settings page or through bootstrap configuration; no JavaScript edits are required:

```env
UPSTREAM_IMAGE_DELIVERY=auto
```

- `auto` (default): directly return a same-origin HTTPS image URL; otherwise save and proxy the image locally.
- `direct`: require a same-origin HTTPS image URL and never download it through this service.
- `proxy`: always download URL responses and save them locally, like ZIP, base64, and raw image responses.

This keeps one MCP tool while allowing URL-capable and binary-only upstreams to be switched using environment settings.

## Persistent background image jobs

Authenticated clients can create and recover idempotent jobs through `POST /jobs`, `GET /jobs/:jobId`, and `GET /jobs/by-client/:clientRequestId`. Each job freezes the runtime configuration and API key that were active at creation time. Background execution always forces proxy delivery so the generated image is stored by this service before the phone downloads it. Public job responses never expose the frozen execution context. Precise-reference arguments continue to use the existing private reference store.

Configure `JOB_DIR`, `JOB_TTL_HOURS`, `MAX_RETAINED_JOBS`, `MAX_IMAGE_BYTES`, and `MAX_UPSTREAM_RESPONSE_BYTES`. The supplied systemd unit limits memory and task count for small 2-core/2-GB hosts. `/mcp` remains synchronous for compatibility.
