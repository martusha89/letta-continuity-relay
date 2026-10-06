import test from "node:test";
import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  channelPlugin,
  createBotReplyLedger,
  createContinuityDiscordAdapter,
  createDiscordTypingController,
  ensureThreadRoute,
  mapBridgeEvent,
  parseAccountConfig,
} from "../deploy/continuity-listener/continuity-discord/plugin.mjs";

const CHANNEL = "222222222222222222";
const MESSAGE = "333333333333333333";
const USER = "444444444444444444";
const DM_CHANNEL = "555555555555555555";

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
      pending_poll_delay_ms: 10,
      ...overrides,
    },
  };
}

function isolatedAdapter(value = account()) {
  const directory = mkdtempSync(join(tmpdir(), "continuity-adapter-ledger-"));
  return createContinuityDiscordAdapter(value, {
    botReplyLedgerPath: join(directory, "source-ledger.json"),
  });
}

function runLedgerChild({ ledgerPath, action, messageId, startAt }) {
  const pluginUrl = pathToFileURL(join(process.cwd(), "deploy", "continuity-listener", "continuity-discord", "plugin.mjs")).href;
  const program = `
    const { createBotReplyLedger } = await import(process.argv[1]);
    const [ledgerPath, action, messageId, channelId, startAt] = process.argv.slice(2);
    while (Date.now() < Number(startAt)) {}
    const ledger = createBotReplyLedger({ filePath: ledgerPath, limit: 64 });
    try {
      const result = action === "reserve"
        ? ledger.reserve(messageId, channelId)
        : ledger.register(messageId, channelId, true);
      process.stdout.write(JSON.stringify({ ok: true, result }));
    } catch (error) {
      process.stdout.write(JSON.stringify({ ok: false, error: error.message }));
    }
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      "--input-type=module", "-e", program,
      pluginUrl, ledgerPath, action, messageId, CHANNEL, String(startAt),
    ], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", code => {
      if (code !== 0) return reject(new Error(`ledger child exited ${code}: ${stderr}`));
      try { resolve(JSON.parse(stdout)); } catch { reject(new Error(`invalid ledger child output: ${stdout} ${stderr}`)); }
    });
  });
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
      authorIsBot: false,
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
  assert.equal(parsed.deliveryConcurrency, 4);
  assert.equal(parsed.deliveryQuarantineLimit, 4);
  assert.equal(parsed.deliveryMaxUnresolved, 8);
  assert.equal(parsed.deliveryTimeoutMs, 30000);
  assert.equal(JSON.stringify(parsed).includes("Bearer"), false);
  assert.throws(() => parseAccountConfig(account({ base_url: "http://public.example.test" })), /HTTPS/);
  assert.doesNotThrow(() => parseAccountConfig(account({ base_url: "http://continuity-discord-bridge.railway.internal:8080" })));
  assert.throws(() => parseAccountConfig(account({ base_url: "https://u:p@example.test" })), /credentials/);
  assert.throws(() => parseAccountConfig(account({ auth: "short" })), /32 characters/);
});

test("custom channel plugin derives a portable identity, prefers YAML, and falls back to JSON", async () => {
  const root = await mkdtemp(join(tmpdir(), "continuity-discord-plugin-"));
  const directory = join(root, "continuity-discord");
  await mkdir(directory);
  const pluginPath = join(directory, "plugin.mjs");
  await copyFile(join(process.cwd(), "deploy", "continuity-listener", "continuity-discord", "plugin.mjs"), pluginPath);
  const parent = "555555555555555555";
  const thread = "666666666666666666";
  const fallbackThread = "777777777777777777";
  const routingPath = join(directory, "routing.json");
  await writeFile(routingPath, JSON.stringify({ routes: [] }));
  const yamlPath = join(directory, "routing.yaml");
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
  const portable = await import(`${pathToFileURL(pluginPath).href}?test=${Date.now()}`);
  assert.equal(portable.channelPlugin.metadata.id, "continuity-discord");
  assert.equal(portable.channelPlugin.metadata.displayName, "Continuity Discord");
  assert.equal(portable.ensureThreadRoute({ threadId: thread, parentChannelId: parent }, "continuity-main"), true);
  const saved = JSON.parse(await readFile(yamlPath, "utf8"));
  assert.equal(saved.routes.some(route => route.chatId === thread), true);
  assert.deepEqual(JSON.parse(await readFile(routingPath, "utf8")), { routes: [] });

  await rm(yamlPath);
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
  assert.equal(portable.ensureThreadRoute({ threadId: fallbackThread, parentChannelId: parent }, "continuity-main"), true);
  const fallback = JSON.parse(await readFile(routingPath, "utf8"));
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
  assert.equal(inbound.raw.discord.authorIsBot, false);
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

test("Discord DM typing targets the real DM channel rather than the user ID", async () => {
  const beats = [];
  const typing = createDiscordTypingController({
    sendTyping: async target => { beats.push(target); },
    refreshMs: 10,
    maxDurationMs: 100,
  });
  const source = {
    chatId: USER,
    chatType: "direct",
    threadId: null,
    messageId: MESSAGE,
    senderId: USER,
    raw: { discord: { channelId: DM_CHANNEL } },
  };
  typing.start(source);
  await new Promise(resolve => setTimeout(resolve, 2));
  // Under a loaded parallel suite the 10ms refresh timer may fire before this
  // 2ms assertion callback. Every beat must still target the DM channel.
  assert.ok(beats.length >= 1);
  assert.ok(beats.every(target => target === DM_CHANNEL));
  assert.equal(typing.isActive(DM_CHANNEL), true);
  assert.equal(typing.isActive(USER), false);
  typing.stop(source);
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

test("an old lock owned by a live process is never reclaimed as stale", async () => {
  const directory = await mkdtemp(join(tmpdir(), "continuity-discord-live-lock-"));
  const routingPath = join(directory, "routing.yaml");
  const lockPath = `${routingPath}.thread-route.lock`;
  await writeFile(routingPath, JSON.stringify({ routes: [] }));
  await mkdir(lockPath, { mode: 0o700 });
  await writeFile(join(lockPath, "owner.json"), `${JSON.stringify({
    token: "live-owner-token-1234567890",
    pid: process.pid,
    processIdentity: null,
  })}\n`, { mode: 0o600 });
  const old = new Date(Date.now() - 120_000);
  await utimes(lockPath, old, old);

  assert.throws(() => ensureThreadRoute({
    threadId: "666666666666666666",
    parentChannelId: "555555555555555555",
  }, "main", routingPath), /already in progress/);
  const owner = JSON.parse(await readFile(join(lockPath, "owner.json"), "utf8"));
  assert.equal(owner.token, "live-owner-token-1234567890");
});

test("adapter typing follows queued, processing, and finished lifecycle per current-run source", async () => {
  const typingBodies = [];
  const queuedEvents = [event(), event(2, { messageId: "555555555555555555" })];
  const delivered = [];
  let bothDelivered;
  const accepted = new Promise(resolve => { bothDelivered = resolve; });
  await withMockFetch(async (url, options = {}) => {
    const path = new URL(url).pathname;
    if (path.endsWith("/bridge/events")) {
      if (queuedEvents.length === 0) return abortablePending(options.signal);
      return json({ events: [...queuedEvents], lastSeq: 2, dropped: 0, reset: false });
    }
    if (path.endsWith("/bridge/ack")) {
      const body = JSON.parse(options.body);
      const index = queuedEvents.findIndex(item => item.seq === body.seq && item.message.messageId === body.messageId);
      if (index !== -1) queuedEvents.splice(index, 1);
      return json({ acked: body.seq, messageId: body.messageId, exact: true, removed: index === -1 ? 0 : 1, lastSeq: 2, size: queuedEvents.length });
    }
    if (path.endsWith("/bridge/send")) {
      typingBodies.push(JSON.parse(options.body));
      return json({ ok: true, kind: "typing" });
    }
    throw new Error("unexpected request");
  }, async () => {
    const adapter = isolatedAdapter(account({ typing_refresh_ms: 5, typing_max_duration_ms: 100 }));
    adapter.onMessage = async message => {
      delivered.push(message);
      if (delivered.length === 2) bothDelivered();
    };
    await adapter.start();
    try {
      await accepted;
      const [first, second] = delivered;
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
    } finally {
      await adapter.stop();
    }
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
      return json({ acked: 1, messageId: MESSAGE, exact: true, removed: 1, lastSeq: 1, size: 0 });
    }
    if (path.endsWith("/bridge/send")) {
      order.push("typing");
      return json({ ok: true, kind: "typing" });
    }
    throw new Error("unexpected request");
  }, async () => {
    const adapter = isolatedAdapter();
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

test("timed-out deliveries preserve progress but keep total unresolved work bounded", async () => {
  const events = [
    event(1, { messageId: "555555555555555551", channel: "666666666666666661", channelId: "666666666666666661", text: "hang one" }),
    event(2, { messageId: "555555555555555552", channel: "666666666666666662", channelId: "666666666666666662", text: "hang two" }),
    event(3, { messageId: "555555555555555553", channel: "666666666666666663", channelId: "666666666666666663", text: "progress after timeout" }),
    event(4, { messageId: "555555555555555554", channel: "666666666666666664", channelId: "666666666666666664", text: "must stay bounded" }),
  ];
  const started = [];
  const typingBodies = [];
  const logs = [];
  let thirdStarted;
  const progress = new Promise(resolve => { thirdStarted = resolve; });
  await withMockFetch(async (url, options = {}) => {
    const path = new URL(url).pathname;
    if (path.endsWith("/bridge/events")) {
      return json({ events, lastSeq: 4, dropped: 0, reset: false });
    }
    if (path.endsWith("/bridge/ack")) throw new Error("hung deliveries must not be acknowledged");
    if (path.endsWith("/bridge/send")) {
      typingBodies.push(JSON.parse(options.body));
      return json({ ok: true, kind: "typing" });
    }
    throw new Error("unexpected request");
  }, async () => {
    const adapter = isolatedAdapter(account({
      delivery_concurrency: 2,
      delivery_quarantine_limit: 1,
      delivery_timeout_ms: 100,
      typing_refresh_ms: 20,
      typing_max_duration_ms: 5000,
    }));
    adapter.onMessage = async message => {
      started.push(message.text);
      if (message.text === "progress after timeout") thirdStarted();
      return new Promise(() => {});
    };
    await adapter.start({ logger: line => logs.push(line) });
    await Promise.race([
      progress,
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout did not release reserved progress capacity")), 1000)),
    ]);
    assert.deepEqual(started, ["hang one", "hang two", "progress after timeout"]);
    await new Promise(resolve => setTimeout(resolve, 400));
    assert.equal(started.includes("must stay bounded"), false, "total unresolved calls must never exceed concurrency plus quarantine budget");
    assert.ok(logs.some(line => line.includes("quarantined, acknowledgement deferred until delivery completes")));
    assert.ok(logs.some(line => line.includes("quarantine full, active slot retained")));
    const typingAfterTimeout = typingBodies.length;
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.equal(typingBodies.length, typingAfterTimeout, "typing refresh must stop when delivery crosses its timeout");
    await adapter.stop();
  });
});

test("a quarantined delivery can finish later and acknowledge exactly once", async () => {
  const pendingEvent = event(1, { messageId: "666666666666666671", text: "slow but finite" });
  let acknowledged = false;
  let attempts = 0;
  const acknowledgements = [];
  let resolveDelivery;
  const delayedDelivery = new Promise(resolve => { resolveDelivery = resolve; });
  let timeoutSeen;
  const crossedTimeout = new Promise(resolve => { timeoutSeen = resolve; });
  let ackSeen;
  const exactAck = new Promise(resolve => { ackSeen = resolve; });

  await withMockFetch(async (url, options = {}) => {
    const path = new URL(url).pathname;
    if (path.endsWith("/bridge/events")) {
      if (acknowledged) return abortablePending(options.signal);
      return json({ events: [pendingEvent], lastSeq: 1, dropped: 0, reset: false });
    }
    if (path.endsWith("/bridge/ack")) {
      const body = JSON.parse(options.body);
      acknowledgements.push(body);
      acknowledged = true;
      ackSeen();
      return json({ acked: 1, messageId: body.messageId, exact: true, removed: 1, lastSeq: 1, size: 0 });
    }
    if (path.endsWith("/bridge/send")) return json({ ok: true, kind: "typing" });
    throw new Error("unexpected request");
  }, async () => {
    const adapter = isolatedAdapter(account({
      delivery_concurrency: 2,
      delivery_quarantine_limit: 1,
      delivery_timeout_ms: 100,
    }));
    adapter.onMessage = async () => {
      attempts += 1;
      return delayedDelivery;
    };
    await adapter.start({
      logger: line => {
        if (line.includes("acknowledgement deferred until delivery completes")) timeoutSeen();
      },
    });
    try {
      await Promise.race([
        crossedTimeout,
        new Promise((_, reject) => setTimeout(() => reject(new Error("delivery did not cross timeout")), 1000)),
      ]);
      await new Promise(resolve => setTimeout(resolve, 300));
      assert.equal(attempts, 1, "pending quarantined delivery must suppress concurrent retries");

      resolveDelivery();
      await Promise.race([
        exactAck,
        new Promise((_, reject) => setTimeout(() => reject(new Error("completed quarantined delivery remained wedged")), 1000)),
      ]);
      await new Promise(resolve => setTimeout(resolve, 300));
      assert.equal(attempts, 1, "successful exact ACK must prevent redelivery");
      assert.deepEqual(acknowledgements, [{ seq: 1, messageId: pendingEvent.message.messageId, exact: true }]);
    } finally {
      await adapter.stop();
    }
  });
});

test("listener treats an exact acknowledgement with removed zero as a delivery failure", async () => {
  const logs = [];
  let polls = 0;
  await withMockFetch(async (url, options = {}) => {
    const path = new URL(url).pathname;
    if (path.endsWith("/bridge/events")) {
      polls += 1;
      if (polls === 1) return json({ events: [event()], lastSeq: 1, dropped: 0, reset: false });
      return abortablePending(options.signal);
    }
    if (path.endsWith("/bridge/ack")) {
      const body = JSON.parse(options.body);
      return json({ acked: body.seq, messageId: body.messageId, exact: true, removed: 0, lastSeq: 1, size: 0 });
    }
    if (path.endsWith("/bridge/send")) return json({ ok: true, kind: "typing" });
    throw new Error("unexpected request");
  }, async () => {
    const adapter = isolatedAdapter();
    adapter.onMessage = async () => {};
    await adapter.start({ logger: line => logs.push(line) });
    await new Promise(resolve => setTimeout(resolve, 40));
    await adapter.stop();
  });
  assert.ok(logs.some(line => line.includes("delivery seq=1 failed")), "removed=0 must not be accepted as ACK success");
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
    const adapter = isolatedAdapter();
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
        assert.equal(parsed.searchParams.get("after"), "0");
        return json({ events: [eventOne], lastSeq: 1, dropped: 0, reset: true });
      }
      return abortablePending(options.signal);
    }
    if (parsed.pathname.endsWith("/bridge/ack")) {
      const body = JSON.parse(options.body);
      return json({ acked: body.seq, messageId: body.messageId, exact: true, removed: 1, lastSeq: body.seq, size: 0 });
    }
    if (parsed.pathname.endsWith("/bridge/send")) return json({ ok: true, kind: "typing" });
    throw new Error("unexpected request");
  }, async () => {
    const adapter = isolatedAdapter();
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

test("stop/start generation reset permits sequence reuse and blocks late old acknowledgements", async () => {
  const oldEvent = event(1, {
    messageId: "777777777777777771",
    channel: USER,
    channelId: DM_CHANNEL,
    chatType: "direct",
    guildId: null,
    guildName: null,
    channelName: null,
    text: "old unresolved delivery",
  });
  const newEvent = event(1, {
    messageId: "777777777777777772",
    channel: USER,
    channelId: USER,
    chatType: "channel",
    text: "new generation delivery",
  });
  let phase = 1;
  let newAcknowledged = false;
  const acknowledgements = [];
  const outbound = [];
  let oldStarted;
  const oldWasStarted = new Promise(resolve => { oldStarted = resolve; });
  let resolveOld;
  const oldDelivery = new Promise(resolve => { resolveOld = resolve; });
  let ackNew;
  const newWasAcknowledged = new Promise(resolve => { ackNew = resolve; });
  await withMockFetch(async (url, options = {}) => {
    const path = new URL(url).pathname;
    if (path.endsWith("/bridge/events")) {
      if (phase === 1) return json({ events: [oldEvent], lastSeq: 1, dropped: 0, reset: false });
      if (!newAcknowledged) return json({ events: [newEvent], lastSeq: 1, dropped: 0, reset: true });
      return abortablePending(options.signal);
    }
    if (path.endsWith("/bridge/ack")) {
      const body = JSON.parse(options.body);
      acknowledgements.push(body);
      if (body.messageId !== newEvent.message.messageId) throw new Error("stopped generation attempted a stale ACK");
      newAcknowledged = true;
      ackNew();
      return json({ acked: 1, messageId: body.messageId, exact: true, removed: 1, lastSeq: 1, size: 0 });
    }
    if (path.endsWith("/bridge/send")) {
      const body = JSON.parse(options.body);
      if (body.kind === "send" || body.kind === "send_dm") outbound.push(body);
      return body.kind === "send"
        ? json({ ok: true, kind: "send", messageId: "888888888888888881", channelId: USER })
        : json({ ok: true, kind: body.kind });
    }
    throw new Error("unexpected request");
  }, async () => {
    const adapter = isolatedAdapter();
    adapter.onMessage = async message => {
      if (message.text === "old unresolved delivery") {
        oldStarted();
        return oldDelivery;
      }
      await adapter.sendDirectReply(message.chatId, "new generation reply");
    };

    await adapter.start();
    await oldWasStarted;
    await adapter.stop();
    phase = 2;
    await adapter.start();
    await Promise.race([
      newWasAcknowledged,
      new Promise((_, reject) => setTimeout(() => reject(new Error("new generation remained blocked by stale key")), 1000)),
    ]);
    resolveOld();
    await new Promise(resolve => setTimeout(resolve, 50));
    await adapter.stop();
  });

  assert.deepEqual(acknowledgements, [{ seq: 1, messageId: newEvent.message.messageId, exact: true }]);
  assert.deepEqual(outbound, [{ kind: "send", channel: USER, text: "new generation reply" }], "old DM channel cache must not leak into the restarted generation");
});

test("adapter sends channel messages, direct messages, and reactions through the authenticated bridge", async () => {
  const bodies = [];
  const root = await mkdtemp(join(tmpdir(), "continuity-human-source-"));
  const ledgerPath = join(root, "source-ledger.json");
  createBotReplyLedger({ filePath: ledgerPath }).register(MESSAGE, CHANNEL, false);
  await withMockFetch(async (_url, options = {}) => {
    bodies.push(JSON.parse(options.body));
    if (bodies.at(-1).kind === "send") return json({ ok: true, kind: "send", messageId: "777777777777777777", channelId: CHANNEL });
    if (bodies.at(-1).kind === "send_dm") return json({ ok: true, kind: "send_dm", messageId: "777777777777777778", channelId: DM_CHANNEL });
    return json({ ok: true, kind: "react" });
  }, async () => {
    const adapter = createContinuityDiscordAdapter(account(), { botReplyLedgerPath: ledgerPath });
    const sent = await adapter.sendMessage({ chatId: CHANNEL, text: "reply", replyToMessageId: MESSAGE });
    assert.equal(sent.messageId, "777777777777777777");
    const direct = await adapter.sendMessage({ chatId: USER, chatType: "direct", text: "private reply" });
    assert.equal(direct.messageId, "777777777777777778");
    await adapter.sendMessage({ chatId: CHANNEL, text: "", reaction: "👍", targetMessageId: MESSAGE });
  });
  assert.deepEqual(bodies, [
    { kind: "send", channel: CHANNEL, text: "reply", replyToMessageId: MESSAGE },
    { kind: "send_dm", userId: USER, text: "private reply" },
    { kind: "react", channel: CHANNEL, messageId: MESSAGE, emoji: "👍" },
  ]);
});

test("bot reply ledger is persistent, route-bound, and at-most-once across instances", async () => {
  const root = await mkdtemp(join(tmpdir(), "continuity-bot-ledger-"));
  const ledgerPath = join(root, "bot-reply-ledger.json");
  const first = createBotReplyLedger({ filePath: ledgerPath });
  first.register(MESSAGE, CHANNEL, true);
  assert.equal(first.reserve(MESSAGE, CHANNEL), true);
  assert.throws(() => first.reserve(MESSAGE, CHANNEL), /already used its one outbound response/);

  const afterRestart = createBotReplyLedger({ filePath: ledgerPath });
  assert.equal(afterRestart.inspect(MESSAGE).status, "reserved");
  assert.throws(() => afterRestart.reserve(MESSAGE, CHANNEL), /already used its one outbound response/);
  assert.throws(() => afterRestart.reserve(MESSAGE, "666666666666666666"), /route mismatch/);

  afterRestart.release(MESSAGE);
  assert.equal(afterRestart.reserve(MESSAGE, CHANNEL), true);
  afterRestart.complete(MESSAGE);
  assert.equal(createBotReplyLedger({ filePath: ledgerPath }).inspect(MESSAGE).status, "sent");
  assert.throws(() => afterRestart.reserve(MESSAGE, CHANNEL), /already used its one outbound response/);
});

test("source ledger expiry and capacity fail closed without evicting live classifications", async () => {
  const root = await mkdtemp(join(tmpdir(), "continuity-source-ledger-bounds-"));
  const ledgerPath = join(root, "source-ledger.json");
  let timestamp = 1000;
  const ledger = createBotReplyLedger({ filePath: ledgerPath, ttlMs: 10, limit: 1, now: () => timestamp });
  ledger.register(MESSAGE, CHANNEL, false);
  assert.throws(
    () => ledger.register("333333333333333334", CHANNEL, true),
    /source ledger is full/,
  );
  assert.equal(ledger.reserve(MESSAGE, CHANNEL), false, "live human classification must remain intact");
  timestamp += 11;
  assert.throws(
    () => ledger.reserve(MESSAGE, CHANNEL),
    /source classification is unavailable/,
    "an expired origin must not silently fall back to a human turn",
  );
});

test("source ledger serializes reservations and mutations across processes", async () => {
  const root = await mkdtemp(join(tmpdir(), "continuity-source-ledger-processes-"));
  const reservePath = join(root, "reserve.json");
  createBotReplyLedger({ filePath: reservePath, limit: 64 }).register(MESSAGE, CHANNEL, true);
  const reserveStart = Date.now() + 750;
  const reservations = await Promise.all([
    runLedgerChild({ ledgerPath: reservePath, action: "reserve", messageId: MESSAGE, startAt: reserveStart }),
    runLedgerChild({ ledgerPath: reservePath, action: "reserve", messageId: MESSAGE, startAt: reserveStart }),
  ]);
  assert.equal(reservations.filter(result => result.ok).length, 1);
  assert.equal(reservations.filter(result => !result.ok && /already used/.test(result.error)).length, 1);

  const registerPath = join(root, "register.json");
  const registerStart = Date.now() + 750;
  const ids = Array.from({ length: 8 }, (_, index) => `3333333333333333${String(40 + index)}`);
  const registrations = await Promise.all(ids.map(messageId =>
    runLedgerChild({ ledgerPath: registerPath, action: "register", messageId, startAt: registerStart })
  ));
  assert.ok(registrations.every(result => result.ok));
  const persisted = JSON.parse(await readFile(registerPath, "utf8"));
  assert.deepEqual(Object.keys(persisted.entries).sort(), ids.sort());
});

test("bot-origin response omits reply ping/reference and blocks every second outbound action", async () => {
  const root = await mkdtemp(join(tmpdir(), "continuity-bot-response-"));
  const ledgerPath = join(root, "bot-reply-ledger.json");
  const ledger = createBotReplyLedger({ filePath: ledgerPath });
  ledger.register(MESSAGE, CHANNEL, true);
  const bodies = [];
  await withMockFetch(async (_url, options = {}) => {
    bodies.push(JSON.parse(options.body));
    return json({ ok: true, kind: "send", messageId: "777777777777777777", channelId: CHANNEL });
  }, async () => {
    const adapter = createContinuityDiscordAdapter(account(), { botReplyLedgerPath: ledgerPath });
    const firstSend = adapter.sendMessage({ chatId: CHANNEL, text: "one shot", replyToMessageId: MESSAGE });
    await assert.rejects(
      adapter.sendMessage({ chatId: CHANNEL, text: "parallel second shot", replyToMessageId: MESSAGE }),
      /already used its one outbound response/,
    );
    await firstSend;
  });
  assert.deepEqual(bodies, [{ kind: "send", channel: CHANNEL, text: "one shot" }]);
  assert.equal(createBotReplyLedger({ filePath: ledgerPath }).inspect(MESSAGE).status, "sent");
});

test("known failed bot-origin send releases its reservation for one safe retry", async () => {
  const root = await mkdtemp(join(tmpdir(), "continuity-bot-retry-"));
  const ledgerPath = join(root, "bot-reply-ledger.json");
  createBotReplyLedger({ filePath: ledgerPath }).register(MESSAGE, CHANNEL, true);
  let attempts = 0;
  await withMockFetch(async () => {
    attempts += 1;
    if (attempts === 1) return json({ error: "send_failed", message: "rejected" }, 422);
    return json({ ok: true, kind: "send", messageId: "777777777777777777", channelId: CHANNEL });
  }, async () => {
    const adapter = createContinuityDiscordAdapter(account(), { botReplyLedgerPath: ledgerPath });
    await assert.rejects(
      adapter.sendMessage({ chatId: CHANNEL, text: "retry me", replyToMessageId: MESSAGE }),
      /HTTP 422/,
    );
    assert.equal(createBotReplyLedger({ filePath: ledgerPath }).inspect(MESSAGE).status, "available");
    await adapter.sendMessage({ chatId: CHANNEL, text: "retry me", replyToMessageId: MESSAGE });
  });
  assert.equal(attempts, 2);
  assert.equal(createBotReplyLedger({ filePath: ledgerPath }).inspect(MESSAGE).status, "sent");
});

test("ambiguous bot-origin transport failure preserves the reservation", async () => {
  const root = await mkdtemp(join(tmpdir(), "continuity-bot-ambiguous-"));
  const ledgerPath = join(root, "bot-reply-ledger.json");
  createBotReplyLedger({ filePath: ledgerPath }).register(MESSAGE, CHANNEL, true);
  let attempts = 0;
  await withMockFetch(async () => {
    attempts += 1;
    throw new Error("connection reset after write");
  }, async () => {
    const adapter = createContinuityDiscordAdapter(account(), { botReplyLedgerPath: ledgerPath });
    await assert.rejects(
      adapter.sendMessage({ chatId: CHANNEL, text: "possibly delivered", replyToMessageId: MESSAGE }),
      /connection reset after write/,
    );
    assert.equal(createBotReplyLedger({ filePath: ledgerPath }).inspect(MESSAGE).status, "reserved");
    await assert.rejects(
      adapter.sendMessage({ chatId: CHANNEL, text: "must not duplicate", replyToMessageId: MESSAGE }),
      /already used its one outbound response/,
    );
  });
  assert.equal(attempts, 1);
});
