import test from "node:test";
import assert from "node:assert/strict";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MODULE = pathToFileURL(resolve(ROOT, "deploy", "continuity-listener", "proactive-discord.ts")).href;
const proactiveModule = await import(`${MODULE}?test=${Date.now()}`);
const { createProactiveDiscordTool, proactiveDiscordConfig } = proactiveModule;
const TOKEN = "bridge-secret-" + "b".repeat(32);

test("proactive Discord config accepts only authenticated safe bridge URLs", () => {
  assert.deepEqual(proactiveDiscordConfig({
    DISCORD_BRIDGE_BASE_URL: "http://discord-bridge.railway.internal:3001/",
    DISCORD_BRIDGE_BEARER_TOKEN: TOKEN,
  }), {
    baseUrl: "http://discord-bridge.railway.internal:3001",
    auth: TOKEN,
  });
  assert.throws(() => proactiveDiscordConfig({
    DISCORD_BRIDGE_BASE_URL: "http://public.example/",
    DISCORD_BRIDGE_BEARER_TOKEN: TOKEN,
  }), /HTTPS or private HTTP/);
  assert.throws(() => proactiveDiscordConfig({
    DISCORD_BRIDGE_BASE_URL: "https://user:password@example.test/",
    DISCORD_BRIDGE_BEARER_TOKEN: TOKEN,
  }), /without credentials/);
  assert.throws(() => proactiveDiscordConfig({
    DISCORD_BRIDGE_BASE_URL: "https://example.test/",
    DISCORD_BRIDGE_BEARER_TOKEN: "short",
  }), /at least 32 characters/);
});

test("proactive Discord tool sends only named aliases and returns a verified receipt", async () => {
  const calls = [];
  const tool = createProactiveDiscordTool({ baseUrl: "https://bridge.example", auth: TOKEN }, async (url, options) => {
    calls.push({ url, options });
    const request = JSON.parse(options.body);
    return new Response(JSON.stringify({
      ok: true,
      kind: "proactive_send",
      requestId: request.requestId,
      destination: "aidhd.porch",
      messageId: "1552747341381898294",
    }), { status: 200, headers: { "content-type": "application/json" } });
  });
  const result = await tool.run({
    args: {
      destination: "AIDHD.PORCH",
      message: "What do you choose in your free time?",
      mentions: ["boys"],
    },
    signal: undefined,
  });
  assert.equal(result, "Message sent to aidhd.porch (message_id: 1552747341381898294)");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://bridge.example/bridge/send");
  assert.equal(calls[0].options.headers.authorization, `Bearer ${TOKEN}`);
  const sent = JSON.parse(calls[0].options.body);
  assert.equal(sent.kind, "proactive_send");
  assert.match(sent.requestId, /^[0-9a-f-]{36}$/);
  assert.equal(sent.destination, "aidhd.porch");
  assert.equal(sent.text, "What do you choose in your free time?");
  assert.deepEqual(sent.mentions, ["boys"]);
});

test("proactive Discord tool rejects raw IDs, duplicates, empty text, and invalid receipts", async () => {
  let calls = 0;
  const tool = createProactiveDiscordTool({ baseUrl: "https://bridge.example", auth: TOKEN }, async () => {
    calls += 1;
    return new Response(JSON.stringify({ ok: true, destination: "aidhd.porch", messageId: "not-a-snowflake" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  assert.equal((await tool.run({ args: { destination: "1484817875914199050", message: "no" } })).status, "error");
  assert.equal((await tool.run({ args: { destination: "aidhd.porch", message: "  " } })).status, "error");
  assert.equal((await tool.run({ args: { destination: "aidhd.porch", message: "hi", mentions: ["boys", "BOYS"] } })).status, "error");
  assert.equal((await tool.run({ args: { destination: "aidhd.porch", message: "hi", channel: "1484817875914199050" } })).status, "error");
  assert.equal(calls, 0);
  assert.equal((await tool.run({ args: { destination: "aidhd.porch", message: "hi" } })).status, "error");
  assert.equal(calls, 1);
});

test("proactive Discord tool retries once with the same idempotency key", async () => {
  const requests = [];
  const tool = createProactiveDiscordTool({ baseUrl: "https://bridge.example", auth: TOKEN }, async (_url, options) => {
    const request = JSON.parse(options.body);
    requests.push(request);
    if (requests.length === 1) throw new Error("connection dropped after send");
    return new Response(JSON.stringify({
      ok: true,
      kind: "proactive_send",
      requestId: request.requestId,
      destination: request.destination,
      messageId: "1552747341381898294",
    }), { status: 200, headers: { "content-type": "application/json" } });
  });
  assert.equal(await tool.run({ args: { destination: "aidhd.porch", message: "hello" } }),
    "Message sent to aidhd.porch (message_id: 1552747341381898294)");
  assert.equal(requests.length, 2);
  assert.equal(requests[0].requestId, requests[1].requestId);
});

test("proactive Discord tool surfaces only sanitized bridge failures", async () => {
  const tool = createProactiveDiscordTool({ baseUrl: "https://bridge.example", auth: TOKEN }, async () =>
    new Response(JSON.stringify({ error: "send_failed", message: "Unknown proactive destination" }), {
      status: 422,
      headers: { "content-type": "application/json" },
    }));
  assert.deepEqual(await tool.run({ args: { destination: "missing.place", message: "hello" } }), {
    status: "error",
    content: "Unknown proactive destination",
  });
});

test("proactive Discord mod registers only when tool capability and bridge configuration exist", () => {
  const previousBase = process.env.DISCORD_BRIDGE_BASE_URL;
  const previousToken = process.env.DISCORD_BRIDGE_BEARER_TOKEN;
  process.env.DISCORD_BRIDGE_BASE_URL = "https://bridge.example";
  process.env.DISCORD_BRIDGE_BEARER_TOKEN = TOKEN;
  try {
    let registered = null;
    const dispose = proactiveModule.default({
      capabilities: { tools: true },
      tools: {
        register(tool) {
          registered = tool;
          return () => { registered = null; };
        },
      },
      diagnostics: { report() { assert.fail("valid configuration must not emit a diagnostic"); } },
    });
    assert.equal(registered.name, "proactive_discord_send");
    assert.equal(registered.parallelSafe, false);
    dispose();
    assert.equal(registered, null);
    assert.equal(proactiveModule.default({ capabilities: { tools: false } }), undefined);
  } finally {
    if (previousBase === undefined) delete process.env.DISCORD_BRIDGE_BASE_URL;
    else process.env.DISCORD_BRIDGE_BASE_URL = previousBase;
    if (previousToken === undefined) delete process.env.DISCORD_BRIDGE_BEARER_TOKEN;
    else process.env.DISCORD_BRIDGE_BEARER_TOKEN = previousToken;
  }
});
