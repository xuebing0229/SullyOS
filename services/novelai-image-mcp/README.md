# NovelAI-compatible Image MCP for SullyOS

This build has three presets so normal use does not require editing many fields.

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

For local development, you may override `IMAGE_DIR=./data/images`. The systemd
deployment uses `/var/lib/novelai-image-mcp`, matching its write sandbox.

The service still supports common JSON base64, image URL, raw image, and ZIP
responses. Images are saved locally and returned to SullyOS as temporary HTTPS
URLs.
