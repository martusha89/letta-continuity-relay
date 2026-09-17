import test from "node:test";
import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  channelPlugin,
  createContinuityDiscordAdapter,
  createDiscordTypingController,
  ensureThreadRoute,
  mapBridgeEvent,
  parseAccountConfig,
} from "../letta-channel/continuity-discord/plugin.mjs";

const CHANNEL = "222222222222222222";
const MESSAGE = "333333333333333333";
const USER = "444444444444444444";

function account(overrides = {}) {
  return {
    channel: "continuity-discord",
    accountId: "main",
    displayName: "Continuity Discord",
    enabled: true,
    config: {
      base_url: "https://bridge.example.test/",
      auth: "b".repeat(32),
      poll_wait: true,
      request_timeout_ms: 2000,
      min_backoff_ms: 100,
      max_backoff_ms: 500,
      ...overrides,
    },
  };
}

function event(seq = 1, overrides = {}) {
  return {
    seq,
    enqueuedAt: "2026-09-15T20:00:00.000Z",
    message: {
      messageId: MESSAGE,
      timestamp: "2026-09-15T20:00:00.000Z",
      account: "discord",
      channel: CHANNEL,
      chatType: "channel",
      guildId: "111111111111111111",
      guildName: "AI●DHD Corner",
      channelId: CHANNEL,
      channelName: "test",
      threadId: null,
      parentChannelId: null,
      authorId: USER,
      authorName: "Example User",
      text: "hello",
      attachments: [],
      isMention: true,
      ...overrides,
    },
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function abortablePending(signal) {
  return new Promise((_resolve, reject) => {
    const abort = () => reject(new DOMException("Aborted", "AbortError"));
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  });
}

async function withMockFetch(mock, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = mock;
  try { return await fn(); } finally { globalThis.fetch = original; }
}

test("custom channel metadata and account config are fail-closed and secret-safe", () => {
  assert.equal(channelPlugin.metadata.id, "continuity-discord");
  assert.deepEqual(channelPlugin.messageActions.describeMessageTool(), { actions: ["send", "react"] });
  const parsed = parseAccountConfig(account());
  assert.equal(parsed.baseUrl, "https://bridge.example.test");
  assert.equal(parsed.bearerToken.length, 32);
  assert.equal(JSON.stringify(parsed).includes("Bearer"), false);
  assert.throws(() => parseAccountConfig(account({ base_url: "http://public.example.test" })), /HTTPS/);
  assert.doesNotThrow(() => parseAccountConfig(account({ base_url: "http://continuity-discord-bridge.railway.internal:8080" })));
  assert.throws(() => parseAccountConfig(account({ base_url: "https://u:p@example.test" })), /credentials/);
  assert.throws(() => parseAccountConfig(account({ auth: "short" })), /32 characters/);
});

test("custom channel plugin derives a portable channel identity and prefers routing.json", async () => {
  const root = await mkdtemp(join(tmpdir(), "continuity-discord-plugin-"));
  const directory = join(root, "continuity-discord");
  await mkdir(directory);
  const pluginPath = join(directory, "plugin.mjs");
  await copyFile(join(process.cwd(), "letta-channel", "continuity-discord", "plugin.mjs"), pluginPath);
  const parent = "555555555555555555";
  const thread = "666666666666666666";
  const fallbackThread = "777777777777777777";
  const routingPath = join(directory, "routing.json");
  await writeFile(routingPath, JSON.stringify({ routes: [{
    accountId: "continuity-main",
    chatId: parent,
    chatType: "channel",
    threadId: null,
    agentId: "agent-test",
    conversationId: "default",
    enabled: true,
    outboundEnabled: true,
  }] }));
  const yamlPath = join(directory, "routing.yaml");
  await writeFile(yamlPath, JSON.stringify({ routes: [] }));

  const portable = await import(`${pathToFileURL(pluginPath).href}?test=${Date.now()}`);
  assert.equal(portable.channelPlugin.metadata.id, "continuity-discord");
  assert.equal(portable.channelPlugin.metadata.displayName, "Continuity Discord");
  assert.equal(portable.ensureThreadRoute({ threadId: thread, parentChannelId: parent }, "continuity-main"), true);
  const saved = JSON.parse(await readFile(routingPath, "utf8"));
  assert.equal(saved.routes.some(route => route.chatId === thread), true);
  assert.deepEqual(JSON.parse(await readFile(yamlPath, "utf8")), { routes: [] });

  await rm(routingPath);
  await writeFile(yamlPath, JSON.stringify({ routes: [{
    accountId: "continuity-main",
    chatId: parent,
    chatType: "channel",
    threadId: null,
    agentId: "agent-test",
    conversationId: "default",
    enabled: true,
    outboundEnabled: true,
  }] }));
  assert.equal(portable.ensureThreadRoute({ threadId: fallbackThread, parentChannelId: parent }, "continuity-main"), true);
  const fallback = JSON.parse(await readFile(yamlPath, "utf8"));
  assert.equal(fallback.routes.some(route => route.chatId === fallbackThread), true);
});

test("bridge events map to source-labelled Letta messages without remote attachment URLs", () => {
  const inbound = mapBridgeEvent(event(7, {
    text: "look",
    attachments: [{ id: "a", name: "cat.png", contentType: "image/png", size: 123, url: "https://cdn.example.test/secret" }],
  }), "main");
  assert.equal(inbound.channel, "continuity-discord");
  assert.equal(inbound.accountId, "main");
  assert.equal(inbound.chatId, CHANNEL);
  assert.equal(inbound.chatType, "channel");
  assert.equal(inbound.senderId, USER);
  assert.equal(inbound.messageId, MESSAGE);
  assert.equal(inbound.threadId, null);
  assert.equal(inbound.chatLabel, "AI●DHD Corner #test");
  assert.match(inbound.text, /cat\.png \(image\/png, 123 bytes\)/);
  assert.equal(JSON.stringify(inbound).includes("cdn.example.test"), false);
  assert.equal(inbound.raw.bridgeSeq, 7);
});

test("Discord typing leases preserve queued turns sharing one channel", async () => {
  const beats = [];
  const typing = createDiscordTypingController({
    sendTyping: async target => { beats.push(target); },
    refreshMs: 10,
    maxDurationMs: 100,
  });
  const first = { chatId: CHANNEL, threadId: null, messageId: MESSAGE, senderId: USER };
  const second = { chatId: CHANNEL, threadId: null, messageId: "555555555555555555", senderId: USER };
  typing.start(first);
  typing.start(second);
  assert.equal(typing.activeSourceCount(CHANNEL), 2);
  typing.stop(first);
  assert.equal(typing.isActive(CHANNEL), true);
  assert.equal(typing.activeSourceCount(CHANNEL), 1);
  await new Promise(resolve => setTimeout(resolve, 24));
  assert.ok(beats.length >= 2);
  typing.stop(second);
  assert.equal(typing.isActive(CHANNEL), false);
  const stoppedAt = beats.length;
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(beats.length, stoppedAt);
});

test("Discord typing can be cleared by a final send to the target", async () => {
  const typing = createDiscordTypingController({
    sendTyping: async () => {},
    refreshMs: 10,
    maxDurationMs: 100,
  });
  typing.start({ chatId: CHANNEL, threadId: null, messageId: MESSAGE, senderId: USER });
  typing.start({ chatId: CHANNEL, threadId: null, messageId: "555555555555555555", senderId: USER });
  assert.equal(typing.activeSourceCount(CHANNEL), 2);
  typing.stopTarget(CHANNEL);
  assert.equal(typing.isActive(CHANNEL), false);
  assert.equal(typing.activeSourceCount(CHANNEL), 0);
});

test("Discord typing failures are sanitized and watchdog leases clean up", async () => {
  const logs = [];
  const typing = createDiscordTypingController({
    sendTyping: async () => { throw new Error("secret failure body"); },
    refreshMs: 5,
    maxDurationMs: 12,
    log: line => logs.push(line),
  });
  const source = { chatId: CHANNEL, threadId: null, messageId: MESSAGE, senderId: USER };
  typing.start(source);
  await new Promise(resolve => setTimeout(resolve, 22));
  assert.equal(typing.isActive(CHANNEL), false);
  assert.ok(logs.some(line => line.includes("typing refresh failed")));
  assert.ok(logs.some(line => line.includes("typing lease expired")));
  assert.equal(logs.join(" ").includes("secret failure body"), false);
});

test("new Discord threads clone an approved parent route before delivery", async () => {
  const directory = await mkdtemp(join(tmpdir(), "continuity-discord-route-"));
  const routingPath = join(directory, "routing.yaml");
  const parent = "555555555555555555";
  const thread = "666666666666666666";
  await writeFile(routingPath, JSON.stringify({ routes: [{
    accountId: "main",
    chatId: parent,
    chatType: "channel",
    threadId: null,
    agentId: "agent-test",
    conversationId: "default",
    enabled: true,
    outboundEnabled: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  }] }));

  assert.equal(ensureThreadRoute({ threadId: thread, parentChannelId: parent }, "main", routingPath), true);
  const saved = JSON.parse(await readFile(routingPath, "utf8"));
  assert.equal(saved.routes.length, 2);
  assert.deepEqual(saved.routes[1], {
    ...saved.routes[0],
    chatId: thread,
    createdAt: saved.routes[1].createdAt,
    updatedAt: saved.routes[1].updatedAt,
  });
  assert.equal(ensureThreadRoute({ threadId: thread, parentChannelId: parent }, "main", routingPath), false);
  assert.equal(JSON.parse(await readFile(routingPath, "utf8")).routes.length, 2);
});

test("thread route provisioning fails closed without a same-account approved parent", async () => {
  const directory = await mkdtemp(join(tmpdir(), "continuity-discord-route-"));
  const routingPath = join(directory, "routing.yaml");
  await writeFile(routingPath, JSON.stringify({ routes: [{
    accountId: "other",
    chatId: "555555555555555555",
    threadId: null,
    agentId: "agent-other",
    conversationId: "default",
    enabled: true,
  }] }));
  assert.equal(ensureThreadRoute({
    threadId: "666666666666666666",
    parentChannelId: "555555555555555555",
  }, "main", routingPath), false);
  assert.equal(JSON.parse(await readFile(routingPath, "utf8")).routes.length, 1);
});

test("thread route provisioning rejects an exact route that conflicts with its parent", async () => {
  const directory = await mkdtemp(join(tmpdir(), "continuity-discord-route-"));
  const routingPath = join(directory, "routing.yaml");
  const parent = "555555555555555555";
  const thread = "666666666666666666";
  await writeFile(routingPath, JSON.stringify({ routes: [{
    accountId: "main", chatId: parent, chatType: "channel", threadId: null,
    agentId: "agent-approved", conversationId: "default", enabled: true, outboundEnabled: true,
  }, {
    accountId: "main", chatId: thread, chatType: "channel", threadId: null,
    agentId: "agent-other", conversationId: "default", enabled: true, outboundEnabled: true,
  }] }));
  assert.throws(() => ensureThreadRoute({ threadId: thread, parentChannelId: parent }, "main", routingPath),
    /conflicts with its approved parent/);
});

test("adapter typing follows queued, processing, and finished lifecycle per source", async () => {
  const typingBodies = [];
  await withMockFetch(async (url, options = {}) => {
    const path = new URL(url).pathname;
    if (path.endsWith("/bridge/events")) return abortablePending(options.signal);
    if (path.endsWith("/bridge/send")) {
      typingBodies.push(JSON.parse(options.body));
      return json({ ok: true, kind: "typing" });
    }
    throw new Error("unexpected request");
  }, async () => {
    const adapter = createContinuityDiscordAdapter(account({ typing_refresh_ms: 5, typing_max_duration_ms: 100 }));
    const first = { chatId: CHANNEL, threadId: null, messageId: MESSAGE, senderId: USER };
    const second = { chatId: CHANNEL, threadId: null, messageId: "555555555555555555", senderId: USER };
    await adapter.start();
    await adapter.handleTurnLifecycleEvent({ type: "queued", source: first });
    await adapter.handleTurnLifecycleEvent({ type: "processing", sources: [first] });
    await adapter.handleTurnLifecycleEvent({ type: "queued", source: second });
    await adapter.handleTurnLifecycleEvent({ type: "finished", sources: [first], outcome: "completed" });
    await new Promise(resolve => setTimeout(resolve, 14));
    assert.ok(typingBodies.length >= 2, "second queued source should keep the shared target refreshing");
    await adapter.handleTurnLifecycleEvent({ type: "finished", sources: [second], outcome: "completed" });
    const stoppedAt = typingBodies.length;
    await new Promise(resolve => setTimeout(resolve, 12));
    assert.equal(typingBodies.length, stoppedAt);
    assert.ok(typingBodies.every(body => body.kind === "typing" && body.channel === CHANNEL));
    await adapter.stop();
  });
});

test("listener delivers before acknowledging and stops by aborting its long poll", async () => {
  const order = [];
  let pollCount = 0;
  await withMockFetch(async (url, options = {}) => {
    const path = new URL(url).pathname;
    if (path.endsWith("/bridge/events")) {
      pollCount += 1;
      if (pollCount === 1) {
        order.push("events");
        return json({ events: [event()], lastSeq: 1, dropped: 0, reset: false });
      }
      return abortablePending(options.signal);
    }
    if (path.endsWith("/bridge/ack")) {
      order.push("ack");
      return json({ acked: 1, removed: 1, lastSeq: 1, size: 0 });
    }
    if (path.endsWith("/bridge/send")) {
      order.push("typing");
      return json({ ok: true, kind: "typing" });
    }
    throw new Error("unexpected request");
  }, async () => {
    const adapter = createContinuityDiscordAdapter(account());
    let acked;
    const ackSeen = new Promise(resolve => { acked = resolve; });
    adapter.onMessage = async message => {
      order.push("deliver");
      assert.equal(message.text, "hello");
    };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (...args) => {
      const response = await originalFetch(...args);
      if (new URL(args[0]).pathname.endsWith("/bridge/ack")) acked();
      return response;
    };
    try {
      await adapter.start();
      await ackSeen;
      await adapter.stop();
      assert.equal(adapter.isRunning(), false);
      assert.deepEqual(order, ["events", "typing", "deliver", "ack"]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("listener never acknowledges a delivery failure", async () => {
  let ackCalls = 0;
  let eventsCalls = 0;
  await withMockFetch(async (url, options = {}) => {
    const path = new URL(url).pathname;
    if (path.endsWith("/bridge/events")) {
      eventsCalls += 1;
      if (eventsCalls === 1) return json({ events: [event()], lastSeq: 1, dropped: 0, reset: false });
      return abortablePending(options.signal);
    }
    if (path.endsWith("/bridge/ack")) {
      ackCalls += 1;
      return json({ acked: 1 });
    }
    if (path.endsWith("/bridge/send")) return json({ ok: true, kind: "typing" });
    throw new Error("unexpected request");
  }, async () => {
    const adapter = createContinuityDiscordAdapter(account());
    adapter.onMessage = async () => { throw new Error("delivery failed"); };
    await adapter.start();
    await new Promise(resolve => setTimeout(resolve, 30));
    await adapter.stop();
    assert.equal(ackCalls, 0);
  });
});

test("listener accepts a reset cursor and processes the restarted queue", async () => {
  const delivered = [];
  const eventFive = event(5, { messageId: "555555555555555555", text: "before restart" });
  const eventOne = event(1, { messageId: "666666666666666666", text: "after restart" });
  let polls = 0;
  await withMockFetch(async (url, options = {}) => {
    const parsed = new URL(url);
    if (parsed.pathname.endsWith("/bridge/events")) {
      polls += 1;
      if (polls === 1) {
        assert.equal(parsed.searchParams.get("after"), "0");
        return json({ events: [eventFive], lastSeq: 5, dropped: 0, reset: false });
      }
      if (polls === 2) {
        assert.equal(parsed.searchParams.get("after"), "5");
        return json({ events: [eventOne], lastSeq: 1, dropped: 0, reset: true });
      }
      return abortablePending(options.signal);
    }
    if (parsed.pathname.endsWith("/bridge/ack")) {
      const body = JSON.parse(options.body);
      return json({ acked: body.seq, removed: 1, lastSeq: body.seq, size: 0 });
    }
    if (parsed.pathname.endsWith("/bridge/send")) return json({ ok: true, kind: "typing" });
    throw new Error("unexpected request");
  }, async () => {
    const adapter = createContinuityDiscordAdapter(account());
    let done;
    const both = new Promise(resolve => { done = resolve; });
    adapter.onMessage = async message => {
      delivered.push(message.text);
      if (delivered.length === 2) done();
    };
    await adapter.start();
    await both;
    await adapter.stop();
    assert.deepEqual(delivered, ["before restart", "after restart"]);
  });
});

test("adapter sends messages and reactions through the authenticated bridge", async () => {
  const bodies = [];
  await withMockFetch(async (_url, options = {}) => {
    bodies.push(JSON.parse(options.body));
    if (bodies.at(-1).kind === "send") return json({ ok: true, kind: "send", messageId: "777777777777777777", channelId: CHANNEL });
    return json({ ok: true, kind: "react" });
  }, async () => {
    const adapter = createContinuityDiscordAdapter(account());
    const sent = await adapter.sendMessage({ chatId: CHANNEL, text: "reply", replyToMessageId: MESSAGE });
    assert.equal(sent.messageId, "777777777777777777");
    await adapter.sendMessage({ chatId: CHANNEL, text: "", reaction: "👍", targetMessageId: MESSAGE });
  });
  assert.deepEqual(bodies, [
    { kind: "send", channel: CHANNEL, text: "reply", replyToMessageId: MESSAGE },
    { kind: "react", channel: CHANNEL, messageId: MESSAGE, emoji: "👍" },
  ]);
});
