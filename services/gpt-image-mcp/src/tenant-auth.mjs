import { createHash, timingSafeEqual } from "node:crypto";

const normalizeToken = value => String(value || "").replace(/^Bearer\s+/i, "").trim();

const safeEqual = (leftValue, rightValue) => {
  const left = Buffer.from(String(leftValue || ""));
  const right = Buffer.from(String(rightValue || ""));
  return left.length === right.length && left.length > 0 && timingSafeEqual(left, right);
};

const collectExtraTokens = (env = process.env) => {
  const tokens = [];
  const flat = String(env.MCP_EXTRA_BEARER_TOKENS || "")
    .split(/[\s,;]+/)
    .map(normalizeToken)
    .filter(Boolean);
  tokens.push(...flat);

  const rawJson = String(env.MCP_BEARER_TOKENS_JSON || "").trim();
  if (rawJson) {
    let parsed;
    try {
      parsed = JSON.parse(rawJson);
    } catch {
      throw new Error("MCP_BEARER_TOKENS_JSON must be valid JSON");
    }
    const values = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === "object"
        ? Object.values(parsed)
        : [];
    for (const value of values) {
      const token = normalizeToken(value);
      if (token) tokens.push(token);
    }
  }
  return tokens;
};

const tenantIdForToken = token =>
  "tenant-" + createHash("sha256").update(token).digest("hex").slice(0, 24);

export function createBearerTenantRegistry({
  primaryToken,
  env = process.env
} = {}) {
  const primary = normalizeToken(primaryToken);
  if (!primary) throw new Error("primaryToken is required");

  const records = [{
    id: "primary",
    token: primary,
    primary: true
  }];

  for (const token of collectExtraTokens(env)) {
    if (records.some(record => safeEqual(record.token, token))) continue;
    records.push({
      id: tenantIdForToken(token),
      token,
      primary: false
    });
  }

  return {
    size: records.length,
    resolve(tokenValue) {
      const token = normalizeToken(tokenValue);
      if (!token) return null;
      const match = records.find(record => safeEqual(record.token, token));
      return match ? { ...match } : null;
    },
    resolveRequest(req) {
      const raw = req?.headers?.authorization ?? req?.get?.("authorization") ?? "";
      const match = String(raw || "").match(/^Bearer\s+(.+)$/i);
      return match ? this.resolve(match[1]) : null;
    },
    resolveId(id) {
      const match = records.find(record => record.id === String(id || ""));
      return match ? { ...match } : null;
    },
    listTenantIds() {
      return records.map(record => record.id);
    }
  };
}

export function tenantChildPath(basePath, tenant) {
  if (tenant?.primary) return basePath;
  return basePath + "/tenants/" + tenant.id;
}

export function tenantConfigPath(primaryConfigPath, tenant) {
  if (tenant?.primary) return primaryConfigPath;
  const slash = primaryConfigPath.lastIndexOf("/");
  const dir = slash >= 0 ? primaryConfigPath.slice(0, slash) : ".";
  return dir + "/tenants/" + tenant.id + "/config.json";
}
