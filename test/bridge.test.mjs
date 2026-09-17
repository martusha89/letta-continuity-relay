import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { loadConfig } from "../build/config.js";
import { gateInbound, stripBotMention, toInboundMessage } from "../build/bridge/inbound.js";
import { toMessageView } from "../build/bridge/discord-adapter.js";
import { BoundedIdempotencySet, BridgeEventQueue } from "../build/bridge/queue.js";
import { createBridgeRouter, parseSendAction } from "../build/bridge/router.js";
import { createHttpApp } from "../build/http-app.js";
import { publicBridgeError } from "../build/public-error.js";

const BOT_ID = "999999999999999999";
const GUILD_ID = "111111111111111111";
const CHANNEL_ID = "222222222222222222";
const USER_ID = "333333333333333333";
const OTHER_GUILD = "444444444444444444";
const OTHER_CHANNEL = "555555555555555555";
const BOYS_ROLE_ID = "666666666666666666";

const POLICY = {
  allowedGuildIds: [GUILD_ID],
  allowedChannelIds: [CHANNEL_ID],
  allowedDmUserIds: [],
  allowedMentionUserIds: [],
  allowLocalFiles: false,
  allowedLocalRoots: [],
  remoteMode: true,
};

const BRIDGE = { dmUserIds: [USER_ID], channelIds: [], roleIds: [], allowEveryone: false, queueLimit: 8, pollTimeoutMs: 50, jsonLimitBytes: 4096, rateLimitPerMinute: 1000, enabled: true, bearerToken: "b".repeat(32) };

function view(overrides = {}) {
  return {
    id: "100000000000000001",
    author: { id: USER_ID, username: "alice", bot: false, system: false },
    webhookId: null,
    system: false,
    content: `<@${BOT_ID}> hello`,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    isDM: false,
    dmUserId: null,
    guildId: GUILD_ID,
    guildName: "Test Guild",
    channelId: CHANNEL_ID,
    channelName: "general",
    threadId: null,
    parentChannelId: null,
    mentionsUserIds: [BOT_ID],
    mentionsRoleIds: [],
    mentionsEveryone: false,
    referencedMessageId: null,
    referencedAuthorId: null,
    attachments: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------- config

test("bridge is disabled by default and needs no token", () => {
  const cfg = loadConfig({
    DISCORD_TOKEN: "not-a-real-token",
    MCP_TRANSPORT: "http",
    MCP_HTTP_BEARER_TOKEN: "x".repeat(32),
    MCP_CONFIG_PATH: "/definitely/missing/config.json",
    DISCORD_ALLOWED_GUILD_IDS: GUILD_ID,
  });
  assert.equal(cfg.bridge.enabled, false);
  assert.equal(cfg.bridge.bearerToken, null);
  assert.deepEqual(cfg.bridge.dmUserIds, []);
  assert.deepEqual(cfg.bridge.channelIds, []);
  assert.deepEqual(cfg.bridge.roleIds, []);
  assert.equal(cfg.bridge.allowEveryone, false);
  assert.equal(cfg.bridge.queueLimit, 256);
  assert.equal(cfg.bridge.pollTimeoutMs, 20000);
});

test("enabling the bridge requires a dedicated 32+ char token distinct from the MCP token", () => {
  const base = {
    DISCORD_TOKEN: "not-a-real-token",
    MCP_TRANSPORT: "http",
    MCP_HTTP_BEARER_TOKEN: "x".repeat(32),
    MCP_CONFIG_PATH: "/definitely/missing/config.json",
    DISCORD_ALLOWED_GUILD_IDS: GUILD_ID,
  };
  const cfg = loadConfig({ ...base, DISCORD_BRIDGE_ENABLED: "true", DISCORD_BRIDGE_BEARER_TOKEN: "b".repeat(32) });
  assert.equal(cfg.bridge.enabled, true);
  assert.equal(cfg.bridge.bearerToken, "b".repeat(32));
  assert.notEqual(cfg.bridge.bearerToken, cfg.http.bearerToken);

  assert.throws(() => loadConfig({ ...base, DISCORD_BRIDGE_ENABLED: "true", DISCORD_BRIDGE_BEARER_TOKEN: "short" }),
    /at least 32 characters/);
  assert.throws(() => loadConfig({ ...base, DISCORD_BRIDGE_ENABLED: "true", DISCORD_BRIDGE_BEARER_TOKEN: "x".repeat(32) }),
    /distinct from MCP_HTTP_BEARER_TOKEN/);
  assert.throws(() => loadConfig({
    ...base, DISCORD_BRIDGE_ENABLED: "true", DISCORD_BRIDGE_BEARER_TOKEN: "b".repeat(32),
    DISCORD_ALLOWED_GUILD_IDS: "", DISCORD_ALLOWED_CHANNEL_IDS: "", DISCORD_BRIDGE_DM_USER_IDS: "",
  }), /explicit policy allowlist/);
  assert.throws(() => loadConfig({
    DISCORD_TOKEN: "not-a-real-token",
    MCP_TRANSPORT: "stdio",
    MCP_CONFIG_PATH: "/definitely/missing/config.json",
    DISCORD_BRIDGE_ENABLED: "true",
    DISCORD_BRIDGE_BEARER_TOKEN: "b".repeat(32),
  }), /MCP_TRANSPORT=http/);
});

test("bridge inbound channel, DM, and role allowlists are parsed and deduplicated", () => {
  const cfg = loadConfig({
    DISCORD_TOKEN: "not-a-real-token",
    MCP_TRANSPORT: "http",
    MCP_HTTP_BEARER_TOKEN: "x".repeat(32),
    MCP_CONFIG_PATH: "/definitely/missing/config.json",
    DISCORD_ALLOWED_GUILD_IDS: GUILD_ID,
    DISCORD_BRIDGE_ENABLED: "true",
    DISCORD_BRIDGE_BEARER_TOKEN: "b".repeat(32),
    DISCORD_BRIDGE_DM_USER_IDS: `${USER_ID}, ${USER_ID}`,
    DISCORD_BRIDGE_CHANNEL_IDS: `${CHANNEL_ID}, ${CHANNEL_ID}`,
    DISCORD_BRIDGE_ROLE_IDS: `${BOYS_ROLE_ID}, ${BOYS_ROLE_ID}`,
    DISCORD_BRIDGE_ALLOW_EVERYONE: "true",
  });
  assert.deepEqual(cfg.bridge.dmUserIds, [USER_ID]);
  assert.deepEqual(cfg.bridge.channelIds, [CHANNEL_ID]);
  assert.deepEqual(cfg.bridge.roleIds, [BOYS_ROLE_ID]);
  assert.equal(cfg.bridge.allowEveryone, true);
  assert.throws(() => loadConfig({
    DISCORD_TOKEN: "not-a-real-token",
    MCP_CONFIG_PATH: "/definitely/missing/config.json",
    DISCORD_BRIDGE_DM_USER_IDS: "not-a-snowflake",
  }), /Discord snowflakes/);
  assert.throws(() => loadConfig({
    DISCORD_TOKEN: "not-a-real-token",
    MCP_CONFIG_PATH: "/definitely/missing/config.json",
    DISCORD_BRIDGE_CHANNEL_IDS: "not-a-snowflake",
  }), /Discord snowflakes/);
  assert.throws(() => loadConfig({
    DISCORD_TOKEN: "not-a-real-token",
    MCP_CONFIG_PATH: "/definitely/missing/config.json",
    DISCORD_BRIDGE_ROLE_IDS: "not-a-snowflake",
  }), /Discord snowflakes/);
  assert.throws(() => loadConfig({
    DISCORD_TOKEN: "not-a-real-token",
    MCP_CONFIG_PATH: "/definitely/missing/config.json",
    DISCORD_BRIDGE_ALLOW_EVERYONE: "sometimes",
  }), /must be true or false/);
});

// ------------------------------------------------- mention stripping / mapping

test("stripBotMention removes a leading bot mention and detects mid-text mentions", () => {
  assert.deepEqual(stripBotMention(`<@${BOT_ID}> hello`, BOT_ID), { text: "hello", mentioned: true });
  assert.deepEqual(stripBotMention(`   <@!${BOT_ID}> hello`, BOT_ID), { text: "hello", mentioned: true });
  assert.deepEqual(stripBotMention(`hey <@${BOT_ID}> there`, BOT_ID), { text: `hey <@${BOT_ID}> there`, mentioned: true });
  assert.deepEqual(stripBotMention("no mention", BOT_ID), { text: "no mention", mentioned: false });
  assert.deepEqual(stripBotMention("anything", ""), { text: "anything", mentioned: false });
});

test("toInboundMessage produces the full InboundChannelMessage-shaped payload", () => {
  const message = toInboundMessage(view({
    threadId: "666666666666666666",
    parentChannelId: CHANNEL_ID,
    attachments: [{ id: "a1", name: "cat.png", contentType: "image/png", size: 12, url: "https://cdn.example.test/cat.png" }],
  }), BOT_ID);
  assert.equal(message.account, "discord");
  assert.equal(message.channel, "666666666666666666");
  assert.equal(message.chatType, "channel");
  assert.equal(message.guildId, GUILD_ID);
  assert.equal(message.guildName, "Test Guild");
  assert.equal(message.channelId, CHANNEL_ID);
  assert.equal(message.channelName, "general");
  assert.equal(message.threadId, "666666666666666666");
  assert.equal(message.parentChannelId, CHANNEL_ID);
  assert.equal(message.authorId, USER_ID);
  assert.equal(message.authorName, "alice");
  assert.equal(message.messageId, "100000000000000001");
  assert.equal(message.timestamp, "2026-01-01T00:00:00.000Z");
  assert.equal(message.text, "hello");
  assert.equal(message.isMention, true);
  assert.deepEqual(message.attachments, [{ id: "a1", name: "cat.png", contentType: "image/png", size: 12, url: "https://cdn.example.test/cat.png" }]);
});

test("toInboundMessage maps DMs to the user channel with chatType direct", () => {
  const message = toInboundMessage(view({
    isDM: true, dmUserId: USER_ID, guildId: null, guildName: null,
    channelId: "777777777777777777", channelName: null, content: "hi bot",
    mentionsUserIds: [],
  }), BOT_ID);
  assert.equal(message.chatType, "direct");
  assert.equal(message.channel, USER_ID);
  assert.equal(message.guildId, null);
  assert.equal(message.text, "hi bot");
  assert.equal(message.isMention, false);
});

test("toMessageView extracts discord.js role and everyone mention metadata", () => {
  const mapped = toMessageView({
    id: "100000000000000002",
    author: { id: USER_ID, username: "alice", bot: false, system: false },
    webhookId: null,
    system: false,
    content: `<@&${BOYS_ROLE_ID}> @everyone hello`,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    guild: { name: "Test Guild" },
    guildId: GUILD_ID,
    channelId: CHANNEL_ID,
    channel: { name: "general", isThread: () => false },
    mentions: {
      users: new Map(),
      roles: new Map([[BOYS_ROLE_ID, { id: BOYS_ROLE_ID }]]),
      everyone: true,
      repliedUser: null,
    },
    reference: null,
    attachments: [],
  });
  assert.deepEqual(mapped.mentionsUserIds, []);
  assert.deepEqual(mapped.mentionsRoleIds, [BOYS_ROLE_ID]);
  assert.equal(mapped.mentionsEveryone, true);
});

// ------------------------------------------------------------- gating

test("gateInbound delivers a mention in an allowed guild channel", () => {
  const result = gateInbound(view(), POLICY, BRIDGE, BOT_ID);
  assert.equal(result.verdict, "deliver");
  assert.equal(result.message.text, "hello");
});

test("gateInbound delivers a reply-to-bot without an explicit mention", () => {
  const result = gateInbound(view({
    content: "sure thing", mentionsUserIds: [],
    referencedMessageId: "123", referencedAuthorId: BOT_ID,
  }), POLICY, BRIDGE, BOT_ID);
  assert.equal(result.verdict, "deliver");
  assert.equal(result.message.text, "sure thing");
  assert.equal(result.message.isMention, false);
});

test("gateInbound delivers only explicitly allowed role mentions", () => {
  const allowed = gateInbound(view({
    content: `<@&${BOYS_ROLE_ID}> morning`, mentionsUserIds: [], mentionsRoleIds: [BOYS_ROLE_ID],
  }), POLICY, { ...BRIDGE, roleIds: [BOYS_ROLE_ID] }, BOT_ID);
  assert.equal(allowed.verdict, "deliver");
  assert.equal(allowed.message.text, "morning");
  assert.equal(allowed.message.isMention, true);

  const denied = gateInbound(view({
    content: `<@&${BOYS_ROLE_ID}> morning`, mentionsUserIds: [], mentionsRoleIds: [BOYS_ROLE_ID],
  }), POLICY, BRIDGE, BOT_ID);
  assert.equal(denied.verdict, "ignore");
  assert.equal(denied.reason, "not_addressed_to_bot");
});

test("gateInbound delivers @everyone and @here only when explicitly enabled", () => {
  for (const mention of ["@everyone", "@here"]) {
    const allowed = gateInbound(view({
      content: `${mention} announcement`, mentionsUserIds: [], mentionsEveryone: true,
    }), POLICY, { ...BRIDGE, allowEveryone: true }, BOT_ID);
    assert.equal(allowed.verdict, "deliver");
    assert.equal(allowed.message.text, "announcement");
    assert.equal(allowed.message.isMention, true);

    const denied = gateInbound(view({
      content: `${mention} announcement`, mentionsUserIds: [], mentionsEveryone: true,
    }), POLICY, BRIDGE, BOT_ID);
    assert.equal(denied.verdict, "ignore");
    assert.equal(denied.reason, "not_addressed_to_bot");
  }
});

test("allowed mixed addressing tokens are stripped only when leading", () => {
  const bridge = { ...BRIDGE, roleIds: [BOYS_ROLE_ID], allowEveryone: true };
  const leading = gateInbound(view({
    content: `  <@&${BOYS_ROLE_ID}> @everyone <@${BOT_ID}> morning`,
    mentionsUserIds: [BOT_ID], mentionsRoleIds: [BOYS_ROLE_ID], mentionsEveryone: true,
  }), POLICY, bridge, BOT_ID);
  assert.equal(leading.verdict, "deliver");
  assert.equal(leading.message.text, "morning");

  const embedded = gateInbound(view({
    content: `morning <@&${BOYS_ROLE_ID}>`, mentionsUserIds: [], mentionsRoleIds: [BOYS_ROLE_ID],
  }), POLICY, bridge, BOT_ID);
  assert.equal(embedded.verdict, "deliver");
  assert.equal(embedded.message.text, `morning <@&${BOYS_ROLE_ID}>`);
});

test("gateInbound does not treat a reply to another bot as addressed to the relay bot", () => {
  const result = gateInbound(view({
    content: "replying elsewhere", mentionsUserIds: [],
    referencedMessageId: "123", referencedAuthorId: "777777777777777777",
  }), POLICY, BRIDGE, BOT_ID);
  assert.equal(result.verdict, "ignore");
  assert.equal(result.reason, "not_addressed_to_bot");
});

test("gateInbound ignores bot, webhook, system, and missing authors", () => {
  assert.equal(gateInbound(view({ author: { id: "1", username: "b", bot: true } }), POLICY, BRIDGE, BOT_ID).reason, "bot_author");
  assert.equal(gateInbound(view({ webhookId: "123" }), POLICY, BRIDGE, BOT_ID).reason, "webhook_author");
  assert.equal(gateInbound(view({ system: true }), POLICY, BRIDGE, BOT_ID).reason, "system_author");
  assert.equal(gateInbound(view({ author: null }), POLICY, BRIDGE, BOT_ID).reason, "system_author");
});

test("gateInbound enforces guild and channel policy", () => {
  assert.equal(gateInbound(view({ guildId: OTHER_GUILD }), POLICY, BRIDGE, BOT_ID).reason, "guild_not_allowed");
  assert.equal(gateInbound(view({ channelId: OTHER_CHANNEL }), POLICY, BRIDGE, BOT_ID).reason, "channel_not_allowed");
  // Thread whose parent is allowed still passes channel policy.
  const thread = gateInbound(view({ threadId: "666666666666666666", parentChannelId: CHANNEL_ID }), POLICY, BRIDGE, BOT_ID);
  assert.equal(thread.verdict, "deliver");
  // No channel allowlist -> guild allowlist alone governs.
  const openPolicy = { ...POLICY, allowedChannelIds: [] };
  assert.equal(gateInbound(view({ channelId: OTHER_CHANNEL }), openPolicy, BRIDGE, BOT_ID).verdict, "deliver");
  // An inbound-only bridge fence can be narrower than the shared MCP policy.
  const bridgeLimited = { ...BRIDGE, channelIds: [CHANNEL_ID] };
  assert.equal(gateInbound(view(), openPolicy, bridgeLimited, BOT_ID).verdict, "deliver");
  assert.equal(gateInbound(view({ channelId: OTHER_CHANNEL }), openPolicy, bridgeLimited, BOT_ID).reason, "channel_not_allowed");
});

test("gateInbound drops unaddressed messages (no firehose)", () => {
  const result = gateInbound(view({ content: "just chatting", mentionsUserIds: [] }), POLICY, BRIDGE, BOT_ID);
  assert.equal(result.verdict, "ignore");
  assert.equal(result.reason, "not_addressed_to_bot");
});

test("DMs are deny-by-default and require the separate bridge allowlist", () => {
  const dm = (userId) => view({
    isDM: true, dmUserId: userId, author: { id: userId, username: "u", bot: false, system: false },
    guildId: null, guildName: null, channelId: "777777777777777777", channelName: null,
    content: "hello", mentionsUserIds: [],
  });
  assert.equal(gateInbound(dm(USER_ID), POLICY, BRIDGE, BOT_ID).verdict, "deliver");
  assert.equal(gateInbound(dm("888888888888888888"), POLICY, BRIDGE, BOT_ID).reason, "dm_not_allowed");
  // Even with an empty bridge DM allowlist, allowed DMs stay denied.
  assert.equal(gateInbound(dm(USER_ID), POLICY, { ...BRIDGE, dmUserIds: [] }, BOT_ID).reason, "dm_not_allowed");
  // The outbound DM policy allowlist does NOT open the bridge.
  const dmPolicy = { ...POLICY, allowedDmUserIds: [USER_ID] };
  assert.equal(gateInbound(dm(USER_ID), dmPolicy, { ...BRIDGE, dmUserIds: [] }, BOT_ID).reason, "dm_not_allowed");
});

// --------------------------------------------------------- idempotency

test("BoundedIdempotencySet drops duplicates and evicts oldest beyond capacity", () => {
  const set = new BoundedIdempotencySet(3);
  assert.equal(set.add("a"), true);
  assert.equal(set.add("a"), false);
  assert.equal(set.add("b"), true);
  assert.equal(set.add("c"), true);
  assert.equal(set.size, 3);
  assert.equal(set.add("d"), true); // evicts "a"
  assert.equal(set.has("a"), false);
  assert.equal(set.add("a"), true); // "a" is new again after eviction
  assert.throws(() => new BoundedIdempotencySet(0), /positive integer/);
});

// ------------------------------------------------------- queue / ack / long-poll

test("queue assigns monotonic sequence IDs and ack removes in order", () => {
  const queue = new BridgeEventQueue(4);
  const e1 = queue.enqueue({ messageId: "1" });
  const e2 = queue.enqueue({ messageId: "2" });
  assert.equal(e1.seq, 1);
  assert.equal(e2.seq, 2);
  assert.equal(queue.lastSeq, 2);
  assert.deepEqual(queue.since(0).map(e => e.seq), [1, 2]);
  assert.deepEqual(queue.since(1).map(e => e.seq), [2]);

  assert.equal(queue.ack(1), 1);
  assert.deepEqual(queue.since(0).map(e => e.seq), [2]);
  assert.equal(queue.ack(1), 0); // idempotent
  assert.equal(queue.ack(-1), 0); // invalid: no-op
  assert.equal(queue.ack(2), 1);
  assert.equal(queue.size, 0);
  assert.equal(queue.lastSeq, 2); // sequence never rewinds
});

test("ack of a future sequence removes everything currently queued", () => {
  const queue = new BridgeEventQueue(4);
  queue.enqueue({ messageId: "1" });
  queue.enqueue({ messageId: "2" });
  assert.equal(queue.ack(999), 2);
  assert.equal(queue.size, 0);
  // The router rejects seq > lastSeq, so this path is queue-internal only.
});

test("queue fails closed when full: newest dropped, counted, oldest kept", () => {
  const queue = new BridgeEventQueue(2);
  queue.enqueue({ messageId: "1" });
  queue.enqueue({ messageId: "2" });
  const rejected = queue.enqueue({ messageId: "3" });
  assert.equal(rejected, null);
  assert.equal(queue.dropped, 1);
  assert.deepEqual(queue.since(0).map(e => e.message.messageId), ["1", "2"]);
  assert.throws(() => new BridgeEventQueue(0), /positive integer/);
});

test("long-poll resolves immediately when events exist and times out otherwise", async () => {
  const queue = new BridgeEventQueue(4);
  queue.enqueue({ messageId: "1" });
  assert.equal((await queue.waitSince(0, 50)).length, 1);
  assert.equal((await queue.waitSince(1, 10)).length, 0); // timeout, empty
  assert.equal((await queue.waitSince(1, 0)).length, 0);  // zero timeout: no wait
});

test("long-poll wakes when an event arrives while waiting", async () => {
  const queue = new BridgeEventQueue(4);
  const waiting = queue.waitSince(0, 2000);
  await new Promise(resolve => setTimeout(resolve, 10));
  queue.enqueue({ messageId: "1" });
  const events = await waiting;
  assert.equal(events.length, 1);
  assert.ok(events[0].seq >= 1);
});

// ------------------------------------------------------- send action validation

test("parseSendAction validates send, react, and typing shapes and rejects everything else", () => {
  assert.deepEqual(parseSendAction({ kind: "send", channel: CHANNEL_ID, text: "hi" }),
    { kind: "send", channel: CHANNEL_ID, text: "hi" });
  assert.deepEqual(parseSendAction({ kind: "send", channel: CHANNEL_ID, text: "hi", replyToMessageId: "100000000000000001" }),
    { kind: "send", channel: CHANNEL_ID, text: "hi", replyToMessageId: "100000000000000001" });
  assert.deepEqual(parseSendAction({ kind: "react", channel: CHANNEL_ID, messageId: "100000000000000001", emoji: "👍" }),
    { kind: "react", channel: CHANNEL_ID, messageId: "100000000000000001", emoji: "👍" });
  assert.deepEqual(parseSendAction({ kind: "typing", channel: CHANNEL_ID }),
    { kind: "typing", channel: CHANNEL_ID });

  assert.equal(parseSendAction({ kind: "send", channel: "not-a-snowflake", text: "hi" }), null);
  assert.equal(parseSendAction({ kind: "send", channel: CHANNEL_ID, text: "" }), null);
  assert.equal(parseSendAction({ kind: "send", channel: CHANNEL_ID }), null);
  assert.equal(parseSendAction({ kind: "send", channel: CHANNEL_ID, text: "hi", replyToMessageId: "junk" }), null);
  assert.equal(parseSendAction({ kind: "react", channel: CHANNEL_ID, messageId: "100000000000000001", emoji: "" }), null);
  assert.equal(parseSendAction({ kind: "react", channel: CHANNEL_ID, messageId: "x".repeat(65) }), null);
  assert.equal(parseSendAction({ kind: "typing", channel: "not-a-snowflake" }), null);
  assert.equal(parseSendAction({ kind: "upload", channel: CHANNEL_ID }), null);
  assert.equal(parseSendAction({}), null);
  assert.equal(parseSendAction("nope"), null);
});

// ------------------------------------------------------------- HTTP endpoints

function makeApp(overrides = {}) {
  const queue = overrides.queue ?? new BridgeEventQueue(16);
  const calls = [];
  const sendHandlers = {
    send: async action => { calls.push(action); return { messageId: "900000000000000001", channelId: action.channel }; },
    react: async action => { calls.push(action); },
    typing: async action => { calls.push(action); },
    ...(overrides.sendHandlers ?? {}),
  };
  const app = createHttpApp({
    allowedOrigins: [],
    bearerToken: "x".repeat(32),
    jsonLimitBytes: 4096,
    rateLimitPerMinute: 1000,
    isReady: () => true,
    handleMcpPost: async (_req, res) => res.status(200).json({}),
    bridgeRouter: createBridgeRouter({
      bridge: { ...BRIDGE, ...(overrides.bridge ?? {}) },
      queue,
      sendHandlers,
      log: () => {},
    }),
    logError: () => {},
  });
  return { app, queue, calls };
}

async function withServer(setup, callback) {
  const { app, queue, calls } = makeApp(setup);
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  try {
    await callback(`http://127.0.0.1:${address.port}`, queue, calls);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

const AUTH = { Authorization: `Bearer ${BRIDGE.bearerToken}` };
const MCP_AUTH = { Authorization: "Bearer " + "x".repeat(32) };

test("bridge endpoints are absent when the router is not mounted (disabled by default)", async () => {
  const app = createHttpApp({
    allowedOrigins: [],
    bearerToken: "x".repeat(32),
    jsonLimitBytes: 1024,
    rateLimitPerMinute: 100,
    isReady: () => true,
    handleMcpPost: async (_req, res) => res.status(200).json({}),
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const response = await fetch(`${base}/bridge/events`, { headers: AUTH });
    assert.equal(response.status, 404);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test("bridge endpoints require the dedicated bearer token, not the MCP token", async () => {
  await withServer({}, async base => {
    assert.equal((await fetch(`${base}/bridge/events`)).status, 401);
    assert.equal((await fetch(`${base}/bridge/events`, { headers: MCP_AUTH })).status, 401);
    assert.equal((await fetch(`${base}/bridge/ack`, { method: "POST", headers: MCP_AUTH, "Content-Type": "application/json", body: "{}" })).status, 401);
    const ok = await fetch(`${base}/bridge/events`, { headers: AUTH });
    assert.equal(ok.status, 200);
    // No CORS headers for bridge endpoints.
    assert.equal(ok.headers.get("access-control-allow-origin"), null);
  });
});

test("GET /bridge/events returns queued events after a sequence and validates after", async () => {
  await withServer({}, async (base, queue) => {
    queue.enqueue({ messageId: "1" });
    queue.enqueue({ messageId: "2" });
    const response = await fetch(`${base}/bridge/events?after=1`, { headers: AUTH });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.deepEqual(body.events.map(e => e.message.messageId), ["2"]);
    assert.equal(body.lastSeq, 2);

    assert.equal((await fetch(`${base}/bridge/events?after=abc`, { headers: AUTH })).status, 400);
    assert.equal((await fetch(`${base}/bridge/events?after=-1`, { headers: AUTH })).status, 400);
  });
});

test("GET /bridge/events resets a stale listener cursor after service restart", async () => {
  await withServer({}, async (base, queue) => {
    queue.enqueue({ messageId: "1" });
    const response = await fetch(`${base}/bridge/events?after=99`, { headers: AUTH });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.reset, true);
    assert.equal(body.lastSeq, 1);
    assert.deepEqual(body.events.map(e => e.message.messageId), ["1"]);
    assert.equal(queue.size, 1, "reset must not acknowledge or drop queued events");
  });
});

test("GET /bridge/events long-polls until an event arrives or the timeout elapses", async () => {
  await withServer({ bridge: { pollTimeoutMs: 120 } }, async (base, queue) => {
    const started = Date.now();
    const pending = fetch(`${base}/bridge/events?after=0&wait=1`, { headers: AUTH });
    setTimeout(() => queue.enqueue({ messageId: "1" }), 30);
    const response = await pending;
    const body = await response.json();
    assert.equal(body.events.length, 1);
    assert.ok(Date.now() - started < 110, "long-poll resolved early via timeout instead of wakeup");

    const t0 = Date.now();
    const empty = await (await fetch(`${base}/bridge/events?after=1&wait=1`, { headers: AUTH })).json();
    assert.deepEqual(empty.events, []);
    assert.ok(Date.now() - t0 >= 100, "timeout long-poll returned too early");
  });
});

test("POST /bridge/ack acknowledges ordered sequences and rejects invalid bodies", async () => {
  await withServer({}, async (base, queue) => {
    queue.enqueue({ messageId: "1" });
    queue.enqueue({ messageId: "2" });
    const ack = await (await fetch(`${base}/bridge/ack`, {
      method: "POST", headers: { ...AUTH, "Content-Type": "application/json" }, body: JSON.stringify({ seq: 1 }),
    })).json();
    assert.equal(ack.removed, 1);
    assert.equal(ack.lastSeq, 2);
    assert.equal(queue.size, 1);

    for (const bad of ["[]", "null", '{"seq":"1"}', '{"seq":-1}', '{"seq":1.5}', '{"seq":99}', "{}"]) {
      const response = await fetch(`${base}/bridge/ack`, {
        method: "POST", headers: { ...AUTH, "Content-Type": "application/json" }, body: bad,
      });
      assert.equal(response.status, 400, `body ${bad} should be rejected`);
    }
  });
});

test("POST /bridge/send routes send, react, and typing through the send handlers", async () => {
  await withServer({}, async (base, _queue, calls) => {
    const send = await fetch(`${base}/bridge/send`, {
      method: "POST", headers: { ...AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "send", channel: CHANNEL_ID, text: "hi", replyToMessageId: "100000000000000001" }),
    });
    assert.equal(send.status, 200);
    assert.deepEqual(await send.json(), { ok: true, kind: "send", messageId: "900000000000000001", channelId: CHANNEL_ID });

    const react = await fetch(`${base}/bridge/send`, {
      method: "POST", headers: { ...AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "react", channel: CHANNEL_ID, messageId: "100000000000000001", emoji: "👍" }),
    });
    assert.equal(react.status, 200);
    assert.deepEqual(await react.json(), { ok: true, kind: "react" });

    const typing = await fetch(`${base}/bridge/send`, {
      method: "POST", headers: { ...AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "typing", channel: CHANNEL_ID }),
    });
    assert.equal(typing.status, 200);
    assert.deepEqual(await typing.json(), { ok: true, kind: "typing" });
    assert.equal(calls.length, 3);
  });
});

test("POST /bridge/send rejects invalid actions and sanitizes handler failures", async () => {
  const policyError = new Error("Discord target is not allowed by policy");
  policyError.name = "PolicyError";
  await withServer({ sendHandlers: { send: async () => { throw policyError; } } }, async base => {
    const invalid = await fetch(`${base}/bridge/send`, {
      method: "POST", headers: { ...AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "send", channel: "nope", text: "hi" }),
    });
    assert.equal(invalid.status, 400);

    const failure = await fetch(`${base}/bridge/send`, {
      method: "POST", headers: { ...AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "send", channel: CHANNEL_ID, text: "secret user content" }),
    });
    assert.equal(failure.status, 422);
    const body = await failure.json();
    assert.equal(body.error, "send_failed");
    assert.equal(body.message, "Discord target is not allowed by policy");

    // Non-policy internal errors are fully masked.
    const leaky = new Error("token=abc123 user text leaked");
    await withServer({ sendHandlers: { send: async () => { throw leaky; } } }, async base2 => {
      const masked = await fetch(`${base2}/bridge/send`, {
        method: "POST", headers: { ...AUTH, "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "send", channel: CHANNEL_ID, text: "x" }),
      });
      const maskedBody = await masked.json();
      assert.equal(maskedBody.message, "Discord operation failed");
    });
  });
});

test("bridge endpoints enforce JSON media type and body size limit", async () => {
  await withServer({ bridge: { jsonLimitBytes: 256 } }, async base => {
    const wrongType = await fetch(`${base}/bridge/send`, {
      method: "POST", headers: { ...AUTH, "Content-Type": "text/plain" }, body: "hello",
    });
    assert.equal(wrongType.status, 415);

    const tooBig = await fetch(`${base}/bridge/send`, {
      method: "POST", headers: { ...AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "send", channel: CHANNEL_ID, text: "y".repeat(512) }),
    });
    assert.equal(tooBig.status, 400);
    const body = await tooBig.json();
    assert.deepEqual(body, { error: "invalid_request" });
  });
});

test("bridge endpoints are rate limited independently", async () => {
  await withServer({ bridge: { rateLimitPerMinute: 2 } }, async base => {
    assert.equal((await fetch(`${base}/bridge/events`, { headers: AUTH })).status, 200);
    assert.equal((await fetch(`${base}/bridge/events`, { headers: AUTH })).status, 200);
    const limited = await fetch(`${base}/bridge/events`, { headers: AUTH });
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get("retry-after")) >= 1);
  });
});

test("health and ready remain unchanged with the bridge mounted", async () => {
  const { app } = makeApp({});
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(`${base}/health`)).status, 200);
    const ready = await fetch(`${base}/ready`);
    assert.equal(ready.status, 200); // isReady() stub, not listener state
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

// --------------------------------------------------------- error sanitization

test("publicBridgeError exposes only policy and exact allowlisted failures", () => {
  const policyError = new Error("DM recipient is not allowed by policy");
  policyError.name = "PolicyError";
  assert.equal(publicBridgeError(policyError), "DM recipient is not allowed by policy");
  assert.equal(publicBridgeError(new Error("Channel not found or not allowed")), "Channel not found or not allowed");
  assert.equal(publicBridgeError(new Error("Message exceeds configured 2000 character limit")), "Message exceeds configured 2000 character limit");
  assert.equal(publicBridgeError(new Error("invalid request containing secret=abc")), "Discord operation failed");
  assert.equal(publicBridgeError(new Error("raw internals: DISCORD_TOKEN=abc")), "Discord operation failed");
  assert.equal(publicBridgeError("not an error"), "Request failed");
  assert.equal(publicBridgeError(null), "Request failed");
});
