import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createHttpApp } from "../build/http-app.js";

const TOKEN = "t".repeat(32);
const ORIGIN = "https://example.test";

async function withServer(overrides, callback) {
  const app = createHttpApp({
    allowedOrigins: [ORIGIN],
    bearerToken: TOKEN,
    jsonLimitBytes: 1024,
    rateLimitPerMinute: 20,
    isReady: () => true,
    handleMcpPost: async (req, res) => { res.status(200).json({ received: req.body }); },
    ...overrides,
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not bind a TCP port");
  try { await callback(`http://127.0.0.1:${address.port}`); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

test("health is public while readiness reflects service state", async () => {
  await withServer({ isReady: () => false }, async base => {
    assert.equal((await fetch(`${base}/health`)).status, 200);
    assert.equal((await fetch(`${base}/ready`)).status, 503);
  });
});

test("MCP POST requires exact bearer auth and an allowed browser origin", async () => {
  await withServer({}, async base => {
    assert.equal((await fetch(`${base}/mcp`, { method: "POST" })).status, 401);
    assert.equal((await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, Origin: "https://wrong.test", "Content-Type": "application/json" },
      body: "{}",
    })).status, 403);

    const response = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, Origin: ORIGIN, "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0" }),
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("access-control-allow-origin"), ORIGIN);
    assert.deepEqual(await response.json(), { received: { jsonrpc: "2.0" } });
  });
});

test("allowed CORS preflight succeeds without exposing wildcard access", async () => {
  await withServer({}, async base => {
    const response = await fetch(`${base}/mcp`, { method: "OPTIONS", headers: { Origin: ORIGIN } });
    assert.equal(response.status, 204);
    assert.equal(response.headers.get("access-control-allow-origin"), ORIGIN);
  });
});

test("invalid JSON is rejected generically", async () => {
  await withServer({}, async base => {
    const response = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: "{",
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "invalid_request" });
  });
});

test("MCP POST requires a supported JSON media type and object body", async () => {
  await withServer({}, async base => {
    const unsupported = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "text/plain" },
      body: "{}",
    });
    assert.equal(unsupported.status, 415);
    assert.deepEqual(await unsupported.json(), { error: "unsupported_media_type" });

    const nonObject = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: "[]",
    });
    assert.equal(nonObject.status, 400);
    assert.deepEqual(await nonObject.json(), { error: "invalid_request" });
  });
});

test("application request rate limit is enforced", async () => {
  await withServer({ rateLimitPerMinute: 1 }, async base => {
    const init = {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: "{}",
    };
    assert.equal((await fetch(`${base}/mcp`, { method: "POST" })).status, 401);
    assert.equal((await fetch(`${base}/mcp`, init)).status, 200);
    const limited = await fetch(`${base}/mcp`, init);
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get("retry-after")) >= 1);
  });
});
