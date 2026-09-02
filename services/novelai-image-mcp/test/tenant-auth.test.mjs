import assert from "node:assert/strict";
import test from "node:test";
import { createBearerTenantRegistry, tenantChildPath, tenantConfigPath } from "../src/tenant-auth.mjs";

test("primary token keeps legacy namespace and extra tokens get stable isolated namespaces", () => {
  const registry = createBearerTenantRegistry({
    primaryToken: "owner-token",
    env: { MCP_EXTRA_BEARER_TOKENS: "friend-token, second-token" }
  });
  assert.equal(registry.size, 3);
  const owner = registry.resolve("owner-token");
  const friend = registry.resolve("friend-token");
  assert.equal(owner.id, "primary");
  assert.equal(owner.primary, true);
  assert.equal(friend.primary, false);
  assert.match(friend.id, /^tenant-[a-f0-9]{24}$/);
  assert.notEqual(friend.id, registry.resolve("second-token").id);
  assert.equal(tenantChildPath("/var/lib/images", owner), "/var/lib/images");
  assert.equal(tenantChildPath("/var/lib/images", friend), "/var/lib/images/tenants/" + friend.id);
  assert.equal(tenantConfigPath("/var/lib/service/config.json", owner), "/var/lib/service/config.json");
  assert.equal(tenantConfigPath("/var/lib/service/config.json", friend), "/var/lib/service/tenants/" + friend.id + "/config.json");
});

test("JSON token map is supported and unknown tokens are rejected", () => {
  const registry = createBearerTenantRegistry({
    primaryToken: "owner-token",
    env: { MCP_BEARER_TOKENS_JSON: JSON.stringify({ friend: "friend-token" }) }
  });
  assert.ok(registry.resolve("friend-token"));
  assert.equal(registry.resolve("nope"), null);
});
