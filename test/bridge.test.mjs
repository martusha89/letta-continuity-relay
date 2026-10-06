import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { loadConfig } from "../build/config.js";
import { gateInbound, stripBotMention, toInboundMessage } from "../build/bridge/inbound.js";
import { createInboundPipeline, toMessageView } from "../build/bridge/discord-adapter.js";
import { BoundedIdempotencySet, BridgeEventQueue } from "../build/bridge/queue.js";
import { createBridgeRouter, parseSendAction } from "../build/bridge/router.js";
import { createBridgeSendHandlers } from "../build/bridge/runtime.js";
import { parseProactiveDestinations, normalizeDestinationAlias } from "../build/config.js";
import { resolveProactiveTarget, verifyProactiveDestinations, composeMentionTokens } from "../build/discord/destinations.js";
import { buildMessagePayload } from "../build/discord/messages.js";
import { assertMentionRolesAllowed, assertMentionUsersAllowed } from "../build/discord/policy.js";
import { createHttpApp } from "../build/http-app.js";
import { publicBridgeError } from "../build/public-error.js";

const BOT_ID = "999999999999999999";
const GUILD_ID = "111111111111111111";
const CHANNEL_ID = "222222222222222222";
const USER_ID = "333333333333333333";
const OTHER_GUILD = "444444444444444444";
const OTHER_CHANNEL = "555555555555555555";
const BOYS_ROLE_ID = "666666666666666666";
const COMPANION_BOT_ID = "777777777777777777";
const REQUEST_ID = "11111111-1111-4111-8111-111111111111";

const POLICY = {
  allowedGuildIds: [GUILD_ID],
  allowedChannelIds: [CHANNEL_ID],
  allowedDmUserIds: [],
  allowedMentionUserIds: [],
  allowLocalFiles: false,
  allowedLocalRoots: [],
  remoteMode: true,
};

const BRIDGE = { dmUserIds: [USER_ID], channelIds: [], roleIds: [], botCooldownMs: 30000, allowEveryone: false, queueLimit: 8, pollTimeoutMs: 50, jsonLimitBytes: 4096, rateLimitPerMinute: 1000, enabled: true, bearerToken: "b".repeat(32) };

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
  assert.equal(cfg.bridge.botCooldownMs, 30000);
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

test("bridge inbound channel, DM, role, and bot cooldown policies are parsed and deduplicated", () => {
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
    DISCORD_BRIDGE_BOT_COOLDOWN_MS: "45000",
    DISCORD_BRIDGE_ALLOW_EVERYONE: "true",
  });
  assert.deepEqual(cfg.bridge.dmUserIds, [USER_ID]);
  assert.deepEqual(cfg.bridge.channelIds, [CHANNEL_ID]);
  assert.deepEqual(cfg.bridge.roleIds, [BOYS_ROLE_ID]);
  assert.equal(cfg.bridge.botCooldownMs, 45000);
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
  assert.equal(message.authorIsBot, false);
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

test("gateInbound ignores self-bot, webhook, system, and missing authors", () => {
  assert.equal(gateInbound(view({ author: { id: BOT_ID, username: "self", bot: true } }), POLICY, BRIDGE, BOT_ID).reason, "bot_author");
  assert.equal(gateInbound(view({ webhookId: "123" }), POLICY, BRIDGE, BOT_ID).reason, "webhook_author");
  assert.equal(gateInbound(view({ system: true }), POLICY, BRIDGE, BOT_ID).reason, "system_author");
  assert.equal(gateInbound(view({ author: null }), POLICY, BRIDGE, BOT_ID).reason, "system_author");
});

test("bots in permitted channels require a direct relay-bot mention", () => {
  const trusted = { id: COMPANION_BOT_ID, username: "companion", bot: true, system: false };
  const directMention = gateInbound(view({
    author: trusted,
    content: `<@${BOT_ID}> hello back`,
    mentionsUserIds: [BOT_ID],
    referencedMessageId: "123",
    referencedAuthorId: BOT_ID,
  }), POLICY, BRIDGE, BOT_ID);
  assert.equal(directMention.verdict, "deliver");
  assert.equal(directMention.message.text, "hello back");
  assert.equal(directMention.message.authorIsBot, true);

  assert.equal(gateInbound(view({
    author: trusted,
    content: "reply without a direct mention",
    mentionsUserIds: [],
    referencedMessageId: "123",
    referencedAuthorId: BOT_ID,
  }), POLICY, BRIDGE, BOT_ID).reason, "bot_direct_mention_required");
  assert.equal(gateInbound(view({
    author: trusted,
    content: `<@&${BOYS_ROLE_ID}> role ping`,
    mentionsUserIds: [],
    mentionsRoleIds: [BOYS_ROLE_ID],
  }), POLICY, { ...BRIDGE, roleIds: [BOYS_ROLE_ID] }, BOT_ID).reason, "bot_direct_mention_required");
  assert.equal(gateInbound(view({
    author: trusted,
    content: "@everyone announcement",
    mentionsUserIds: [],
    mentionsEveryone: true,
  }), POLICY, { ...BRIDGE, allowEveryone: true }, BOT_ID).reason, "bot_direct_mention_required");
  assert.equal(gateInbound(view({
    author: trusted,
    content: "ambient bot chatter",
    mentionsUserIds: [],
  }), POLICY, BRIDGE, BOT_ID).reason, "bot_direct_mention_required");
  assert.equal(gateInbound(view({
    author: { id: "888888888888888888", username: "another companion", bot: true, system: false },
  }), POLICY, BRIDGE, BOT_ID).verdict, "deliver");
  assert.equal(gateInbound(view({
    author: { id: BOT_ID, username: "self", bot: true, system: false },
  }), POLICY, BRIDGE, BOT_ID).reason, "bot_author");
});

test("bots inherit permitted thread-parent access but cannot cross channel policy", () => {
  const thread = "666666666666666666";
  const trusted = { id: COMPANION_BOT_ID, username: "companion", bot: true, system: false };
  const inherited = gateInbound(view({
    author: trusted,
    channelId: thread,
    threadId: thread,
    parentChannelId: CHANNEL_ID,
  }), POLICY, BRIDGE, BOT_ID);
  assert.equal(inherited.verdict, "deliver");
  assert.equal(gateInbound(view({
    author: trusted,
    channelId: OTHER_CHANNEL,
    threadId: null,
    parentChannelId: null,
  }), POLICY, BRIDGE, BOT_ID).reason, "channel_not_allowed");
});

test("companion bots never bypass guild, DM, webhook, or system boundaries", () => {
  const trusted = { id: COMPANION_BOT_ID, username: "companion", bot: true, system: false };
  assert.equal(gateInbound(view({ author: trusted, guildId: OTHER_GUILD }), POLICY, BRIDGE, BOT_ID).reason, "guild_not_allowed");
  assert.equal(gateInbound(view({
    author: trusted,
    isDM: true,
    dmUserId: COMPANION_BOT_ID,
    guildId: null,
    guildName: null,
    channelId: "777777777777777777",
  }), POLICY, BRIDGE, BOT_ID).reason, "bot_author");
  assert.equal(gateInbound(view({ author: trusted, webhookId: "777777777777777777" }), POLICY, BRIDGE, BOT_ID).reason, "webhook_author");
  assert.equal(gateInbound(view({ author: trusted, system: true }), POLICY, BRIDGE, BOT_ID).reason, "system_author");
});

test("inbound pipeline applies a bounded per-bot/per-channel cooldown after acceptance", async () => {
  let messageHandler;
  const logs = [];
  const secondBot = "888888888888888888";
  const bridge = {
    ...BRIDGE,
    botCooldownMs: 60_000,
  };
  const pipeline = createInboundPipeline({
    policy: { ...POLICY, allowedChannelIds: [] },
    bridge,
    botUserId: () => BOT_ID,
    log: line => logs.push(line),
  });
  pipeline.attach({ on(eventName, handler) { assert.equal(eventName, "messageCreate"); messageHandler = handler; } });
  const discordMessage = (id, channelId = CHANNEL_ID, authorId = COMPANION_BOT_ID) => ({
    id,
    author: { id: authorId, username: "companion", bot: true, system: false },
    webhookId: null,
    system: false,
    content: `<@${BOT_ID}> hello`,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    guild: { name: "Test Guild" },
    guildId: GUILD_ID,
    channelId,
    channel: { name: "general", isThread: () => false },
    mentions: {
      users: new Map([[BOT_ID, { id: BOT_ID }]]),
      roles: new Map(),
      everyone: false,
      repliedUser: null,
    },
    reference: null,
    attachments: [],
  });
  messageHandler(discordMessage("100000000000000010"));
  messageHandler(discordMessage("100000000000000011"));
  messageHandler(discordMessage("100000000000000012", OTHER_CHANNEL));
  messageHandler(discordMessage("100000000000000013", CHANNEL_ID, secondBot));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(pipeline.queue.size, 3);
  assert.equal(pipeline.queue.since(0)[0].message.authorIsBot, true);
  assert.ok(logs.includes("[bridge] inbound ignored: bot_cooldown"));
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

test("queue can acknowledge one later event while retaining an older stalled event", () => {
  const queue = new BridgeEventQueue(4);
  queue.enqueue({ messageId: "1" });
  queue.enqueue({ messageId: "2" });
  assert.equal(queue.ackOne(2), 1);
  assert.deepEqual(queue.since(0).map(event => event.seq), [1]);
  assert.equal(queue.ackOne(2), 0);
  assert.equal(queue.ackOne(-1), 0);
});

test("exact acknowledgement cannot remove a reused sequence with a different message ID", () => {
  const queue = new BridgeEventQueue(4);
  queue.enqueue({ messageId: "current-generation" });
  assert.equal(queue.ackOne(1, "previous-generation"), 0);
  assert.deepEqual(queue.since(0).map(event => event.message.messageId), ["current-generation"]);
  assert.equal(queue.ackOne(1, "current-generation"), 1);
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

test("parseSendAction validates channel, DM, reaction, and typing shapes", () => {
  assert.deepEqual(parseSendAction({ kind: "send", channel: CHANNEL_ID, text: "hi" }),
    { kind: "send", channel: CHANNEL_ID, text: "hi" });
  assert.deepEqual(parseSendAction({ kind: "send", channel: CHANNEL_ID, text: "hi", replyToMessageId: "100000000000000001" }),
    { kind: "send", channel: CHANNEL_ID, text: "hi", replyToMessageId: "100000000000000001" });
  assert.deepEqual(parseSendAction({ kind: "send_dm", userId: USER_ID, text: "hi", replyToMessageId: "100000000000000001" }),
    { kind: "send_dm", userId: USER_ID, text: "hi", replyToMessageId: "100000000000000001" });
  assert.deepEqual(parseSendAction({ kind: "react", channel: CHANNEL_ID, messageId: "100000000000000001", emoji: "👍" }),
    { kind: "react", channel: CHANNEL_ID, messageId: "100000000000000001", emoji: "👍" });
  assert.deepEqual(parseSendAction({ kind: "typing", channel: CHANNEL_ID }),
    { kind: "typing", channel: CHANNEL_ID });

  assert.equal(parseSendAction({ kind: "send", channel: "not-a-snowflake", text: "hi" }), null);
  assert.equal(parseSendAction({ kind: "send", channel: CHANNEL_ID, text: "" }), null);
  assert.equal(parseSendAction({ kind: "send", channel: CHANNEL_ID }), null);
  assert.equal(parseSendAction({ kind: "send", channel: CHANNEL_ID, text: "hi", replyToMessageId: "junk" }), null);
  assert.equal(parseSendAction({ kind: "send_dm", userId: "junk", text: "hi" }), null);
  assert.equal(parseSendAction({ kind: "send_dm", userId: USER_ID, text: "" }), null);
  assert.equal(parseSendAction({ kind: "react", channel: CHANNEL_ID, messageId: "100000000000000001", emoji: "" }), null);
  assert.equal(parseSendAction({ kind: "react", channel: CHANNEL_ID, messageId: "x".repeat(65) }), null);
  assert.equal(parseSendAction({ kind: "typing", channel: "not-a-snowflake" }), null);
  assert.equal(parseSendAction({ kind: "upload", channel: CHANNEL_ID }), null);
  assert.equal(parseSendAction({}), null);
  assert.equal(parseSendAction("nope"), null);
});

test("parseSendAction accepts proactive_send aliases and strictly rejects raw-route keys", () => {
  // Valid shapes.
  assert.deepEqual(parseSendAction({ kind: "proactive_send", requestId: REQUEST_ID, destination: "aidhd.porch", text: "hello" }),
    { kind: "proactive_send", requestId: REQUEST_ID, destination: "aidhd.porch", text: "hello" });
  assert.deepEqual(parseSendAction({ kind: "proactive_send", requestId: REQUEST_ID, destination: "  AIDHD.PORCH ", text: "hello", mentions: ["Marta", "boys"] }),
    { kind: "proactive_send", requestId: REQUEST_ID, destination: "aidhd.porch", text: "hello", mentions: ["marta", "boys"] });

  // Missing/empty fields.
  assert.equal(parseSendAction({ kind: "proactive_send", text: "hi" }), null);
  assert.equal(parseSendAction({ kind: "proactive_send", requestId: "not-a-uuid", destination: "aidhd.porch", text: "hi" }), null);
  assert.equal(parseSendAction({ kind: "proactive_send", requestId: REQUEST_ID, destination: "", text: "hi" }), null);
  assert.equal(parseSendAction({ kind: "proactive_send", requestId: REQUEST_ID, destination: "has space", text: "hi" }), null);
  assert.equal(parseSendAction({ kind: "proactive_send", requestId: REQUEST_ID, destination: CHANNEL_ID, text: "hi" }), null);
  assert.equal(parseSendAction({ kind: "proactive_send", requestId: REQUEST_ID, destination: "aidhd.porch" }), null);
  assert.equal(parseSendAction({ kind: "proactive_send", requestId: REQUEST_ID, destination: "aidhd.porch", text: "" }), null);

  // Raw-route keys are strictly rejected alongside proactive_send.
  for (const rawKey of ["channel", "channelId", "userId", "guildId", "roleId", "replyToMessageId", "allowedMentions", "mentionUserIds", "mentionRoleIds"]) {
    assert.equal(parseSendAction({ kind: "proactive_send", requestId: REQUEST_ID, destination: "aidhd.porch", text: "hi", [rawKey]: CHANNEL_ID }), null,
      `raw key ${rawKey} must be rejected`);
  }
  assert.equal(parseSendAction({ kind: "proactive_send", requestId: REQUEST_ID, destination: "aidhd.porch", text: "hi", unrelated: true }), null);

  // Mention aliases must be non-empty strings, non-snowflake, and duplicate-free.
  assert.equal(parseSendAction({ kind: "proactive_send", requestId: REQUEST_ID, destination: "d", text: "hi", mentions: "boys" }), null);
  assert.equal(parseSendAction({ kind: "proactive_send", requestId: REQUEST_ID, destination: "d", text: "hi", mentions: [""] }), null);
  assert.equal(parseSendAction({ kind: "proactive_send", requestId: REQUEST_ID, destination: "d", text: "hi", mentions: [CHANNEL_ID] }), null);
  assert.equal(parseSendAction({ kind: "proactive_send", requestId: REQUEST_ID, destination: "d", text: "hi", mentions: ["has space"] }), null);
  assert.equal(parseSendAction({ kind: "proactive_send", requestId: REQUEST_ID, destination: "d", text: "hi", mentions: ["boys", "BOYS"] }), null);
  assert.equal(parseSendAction({ kind: "proactive_send", requestId: REQUEST_ID, destination: "d", text: "hi", mentions: [42] }), null);
});

// ------------------------------------------------- proactive destination registry

const REGISTRY_JSON = JSON.stringify({
  "aidhd.porch": {
    guildId: GUILD_ID,
    channelId: CHANNEL_ID,
    mentions: {
      marta: { kind: "user", id: USER_ID },
      boys: { kind: "role", id: BOYS_ROLE_ID },
    },
  },
});

function registryFromEnv(value) {
  return parseProactiveDestinations("DISCORD_BRIDGE_PROACTIVE_DESTINATIONS_JSON", value);
}

test("proactive destination registry parses strict JSON and normalizes aliases", () => {
  const registry = registryFromEnv(REGISTRY_JSON);
  assert.equal(registry.size, 1);
  const porch = registry.get("aidhd.porch");
  assert.ok(porch);
  assert.equal(porch.guildId, GUILD_ID);
  assert.equal(porch.channelId, CHANNEL_ID);
  assert.equal(porch.mentions.get("marta").kind, "user");
  assert.equal(porch.mentions.get("marta").id, USER_ID);
  assert.equal(porch.mentions.get("boys").kind, "role");
  assert.equal(porch.mentions.get("boys").id, BOYS_ROLE_ID);

  // Mixed-case keys normalize to the same lowercase alias.
  const normalized = registryFromEnv(JSON.stringify({ "AIDHD.PORCH": { guildId: GUILD_ID, channelId: CHANNEL_ID } }));
  assert.ok(normalized.get("aidhd.porch"));

  // Omitted and empty values are valid: no proactive destinations.
  assert.equal(registryFromEnv(undefined).size, 0);
  assert.equal(registryFromEnv("").size, 0);
  assert.equal(registryFromEnv("   ").size, 0);

  // Alias normalization helper: restrictive pattern, snowflake-shaped rejected.
  assert.equal(normalizeDestinationAlias("  Porch "), "porch");
  assert.equal(normalizeDestinationAlias("aidhd.porch"), "aidhd.porch");
  assert.equal(normalizeDestinationAlias("aidhd-porch_2"), "aidhd-porch_2");
  assert.equal(normalizeDestinationAlias(""), null);
  assert.equal(normalizeDestinationAlias("222222222222222222"), null, "snowflake-shaped alias rejected");
  assert.equal(normalizeDestinationAlias("has space"), null);
  assert.equal(normalizeDestinationAlias("UPPER"), "upper");
});

test("proactive destination registry rejects malformed and duplicate configuration", () => {
  // Not strict JSON.
  assert.throws(() => registryFromEnv("{not json"), /strict JSON/);
  assert.throws(() => registryFromEnv("[1,2]"), /JSON object/);
  assert.throws(() => registryFromEnv("42"), /JSON object/);
  // Duplicate destination aliases after normalization.
  assert.throws(() => registryFromEnv(JSON.stringify({
    porch: { guildId: GUILD_ID, channelId: CHANNEL_ID },
    PORCH: { guildId: GUILD_ID, channelId: CHANNEL_ID },
  })), /duplicate destination alias/);
  // Invalid destination alias.
  assert.throws(() => registryFromEnv(JSON.stringify({
    "222222222222222222": { guildId: GUILD_ID, channelId: CHANNEL_ID },
  })), /invalid destination alias/);
  assert.throws(() => registryFromEnv(JSON.stringify({
    "has space": { guildId: GUILD_ID, channelId: CHANNEL_ID },
  })), /invalid destination alias/);
  // Bad destination shapes.
  assert.throws(() => registryFromEnv(JSON.stringify({ porch: {} })), /invalid/);
  assert.throws(() => registryFromEnv(JSON.stringify({ porch: { guildId: "nope", channelId: CHANNEL_ID } })), /invalid/);
  assert.throws(() => registryFromEnv(JSON.stringify({ porch: { guildId: GUILD_ID, channelId: CHANNEL_ID, extra: 1 } })), /invalid/);
  // Duplicate mention aliases within one destination.
  assert.throws(() => registryFromEnv(JSON.stringify({
    porch: {
      guildId: GUILD_ID, channelId: CHANNEL_ID,
      mentions: { boys: { kind: "role", id: BOYS_ROLE_ID }, BOYS: { kind: "role", id: BOYS_ROLE_ID } },
    },
  })), /duplicate mention alias/);
  // Invalid mention alias and bad mention shape.
  assert.throws(() => registryFromEnv(JSON.stringify({
    porch: { guildId: GUILD_ID, channelId: CHANNEL_ID, mentions: { "222222222222222222": { kind: "user", id: USER_ID } } },
  })), /invalid mention alias/);
  assert.throws(() => registryFromEnv(JSON.stringify({
    porch: { guildId: GUILD_ID, channelId: CHANNEL_ID, mentions: { marta: { kind: "everyone", id: USER_ID } } },
  })), /invalid/);
  assert.throws(() => registryFromEnv(JSON.stringify({
    porch: { guildId: GUILD_ID, channelId: CHANNEL_ID, mentions: { marta: { kind: "user", id: "not-a-snowflake" } } },
  })), /invalid/);
});

test("resolveProactiveTarget resolves aliases server-side and enforces mention policy", () => {
  const registry = registryFromEnv(REGISTRY_JSON);
  const allowAll = { allowedMentionUserIds: [USER_ID], allowedMentionRoleIds: [BOYS_ROLE_ID] };

  // Successful alias resolution with both mention kinds.
  const resolved = resolveProactiveTarget(registry, allowAll, "aidhd.porch", ["marta", "boys"]);
  assert.deepEqual(resolved, {
    guildId: GUILD_ID, channelId: CHANNEL_ID,
    mentionUserIds: [USER_ID], mentionRoleIds: [BOYS_ROLE_ID],
  });

  // No mentions is fine.
  assert.deepEqual(resolveProactiveTarget(registry, allowAll, "aidhd.porch", []),
    { guildId: GUILD_ID, channelId: CHANNEL_ID, mentionUserIds: [], mentionRoleIds: [] });

  // Unknown destination fails closed.
  assert.throws(() => resolveProactiveTarget(registry, allowAll, "missing.place", []),
    /Unknown proactive destination/);
  // Unknown mention alias for a known destination fails closed.
  assert.throws(() => resolveProactiveTarget(registry, allowAll, "aidhd.porch", ["nobody"]),
    /Unknown proactive mention/);
  // Mention IDs must pass the global allowlists: role not allowlisted.
  assert.throws(() => resolveProactiveTarget(registry, { allowedMentionUserIds: [USER_ID], allowedMentionRoleIds: [] }, "aidhd.porch", ["boys"]),
    /Mentioned role is not allowed/);
  // User not allowlisted.
  assert.throws(() => resolveProactiveTarget(registry, { allowedMentionUserIds: [], allowedMentionRoleIds: [BOYS_ROLE_ID] }, "aidhd.porch", ["marta"]),
    /Mention recipient is not allowed/);
  // Duplicate mention aliases deduplicate to one ID each.
  const deduped = resolveProactiveTarget(registry, allowAll, "aidhd.porch", ["marta", "marta"]);
  assert.deepEqual(deduped.mentionUserIds, [USER_ID]);
  assert.deepEqual(deduped.mentionRoleIds, []);
});

test("verifyProactiveDestinations fails startup on unknown or mismatched destinations", async () => {
  const registry = registryFromEnv(REGISTRY_JSON);
  const policy = {
    ...POLICY,
    allowedMentionUserIds: [USER_ID],
    allowedMentionRoleIds: [BOYS_ROLE_ID],
  };

  // Happy path: guild, channel in that guild, bot permission, and role/member resolvable.
  const okVerifier = {
    fetchGuild: async id => ({ id }),
    fetchSendableChannel: async id => ({ id, guildId: GUILD_ID, parentId: null }),
    fetchRole: async (guildId, roleId) => ({ id: roleId, managed: false, mentionable: true }),
    fetchMember: async (guildId, userId) => ({ id: userId }),
    canSendToChannel: async () => true,
  };
  await verifyProactiveDestinations(registry, okVerifier, policy);

  // Unknown guild.
  await assert.rejects(() => verifyProactiveDestinations(registry, {
    ...okVerifier, fetchGuild: async () => null,
  }, policy), /unknown guild/);
  // Unknown or non-sendable channel.
  await assert.rejects(() => verifyProactiveDestinations(registry, {
    ...okVerifier, fetchSendableChannel: async () => null,
  }, policy), /unknown or non-sendable channel/);
  // Channel in a different guild.
  await assert.rejects(() => verifyProactiveDestinations(registry, {
    ...okVerifier, fetchSendableChannel: async id => ({ id, guildId: OTHER_GUILD, parentId: null }),
  }, policy), /not in its configured guild/);
  // Bot lacks permission to view/send.
  await assert.rejects(() => verifyProactiveDestinations(registry, {
    ...okVerifier, canSendToChannel: async () => false,
  }, policy), /not viewable and sendable/);
  // Unknown role mention.
  await assert.rejects(() => verifyProactiveDestinations(registry, {
    ...okVerifier, fetchRole: async () => null,
  }, policy), /unknown, managed, or unmentionable role/);
  // Managed roles cannot be proactively pinged.
  await assert.rejects(() => verifyProactiveDestinations(registry, {
    ...okVerifier, fetchRole: async (_guildId, roleId) => ({ id: roleId, managed: true, mentionable: true }),
  }, policy), /unknown, managed, or unmentionable role/);
  await assert.rejects(() => verifyProactiveDestinations(registry, {
    ...okVerifier, fetchRole: async (_guildId, roleId) => ({ id: roleId, managed: false, mentionable: false }),
  }, policy), /unknown, managed, or unmentionable role/);
  // Unknown guild member mention.
  await assert.rejects(() => verifyProactiveDestinations(registry, {
    ...okVerifier, fetchMember: async () => null,
  }, policy), /unknown user/);
  // Destination and mention IDs must remain inside global policy.
  await assert.rejects(() => verifyProactiveDestinations(registry, okVerifier, {
    ...policy,
    allowedChannelIds: [OTHER_CHANNEL],
  }), /not allowed by policy/);
  await assert.rejects(() => verifyProactiveDestinations(registry, okVerifier, {
    ...policy,
    allowedMentionRoleIds: [],
  }), /Mentioned role is not allowed/);
});

test("composeMentionTokens builds role and user tokens server-side", () => {
  assert.deepEqual(composeMentionTokens([USER_ID], [BOYS_ROLE_ID]),
    [`<@&${BOYS_ROLE_ID}>`, `<@${USER_ID}>`]);
  assert.deepEqual(composeMentionTokens([], []), []);
});

test("proactive runtime handler resolves aliases and sends through the safe path", async () => {
  const registry = registryFromEnv(REGISTRY_JSON);
  const calls = [];
  const limits = { messageChars: 2000 };
  const handlers = createBridgeSendHandlers(
    {
      defaults: {},
      limits,
      policy: { allowedMentionUserIds: [USER_ID], allowedMentionRoleIds: [BOYS_ROLE_ID] },
      bridge: { proactiveDestinations: registry },
    },
    {
      sendMessage: async options => {
        calls.push(options);
        return { id: "900000000000000009", channelId: options.channel, channelName: "porch" };
      },
      sendDirectMessage: async () => { throw new Error("not used"); },
      reactToMessage: async () => { throw new Error("not used"); },
      setTyping: async () => { throw new Error("not used"); },
    },
  );

  const result = await handlers.proactiveSend({ kind: "proactive_send", requestId: REQUEST_ID, destination: "aidhd.porch", text: "standup time", mentions: ["marta", "boys"] });
  assert.deepEqual(result, { messageId: "900000000000000009", channelId: CHANNEL_ID, destination: "aidhd.porch", requestId: REQUEST_ID });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].channel, CHANNEL_ID);
  assert.equal(calls[0].content, `<@&${BOYS_ROLE_ID}> <@${USER_ID}> standup time`);
  assert.deepEqual(calls[0].mentionUserIds, [USER_ID]);
  assert.deepEqual(calls[0].mentionRoleIds, [BOYS_ROLE_ID]);
  assert.equal("fallbackGuildId" in calls[0], false);

  // Without mentions the text is sent untouched.
  await handlers.proactiveSend({ kind: "proactive_send", requestId: "22222222-2222-4222-8222-222222222222", destination: "aidhd.porch", text: "plain" });
  assert.equal(calls[1].content, "plain");
  assert.deepEqual(calls[1].mentionUserIds, []);
  assert.deepEqual(calls[1].mentionRoleIds, []);

  // Unknown destination and unknown mention fail closed via PolicyError.
  await assert.rejects(() => handlers.proactiveSend({ kind: "proactive_send", requestId: "33333333-3333-4333-8333-333333333333", destination: "missing.place", text: "x" }),
    /Unknown proactive destination/);
  await assert.rejects(() => handlers.proactiveSend({ kind: "proactive_send", requestId: "44444444-4444-4444-8444-444444444444", destination: "aidhd.porch", text: "x", mentions: ["nobody"] }),
    /Unknown proactive mention/);
  assert.equal(calls.length, 2, "failed sends must not reach Discord");

  // A repeated request ID reuses the first receipt without sending twice.
  const repeated = await handlers.proactiveSend({
    kind: "proactive_send", requestId: REQUEST_ID, destination: "aidhd.porch", text: "standup time", mentions: ["marta", "boys"],
  });
  assert.deepEqual(repeated, result);
  assert.equal(calls.length, 2, "idempotent retry must not send again");
});

test("proactive idempotency expires settled receipts but never evicts an in-flight send", async () => {
  const registry = registryFromEnv(REGISTRY_JSON);
  const originalNow = Date.now;
  let now = 1_000_000;
  Date.now = () => now;
  try {
    let completedCalls = 0;
    const completedHandlers = createBridgeSendHandlers({
      defaults: {},
      limits: { messageChars: 2000 },
      policy: { allowedMentionUserIds: [USER_ID], allowedMentionRoleIds: [BOYS_ROLE_ID] },
      bridge: { proactiveDestinations: registry },
    }, {
      sendMessage: async options => {
        completedCalls += 1;
        return { id: "900000000000000009", channelId: options.channel, channelName: "porch" };
      },
      sendDirectMessage: async () => { throw new Error("not used"); },
      reactToMessage: async () => { throw new Error("not used"); },
      setTyping: async () => { throw new Error("not used"); },
    });
    const action = { kind: "proactive_send", requestId: REQUEST_ID, destination: "aidhd.porch", text: "hello" };
    await completedHandlers.proactiveSend(action);
    now += 9 * 60_000;
    await completedHandlers.proactiveSend(action);
    assert.equal(completedCalls, 1, "settled receipt must remain cached before TTL");
    now += 2 * 60_000;
    await completedHandlers.proactiveSend(action);
    assert.equal(completedCalls, 2, "settled receipt must expire after TTL");

    let resolveSend;
    let inFlightCalls = 0;
    const inFlightHandlers = createBridgeSendHandlers({
      defaults: {},
      limits: { messageChars: 2000 },
      policy: { allowedMentionUserIds: [USER_ID], allowedMentionRoleIds: [BOYS_ROLE_ID] },
      bridge: { proactiveDestinations: registry },
    }, {
      sendMessage: async options => {
        inFlightCalls += 1;
        return await new Promise(resolve => {
          resolveSend = () => resolve({ id: "900000000000000009", channelId: options.channel, channelName: "porch" });
        });
      },
      sendDirectMessage: async () => { throw new Error("not used"); },
      reactToMessage: async () => { throw new Error("not used"); },
      setTyping: async () => { throw new Error("not used"); },
    });
    const first = inFlightHandlers.proactiveSend(action);
    await Promise.resolve();
    now += 11 * 60_000;
    const repeated = inFlightHandlers.proactiveSend(action);
    await Promise.resolve();
    assert.equal(inFlightCalls, 1, "in-flight send must survive TTL pruning");
    resolveSend();
    assert.deepEqual(await repeated, await first);
  } finally {
    Date.now = originalNow;
  }
});

test("proactive idempotency fails closed instead of evicting 512 in-flight sends", async () => {
  const registry = registryFromEnv(REGISTRY_JSON);
  let resolveShared;
  const shared = new Promise(resolve => { resolveShared = resolve; });
  let calls = 0;
  const handlers = createBridgeSendHandlers({
    defaults: {},
    limits: { messageChars: 2000 },
    policy: { allowedMentionUserIds: [USER_ID], allowedMentionRoleIds: [BOYS_ROLE_ID] },
    bridge: { proactiveDestinations: registry },
  }, {
    sendMessage: async options => {
      calls += 1;
      await shared;
      return { id: "900000000000000009", channelId: options.channel, channelName: "porch" };
    },
    sendDirectMessage: async () => { throw new Error("not used"); },
    reactToMessage: async () => { throw new Error("not used"); },
    setTyping: async () => { throw new Error("not used"); },
  });
  const pending = Array.from({ length: 512 }, (_, index) => handlers.proactiveSend({
    kind: "proactive_send",
    requestId: `capacity-${index}`,
    destination: "aidhd.porch",
    text: `message ${index}`,
  }));
  await Promise.resolve();
  await assert.rejects(() => handlers.proactiveSend({
    kind: "proactive_send",
    requestId: "capacity-overflow",
    destination: "aidhd.porch",
    text: "must not evict",
  }), /capacity is temporarily exhausted/);
  assert.equal(calls, 512);
  resolveShared();
  await Promise.all(pending);
});

test("exact-ID bridge actions are not constrained to the configured default guild", async () => {
  const calls = [];
  const limits = { messageChars: 2000 };
  const handlers = createBridgeSendHandlers(
    { defaults: { guildId: GUILD_ID }, limits },
    {
      sendMessage: async options => {
        calls.push(["send", options]);
        return { id: "900000000000000001", channelId: options.channel, channelName: "cross-guild" };
      },
      sendDirectMessage: async options => {
        calls.push(["send_dm", options]);
        return { id: "900000000000000002", channelId: "900000000000000003", recipient: "user" };
      },
      reactToMessage: async options => { calls.push(["react", options]); return { ok: true }; },
      setTyping: async options => { calls.push(["typing", options]); return { ok: true }; },
    },
  );
  await handlers.send({ kind: "send", channel: OTHER_CHANNEL, text: "cross-guild reply" });
  await handlers.react({ kind: "react", channel: OTHER_CHANNEL, messageId: "900000000000000004", emoji: "👍" });
  await handlers.typing({ kind: "typing", channel: OTHER_CHANNEL });

  assert.deepEqual(calls, [
    ["send", { channel: OTHER_CHANNEL, content: "cross-guild reply", replyToMessageId: undefined, limits }],
    ["react", { channel: OTHER_CHANNEL, messageId: "900000000000000004", emoji: "👍" }],
    ["typing", { channel: OTHER_CHANNEL }],
  ]);
  for (const [, options] of calls) {
    assert.equal("fallbackGuildId" in options, false, "default guild must not constrain exact-ID bridge actions");
  }
});

// ------------------------------------------------------------- HTTP endpoints

function makeApp(overrides = {}) {
  const queue = overrides.queue ?? new BridgeEventQueue(16);
  const calls = [];
  const sendHandlers = {
    send: async action => { calls.push(action); return { messageId: "900000000000000001", channelId: action.channel }; },
    sendDm: async action => { calls.push(action); return { messageId: "900000000000000002", channelId: "900000000000000003" }; },
    proactiveSend: async action => {
      if (action.destination !== "aidhd.porch") {
        const error = new Error("Unknown proactive destination");
        error.name = "PolicyError";
        throw error;
      }
      calls.push(action);
      return {
        messageId: "900000000000000010",
        channelId: CHANNEL_ID,
        destination: action.destination,
        requestId: action.requestId,
      };
    },
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
  await withServer({ bridge: { pollTimeoutMs: 1000 } }, async (base, queue) => {
    const started = Date.now();
    const pending = fetch(`${base}/bridge/events?after=0&wait=1`, { headers: AUTH });
    setTimeout(() => queue.enqueue({ messageId: "1" }), 50);
    const response = await pending;
    const body = await response.json();
    assert.equal(body.events.length, 1);
    assert.ok(Date.now() - started < 800, "event wakeup did not beat the long-poll timeout");

    const t0 = Date.now();
    const empty = await (await fetch(`${base}/bridge/events?after=1&wait=1`, { headers: AUTH })).json();
    assert.deepEqual(empty.events, []);
    assert.ok(Date.now() - t0 >= 800, "empty long-poll returned substantially before its configured timeout");
  });
});

test("POST /bridge/ack supports exact acknowledgements without dropping older events", async () => {
  await withServer({}, async (base, queue) => {
    queue.enqueue({ messageId: "1" });
    queue.enqueue({ messageId: "2" });
    const ack = await (await fetch(`${base}/bridge/ack`, {
      method: "POST", headers: { ...AUTH, "Content-Type": "application/json" }, body: JSON.stringify({ seq: 1 }),
    })).json();
    assert.equal(ack.removed, 1);
    assert.equal(ack.lastSeq, 2);
    assert.equal(queue.size, 1);

    queue.enqueue({ messageId: "3" });
    const exact = await (await fetch(`${base}/bridge/ack`, {
      method: "POST", headers: { ...AUTH, "Content-Type": "application/json" }, body: JSON.stringify({ seq: 3, messageId: "3", exact: true }),
    })).json();
    assert.equal(exact.exact, true);
    assert.equal(exact.messageId, "3");
    assert.equal(exact.removed, 1);
    assert.deepEqual(queue.since(0).map(event => event.seq), [2]);

    const alreadyRemoved = await fetch(`${base}/bridge/ack`, {
      method: "POST", headers: { ...AUTH, "Content-Type": "application/json" }, body: JSON.stringify({ seq: 3, messageId: "3", exact: true }),
    });
    assert.equal(alreadyRemoved.status, 409);
    assert.deepEqual(await alreadyRemoved.json(), {
      error: "ack_conflict", acked: 3, exact: true, messageId: "3", removed: 0, lastSeq: 3, size: 1,
    });

    const mismatchedGeneration = await fetch(`${base}/bridge/ack`, {
      method: "POST", headers: { ...AUTH, "Content-Type": "application/json" }, body: JSON.stringify({ seq: 2, messageId: "stale-message-id", exact: true }),
    });
    assert.equal(mismatchedGeneration.status, 409);
    assert.equal((await mismatchedGeneration.json()).removed, 0);
    assert.deepEqual(queue.since(0).map(event => event.message.messageId), ["2"], "mismatched exact ACK must retain the current event");

    for (const bad of ["[]", "null", '{"seq":"1"}', '{"seq":-1}', '{"seq":1.5}', '{"seq":99}', '{"seq":2,"exact":"yes"}', '{"seq":2,"exact":true}', "{}"]) {
      const response = await fetch(`${base}/bridge/ack`, {
        method: "POST", headers: { ...AUTH, "Content-Type": "application/json" }, body: bad,
      });
      assert.equal(response.status, 400, `body ${bad} should be rejected`);
    }
  });
});

test("POST /bridge/send routes channel, DM, react, and typing actions", async () => {
  await withServer({}, async (base, _queue, calls) => {
    const send = await fetch(`${base}/bridge/send`, {
      method: "POST", headers: { ...AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "send", channel: CHANNEL_ID, text: "hi", replyToMessageId: "100000000000000001" }),
    });
    assert.equal(send.status, 200);
    assert.deepEqual(await send.json(), { ok: true, kind: "send", messageId: "900000000000000001", channelId: CHANNEL_ID });

    const dm = await fetch(`${base}/bridge/send`, {
      method: "POST", headers: { ...AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "send_dm", userId: USER_ID, text: "private hi" }),
    });
    assert.equal(dm.status, 200);
    assert.deepEqual(await dm.json(), { ok: true, kind: "send_dm", messageId: "900000000000000002", channelId: "900000000000000003" });

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
    assert.equal(calls.length, 4);
  });
});

test("POST /bridge/send routes proactive_send and rejects raw-route keys with 400", async () => {
  await withServer({}, async (base, _queue, calls) => {
    const ok = await fetch(`${base}/bridge/send`, {
      method: "POST", headers: { ...AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "proactive_send", requestId: REQUEST_ID, destination: "aidhd.porch", text: "hello", mentions: ["marta"] }),
    });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), {
      ok: true, kind: "proactive_send", requestId: REQUEST_ID,
      destination: "aidhd.porch", messageId: "900000000000000010",
    });

    // Raw-route keys alongside proactive_send are rejected before the handler.
    for (const rawKey of ["channel", "userId", "guildId", "replyToMessageId", "allowedMentions"]) {
      const rejected = await fetch(`${base}/bridge/send`, {
        method: "POST", headers: { ...AUTH, "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "proactive_send", requestId: REQUEST_ID, destination: "aidhd.porch", text: "hi", [rawKey]: CHANNEL_ID }),
      });
      assert.equal(rejected.status, 400, `raw key ${rawKey} must be rejected with 400`);
    }
    assert.equal(calls.length, 1, "only the valid proactive action reaches the handler");

  });

  // Unknown destinations surface as sanitized 422 policy failures.
  const unknownDestination = new Error("Unknown proactive destination");
  unknownDestination.name = "PolicyError";
  await withServer({
    sendHandlers: { proactiveSend: async () => { throw unknownDestination; } },
  }, async base => {
    const unknown = await fetch(`${base}/bridge/send`, {
      method: "POST", headers: { ...AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "proactive_send", requestId: REQUEST_ID, destination: "missing.place", text: "hi" }),
    });
    assert.equal(unknown.status, 422);
    const body = await unknown.json();
    assert.equal(body.error, "send_failed");
    assert.equal(body.message, "Unknown proactive destination");
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

    // Exhausting the event-poll counter must not consume the allowance needed
    // for the eventual ACK or an intentional outbound send.
    const outbound = await fetch(`${base}/bridge/send`, {
      method: "POST",
      headers: { ...AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "send", channel: CHANNEL_ID, text: "still available" }),
    });
    assert.equal(outbound.status, 200);
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

// --------------------------------------------- sendMessage hardening (mention policy)

const MENTION_POLICY = {
  ...POLICY,
  allowedMentionUserIds: [USER_ID],
  allowedMentionRoleIds: [BOYS_ROLE_ID],
};

test("message payload cannot have validated allowedMentions overridden by extra", () => {
  const payload = buildMessagePayload("hi", [USER_ID], [BOYS_ROLE_ID], {
    embeds: [{ title: "x" }],
    allowedMentions: { parse: ["everyone", "roles", "users"], repliedUser: true },
  });
  assert.deepEqual(payload.embeds, [{ title: "x" }]);
  assert.deepEqual(payload.allowedMentions, {
    parse: [], users: [USER_ID], roles: [BOYS_ROLE_ID], repliedUser: false,
  });
});

test("mention policy helpers deduplicate and validate IDs", () => {
  assert.deepEqual(assertMentionUsersAllowed(MENTION_POLICY, [USER_ID, USER_ID]), [USER_ID]);
  assert.deepEqual(assertMentionRolesAllowed(MENTION_POLICY, [BOYS_ROLE_ID, BOYS_ROLE_ID]), [BOYS_ROLE_ID]);
  assert.throws(() => assertMentionUsersAllowed(MENTION_POLICY, ["not-a-snowflake"]), /not allowed/);
  assert.throws(() => assertMentionRolesAllowed(MENTION_POLICY, ["not-a-snowflake"]), /not allowed/);
});
