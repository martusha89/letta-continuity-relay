import test from "node:test";
import assert from "node:assert/strict";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MODULE = pathToFileURL(resolve(ROOT, "deploy", "continuity-listener", "proactive-telegram.ts")).href;
const proactiveModule = await import(`${MODULE}?test=${Date.now()}`);
const { createProactiveTelegramTool, proactiveTelegramConfig } = proactiveModule;
const TOKEN = "123456789:" + "a".repeat(35);
const CHAT_ID = "8591783644";

test("proactive Telegram config accepts only a valid fixed private destination", () => {
  assert.deepEqual(proactiveTelegramConfig({ TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: CHAT_ID }), {
    token: TOKEN,
    chatId: CHAT_ID,
  });
  assert.throws(() => proactiveTelegramConfig({ TELEGRAM_BOT_TOKEN: "bad", TELEGRAM_CHAT_ID: CHAT_ID }),
    /BOT_TOKEN has an invalid format/);
  assert.throws(() => proactiveTelegramConfig({ TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: "not-a-chat" }),
    /numeric private-chat ID/);
});

test("proactive Telegram sends to only the configured chat and verifies its receipt", async () => {
  const calls = [];
  const tool = createProactiveTelegramTool({ token: TOKEN, chatId: CHAT_ID }, async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify({
      ok: true,
      result: { message_id: 8364, chat: { id: Number(CHAT_ID) } },
    }), { status: 200, headers: { "content-type": "application/json; charset=utf-8" } });
  });
  assert.equal(await tool.run({ args: { message: "btw, TSN is lively and I am fine. x" } }),
    "Private Telegram update sent to Marta (message_id: 8364)");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `https://api.telegram.org/bot${TOKEN}/sendMessage`);
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    chat_id: CHAT_ID,
    text: "btw, TSN is lively and I am fine. x",
  });
  assert.deepEqual(Object.keys(tool.parameters.properties), ["message"]);
});

test("proactive Telegram enforces exact runtime arguments and message limits before fetch", async () => {
  let calls = 0;
  const tool = createProactiveTelegramTool({ token: TOKEN, chatId: CHAT_ID }, async () => { calls += 1; });
  for (const args of [
    null,
    [],
    {},
    { message: "" },
    { message: "   " },
    { message: 42 },
    { message: "hi", chat_id: "123" },
    { message: "x".repeat(4097) },
  ]) {
    assert.equal((await tool.run({ args })).status, "error");
  }
  assert.equal(calls, 0);
});

test("proactive Telegram rejects malformed, non-JSON, and mismatched successful receipts", async () => {
  const responses = [
    new Response("not json", { status: 200, headers: { "content-type": "text/plain" } }),
    new Response("{", { status: 200, headers: { "content-type": "application/json" } }),
    new Response(JSON.stringify({ ok: true, result: { message_id: 1, chat: { id: 123 } } }), {
      status: 200, headers: { "content-type": "application/json" },
    }),
    new Response(JSON.stringify({ ok: true, result: { message_id: "1", chat: { id: Number(CHAT_ID) } } }), {
      status: 200, headers: { "content-type": "application/json" },
    }),
  ];
  const tool = createProactiveTelegramTool({ token: TOKEN, chatId: CHAT_ID }, async () => responses.shift());
  for (let index = 0; index < 4; index += 1) {
    assert.deepEqual(await tool.run({ args: { message: "hello" } }), {
      status: "error",
      content: "Proactive Telegram returned an invalid receipt; delivery status is unknown, so do not repeat it automatically",
    });
  }
});

test("proactive Telegram sanitizes HTTP failures and never retries transport ambiguity", async () => {
  let rejectedCalls = 0;
  const rejected = createProactiveTelegramTool({ token: TOKEN, chatId: CHAT_ID }, async () => {
    rejectedCalls += 1;
    return new Response(JSON.stringify({ ok: false, description: `secret ${TOKEN}` }), {
      status: 400, headers: { "content-type": "application/json" },
    });
  });
  assert.deepEqual(await rejected.run({ args: { message: "hello" } }), {
    status: "error",
    content: "Proactive Telegram send was rejected",
  });
  assert.equal(rejectedCalls, 1);

  let ambiguousCalls = 0;
  const ambiguous = createProactiveTelegramTool({ token: TOKEN, chatId: CHAT_ID }, async () => {
    ambiguousCalls += 1;
    throw new Error(`network failed with ${TOKEN}`);
  });
  assert.deepEqual(await ambiguous.run({ args: { message: "hello" } }), {
    status: "error",
    content: "Proactive Telegram send has unknown delivery status; do not repeat it automatically",
  });
  assert.equal(ambiguousCalls, 1, "ambiguous Telegram delivery must never be retried automatically");

  const controller = new AbortController();
  controller.abort();
  let cancelledCalls = 0;
  const cancelled = createProactiveTelegramTool({ token: TOKEN, chatId: CHAT_ID }, async () => {
    cancelledCalls += 1;
    throw new DOMException("aborted", "AbortError");
  });
  assert.deepEqual(await cancelled.run({ args: { message: "hello" }, signal: controller.signal }), {
    status: "error",
    content: "Proactive Telegram send has unknown delivery status; do not repeat it automatically",
  });
  assert.equal(cancelledCalls, 1);
});

test("proactive Telegram mod registers only with tools capability and safe configuration", () => {
  const previousToken = process.env.TELEGRAM_BOT_TOKEN;
  const previousChat = process.env.TELEGRAM_CHAT_ID;
  process.env.TELEGRAM_BOT_TOKEN = TOKEN;
  process.env.TELEGRAM_CHAT_ID = CHAT_ID;
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
      diagnostics: { report() { assert.fail("valid configuration must not emit diagnostics"); } },
    });
    assert.equal(registered.name, "proactive_telegram_send");
    assert.equal(registered.parallelSafe, false);
    dispose();
    assert.equal(registered, null);
    assert.equal(proactiveModule.default({ capabilities: { tools: false } }), undefined);

    process.env.TELEGRAM_BOT_TOKEN = "invalid-secret-value";
    let diagnostic = "";
    assert.equal(proactiveModule.default({
      capabilities: { tools: true },
      diagnostics: { report(value) { diagnostic = value.message; } },
      tools: { register() { assert.fail("invalid config must not register"); } },
    }), undefined);
    assert.match(diagnostic, /Proactive Telegram tool unavailable/);
    assert.equal(diagnostic.includes("invalid-secret-value"), false);
  } finally {
    if (previousToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
    else process.env.TELEGRAM_BOT_TOKEN = previousToken;
    if (previousChat === undefined) delete process.env.TELEGRAM_CHAT_ID;
    else process.env.TELEGRAM_CHAT_ID = previousChat;
  }
});
