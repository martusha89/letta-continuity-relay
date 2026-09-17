import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CHANNEL_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const CHANNEL_ID = path.basename(CHANNEL_DIRECTORY);
const CHANNEL_DISPLAY_NAME = "Continuity Discord";
const LOG_PREFIX = `[${CHANNEL_ID}]`;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const SNOWFLAKE = /^\d{17,20}$/;
const LEGACY_ACCOUNT_ID = "default";
const TYPING_REFRESH_MS = 8_000;
const TYPING_MAX_DURATION_MS = 15 * 60_000;

function defaultRoutingPath() {
  const candidates = ["routing.json", "routing.yaml"].map(name => path.join(CHANNEL_DIRECTORY, name));
  return candidates.find(candidate => fs.existsSync(candidate)) ?? candidates[0];
}

function normalizedAccountId(value) {
  return typeof value === "string" && value.trim() ? value.trim() : LEGACY_ACCOUNT_ID;
}

function typingTarget(source) {
  const target = source?.threadId?.trim() || source?.chatId?.trim();
  return SNOWFLAKE.test(target ?? "") ? target : null;
}

function typingSourceKey(source) {
  return [
    source?.chatId ?? "",
    source?.threadId ?? "",
    source?.messageId ?? "",
    source?.senderId ?? "",
  ].join(":");
}

/**
 * Lifecycle-owned Discord typing state. Each inbound source holds its own
 * lease, while sources sharing a channel reuse one refresh timer. Finishing
 * one turn therefore cannot cancel typing for another queued turn.
 */
export function createDiscordTypingController(options) {
  const refreshMs = options?.refreshMs ?? TYPING_REFRESH_MS;
  const maxDurationMs = options?.maxDurationMs ?? TYPING_MAX_DURATION_MS;
  const log = typeof options?.log === "function" ? options.log : () => {};
  if (typeof options?.sendTyping !== "function") throw new Error("Discord typing sender is required");
  if (!Number.isInteger(refreshMs) || refreshMs < 1) throw new Error("Discord typing refresh interval is invalid");
  if (!Number.isInteger(maxDurationMs) || maxDurationMs < refreshMs) throw new Error("Discord typing duration is invalid");

  const targets = new Map();

  const clearTarget = target => {
    const active = targets.get(target);
    if (!active) return;
    clearInterval(active.refreshTimer);
    for (const expiry of active.sources.values()) clearTimeout(expiry);
    targets.delete(target);
  };

  const beat = target => {
    void options.sendTyping(target).catch(() => log(`${LOG_PREFIX} typing refresh failed`));
  };

  const stop = source => {
    const target = typingTarget(source);
    if (!target) return;
    const active = targets.get(target);
    if (!active) return;
    const key = typingSourceKey(source);
    const expiry = active.sources.get(key);
    if (expiry) clearTimeout(expiry);
    active.sources.delete(key);
    if (active.sources.size > 0) return;
    clearTarget(target);
  };

  const start = source => {
    const target = typingTarget(source);
    if (!target) return;
    const key = typingSourceKey(source);
    let active = targets.get(target);
    if (!active) {
      beat(target);
      const refreshTimer = setInterval(() => beat(target), refreshMs);
      refreshTimer.unref?.();
      active = { refreshTimer, sources: new Map() };
      targets.set(target, active);
    }
    const previousExpiry = active.sources.get(key);
    if (previousExpiry) clearTimeout(previousExpiry);
    const expiry = setTimeout(() => {
      stop(source);
      log(`${LOG_PREFIX} typing lease expired`);
    }, maxDurationMs);
    expiry.unref?.();
    active.sources.set(key, expiry);
  };

  return {
    start,
    stop,
    stopTarget(target) {
      if (SNOWFLAKE.test(target ?? "")) clearTarget(target);
    },
    stopAll() {
      for (const target of [...targets.keys()]) clearTarget(target);
    },
    isActive(target) { return targets.has(target); },
    activeSourceCount(target) { return targets.get(target)?.sources.size ?? 0; },
  };
}

/**
 * Create an exact Letta route for a newly observed Discord thread by cloning
 * its already-approved parent route. Letta's route registry is exact-match;
 * writing before onMessage lets the registry's route-miss reload see the new
 * entry without restarting the listener.
 */
export function ensureThreadRoute(message, accountId, routingPath = defaultRoutingPath()) {
  if (!message || !SNOWFLAKE.test(message.threadId ?? "") || !SNOWFLAKE.test(message.parentChannelId ?? "")) {
    return false;
  }
  const lockPath = `${routingPath}.thread-route.lock`;
  let lockFd;
  let ownsLock = false;
  try {
    try {
      lockFd = fs.openSync(lockPath, "wx", 0o600);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const lock = fs.lstatSync(lockPath);
      if (!lock.isFile() || lock.isSymbolicLink() || Date.now() - lock.mtimeMs < 60_000) {
        throw new Error("Discord route update is already in progress");
      }
      fs.unlinkSync(lockPath);
      lockFd = fs.openSync(lockPath, "wx", 0o600);
    }
    ownsLock = true;
    fs.writeFileSync(lockFd, `${process.pid}\n`, "utf8");
    fs.fsyncSync(lockFd);

    const existingFile = fs.lstatSync(routingPath);
    if (!existingFile.isFile() || existingFile.isSymbolicLink()) {
      throw new Error("Discord routing path is not a regular file");
    }
    if (typeof process.getuid === "function" && existingFile.uid !== process.getuid()) {
      throw new Error("Discord routing file has an unexpected owner");
    }
    if ((existingFile.mode & 0o022) !== 0) {
      throw new Error("Discord routing file is writable by another user");
    }

    const parsed = JSON.parse(fs.readFileSync(routingPath, "utf8"));
    if (!parsed || !Array.isArray(parsed.routes)) throw new Error("Discord routing file is invalid");
    const targetAccount = normalizedAccountId(accountId);
    const sameAccount = route => normalizedAccountId(route?.accountId) === targetAccount;
    const parent = parsed.routes.find(route =>
      sameAccount(route) &&
      route?.chatId === message.parentChannelId &&
      route?.chatType === "channel" &&
      (route?.threadId ?? null) === null &&
      route?.enabled !== false &&
      route?.outboundEnabled !== false
    );
    const exact = parsed.routes.find(route =>
      sameAccount(route) &&
      route?.chatId === message.threadId &&
      (route?.threadId ?? null) === null
    );
    if (!parent || typeof parent.agentId !== "string" || typeof parent.conversationId !== "string") {
      if (exact) throw new Error("Existing Discord thread route has no approved parent route");
      return false;
    }
    if (exact) {
      const valid = exact.chatType === "channel" &&
        exact.enabled !== false &&
        exact.outboundEnabled !== false &&
        exact.agentId === parent.agentId &&
        exact.conversationId === parent.conversationId &&
        (exact.detached === true) === (parent.detached === true);
      if (!valid) throw new Error("Existing Discord thread route conflicts with its approved parent");
      return false;
    }
    const now = new Date().toISOString();
    parsed.routes.push({
      ...parent,
      accountId: targetAccount,
      chatId: message.threadId,
      chatType: "channel",
      threadId: null,
      enabled: true,
      outboundEnabled: true,
      createdAt: now,
      updatedAt: now,
    });

    const temporaryPath = `${routingPath}.tmp-${process.pid}-${crypto.randomUUID()}`;
    let temporaryFd;
    try {
      temporaryFd = fs.openSync(temporaryPath, "wx", existingFile.mode & 0o777);
      fs.writeFileSync(temporaryFd, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
      fs.fsyncSync(temporaryFd);
      fs.closeSync(temporaryFd);
      temporaryFd = undefined;

      const unchanged = fs.lstatSync(routingPath);
      if (unchanged.ino !== existingFile.ino || unchanged.size !== existingFile.size || unchanged.mtimeMs !== existingFile.mtimeMs) {
        throw new Error("Discord routing file changed during thread provisioning");
      }
      fs.renameSync(temporaryPath, routingPath);
      const directoryFd = fs.openSync(path.dirname(routingPath), "r");
      try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
    } finally {
      if (temporaryFd !== undefined) fs.closeSync(temporaryFd);
      try { fs.unlinkSync(temporaryPath); } catch {}
    }
    return true;
  } finally {
    if (lockFd !== undefined) fs.closeSync(lockFd);
    if (ownsLock) {
      try { fs.unlinkSync(lockPath); } catch {}
    }
  }
}

export function parseAccountConfig(account) {
  const raw = account?.config;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Discord bridge configuration is missing");
  }
  if (typeof raw.base_url !== "string" || raw.base_url.trim().length === 0) {
    throw new Error("Discord bridge base_url is required");
  }
  let url;
  try {
    url = new URL(raw.base_url.trim());
  } catch {
    throw new Error("Discord bridge base_url is invalid");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("Discord bridge base_url must not contain credentials, query, or fragment");
  }
  const hostname = url.hostname.toLowerCase();
  const localHttp = url.protocol === "http:" &&
    (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname.endsWith(".railway.internal"));
  if (url.protocol !== "https:" && !localHttp) {
    throw new Error("Discord bridge base_url must use HTTPS or an approved private host");
  }
  if (typeof raw.auth !== "string" || raw.auth.trim().length < 32) {
    throw new Error("Discord bridge auth must be at least 32 characters");
  }
  const integer = (name, fallback, min, max) => {
    const value = raw[name] === undefined ? fallback : raw[name];
    if (!Number.isInteger(value) || value < min || value > max) {
      throw new Error(`Discord bridge ${name} is invalid`);
    }
    return value;
  };
  const typingRefreshMs = integer("typing_refresh_ms", TYPING_REFRESH_MS, 5, 60_000);
  const typingMaxDurationMs = integer("typing_max_duration_ms", TYPING_MAX_DURATION_MS, 10, 60 * 60_000);
  if (typingMaxDurationMs < typingRefreshMs) {
    throw new Error("Discord bridge typing_max_duration_ms must be at least typing_refresh_ms");
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  return {
    baseUrl: url.toString().replace(/\/$/, ""),
    bearerToken: raw.auth.trim(),
    pollWait: raw.poll_wait !== false,
    requestTimeoutMs: integer("request_timeout_ms", 30000, 1000, 120000),
    minBackoffMs: integer("min_backoff_ms", 500, 100, 30000),
    maxBackoffMs: integer("max_backoff_ms", 10000, 500, 120000),
    typingRefreshMs,
    typingMaxDurationMs,
  };
}

function cleanLabel(value, fallback) {
  if (typeof value !== "string" || value.length === 0) return fallback;
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 160);
}

function attachmentNote(attachments) {
  if (!Array.isArray(attachments) || attachments.length === 0) return "";
  const lines = attachments.slice(0, 10).map(item => {
    const name = cleanLabel(item?.name, "attachment");
    const type = cleanLabel(item?.contentType, "unknown type");
    const size = Number.isInteger(item?.size) && item.size >= 0 ? `${item.size} bytes` : "unknown size";
    return `- ${name} (${type}, ${size})`;
  });
  return `Attachments:\n${lines.join("\n")}`;
}

export function mapBridgeEvent(event, accountId) {
  if (!event || !Number.isInteger(event.seq) || event.seq < 1 || !event.message || typeof event.message !== "object") {
    throw new Error("Invalid Discord bridge event");
  }
  const message = event.message;
  if (!SNOWFLAKE.test(message.messageId) || !SNOWFLAKE.test(message.channel) || !SNOWFLAKE.test(message.authorId)) {
    throw new Error("Invalid Discord bridge event identity");
  }
  if (message.chatType !== "direct" && message.chatType !== "channel") {
    throw new Error("Invalid Discord bridge chat type");
  }
  const timestamp = Date.parse(message.timestamp);
  if (!Number.isFinite(timestamp)) throw new Error("Invalid Discord bridge timestamp");
  const note = attachmentNote(message.attachments);
  const text = [typeof message.text === "string" ? message.text : "", note].filter(Boolean).join("\n\n");
  const channelLabel = message.channelName ? `#${cleanLabel(message.channelName, message.channel)}` : message.channel;
  const guildLabel = message.guildName ? cleanLabel(message.guildName, message.guildId ?? "Discord") : "Discord DM";
  const safeAttachments = Array.isArray(message.attachments) ? message.attachments.slice(0, 10).map(item => ({
    id: item?.id,
    name: cleanLabel(item?.name, "attachment"),
    contentType: typeof item?.contentType === "string" ? item.contentType : null,
    size: Number.isInteger(item?.size) ? item.size : null,
  })) : [];
  return {
    channel: CHANNEL_ID,
    accountId,
    chatId: message.channel,
    senderId: message.authorId,
    senderName: cleanLabel(message.authorName, message.authorId),
    chatLabel: `${guildLabel} ${channelLabel}`,
    text,
    timestamp,
    messageId: message.messageId,
    threadId: null,
    chatType: message.chatType,
    isMention: message.isMention === true,
    routedBy: message.chatType === "direct" ? "dm" : message.threadId ? "thread" : "mention",
    ...(message.parentChannelId ? { parentChannelId: message.parentChannelId } : {}),
    raw: {
      discord: {
        guildId: message.guildId ?? null,
        guildName: message.guildName ?? null,
        channelId: message.channelId,
        channelName: message.channelName ?? null,
        threadId: message.threadId ?? null,
        parentChannelId: message.parentChannelId ?? null,
        attachments: safeAttachments,
      },
      bridgeSeq: event.seq,
    },
  };
}

async function readJsonBounded(response, maxBytes = MAX_RESPONSE_BYTES) {
  const declared = response.headers.get("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) {
    throw new Error("Discord bridge response exceeded limit");
  }
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error("Discord bridge response exceeded limit");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error("Discord bridge returned invalid JSON");
  }
}

function combinedAbort(parentSignal, timeoutMs) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (parentSignal?.aborted) controller.abort();
  else parentSignal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, timeoutMs);
  return {
    signal: controller.signal,
    cleanup() {
      clearTimeout(timer);
      parentSignal?.removeEventListener("abort", abort);
    },
  };
}

async function requestJson(config, path, options = {}, parentSignal) {
  const abort = combinedAbort(parentSignal, config.requestTimeoutMs);
  try {
    const response = await fetch(`${config.baseUrl}${path}`, {
      ...options,
      signal: abort.signal,
      headers: {
        Authorization: `Bearer ${config.bearerToken}`,
        Accept: "application/json",
        ...(options.body ? { "Content-Type": "application/json" } : {}),
      },
    });
    if (!response.ok) throw new Error(`Discord bridge request failed (HTTP ${response.status})`);
    return await readJsonBounded(response);
  } finally {
    abort.cleanup();
  }
}

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason ?? new Error("aborted"));
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("aborted"));
    }, { once: true });
  });
}

export function createContinuityDiscordAdapter(account) {
  const config = parseAccountConfig(account);
  let running = false;
  let controller = null;
  let loopPromise = null;
  let cursor = 0;
  let startupLogger = () => {};
  const typing = createDiscordTypingController({
    sendTyping: async channel => {
      await requestJson(config, "/bridge/send", {
        method: "POST",
        body: JSON.stringify({ kind: "typing", channel }),
      }, controller?.signal);
    },
    log: line => startupLogger(line),
    refreshMs: config.typingRefreshMs,
    maxDurationMs: config.typingMaxDurationMs,
  });

  const adapter = {
    id: `${CHANNEL_ID}:${account.accountId}`,
    channelId: CHANNEL_ID,
    accountId: account.accountId,
    name: account.displayName ?? CHANNEL_DISPLAY_NAME,
    onMessage: undefined,

    async start(options = {}) {
      if (running) return;
      running = true;
      startupLogger = typeof options.logger === "function" ? options.logger : () => {};
      controller = new AbortController();
      startupLogger(`${LOG_PREFIX} bridge listener started`);
      loopPromise = pollLoop(controller.signal);
    },

    async stop() {
      if (!running) return;
      running = false;
      typing.stopAll();
      controller?.abort();
      try { await loopPromise; } catch {}
      startupLogger(`${LOG_PREFIX} bridge listener stopped`);
    },

    isRunning() { return running; },

    async handleTurnLifecycleEvent(event) {
      if (!running) return;
      if (event.type === "queued") {
        typing.start(event.source);
        return;
      }
      if (event.type === "processing") {
        for (const source of event.sources) typing.start(source);
        return;
      }
      for (const source of event.sources) typing.stop(source);
    },

    async sendMessage(message) {
      const target = message.threadId?.trim() || message.chatId;
      if (!SNOWFLAKE.test(target)) throw new Error("Discord bridge target is invalid");
      if (message.reaction) {
        if (!message.targetMessageId || !SNOWFLAKE.test(message.targetMessageId)) {
          throw new Error("Discord bridge reaction message ID is invalid");
        }
        await requestJson(config, "/bridge/send", {
          method: "POST",
          body: JSON.stringify({ kind: "react", channel: target, messageId: message.targetMessageId, emoji: message.reaction }),
        });
        return { messageId: message.targetMessageId };
      }
      const result = await requestJson(config, "/bridge/send", {
        method: "POST",
        body: JSON.stringify({
          kind: "send",
          channel: target,
          text: message.text,
          ...(message.replyToMessageId ? { replyToMessageId: message.replyToMessageId } : {}),
        }),
      });
      if (!result || !SNOWFLAKE.test(result.messageId)) throw new Error("Discord bridge returned an invalid message ID");
      typing.stopTarget(target);
      return { messageId: result.messageId };
    },

    async sendDirectReply(chatId, text, options = {}) {
      await adapter.sendMessage({ chatId, text, replyToMessageId: options.replyToMessageId, threadId: options.threadId });
    },
  };

  async function pollLoop(signal) {
    let backoff = config.minBackoffMs;
    while (!signal.aborted) {
      try {
        const result = await requestJson(config, `/bridge/events?after=${cursor}&wait=${config.pollWait ? "1" : "0"}`, {}, signal);
        if (!result || !Array.isArray(result.events) || !Number.isInteger(result.lastSeq) || typeof result.reset !== "boolean") {
          throw new Error("Discord bridge event response is invalid");
        }
        if (result.reset) cursor = 0;
        const events = [...result.events].sort((a, b) => a.seq - b.seq);
        for (const event of events) {
          if (!result.reset && event.seq <= cursor) continue;
          ensureThreadRoute(event.message, account.accountId);
          const inbound = mapBridgeEvent(event, account.accountId);
          if (typeof adapter.onMessage !== "function") throw new Error("Discord bridge route handler is unavailable");
          // Start immediately at ingress rather than waiting for a later
          // lifecycle callback. Lifecycle events renew/finish this same lease,
          // and a successful final send clears every lease for the target.
          typing.start(inbound);
          try {
            await adapter.onMessage(inbound);
          } catch (error) {
            typing.stop(inbound);
            throw error;
          }
          const ack = await requestJson(config, "/bridge/ack", { method: "POST", body: JSON.stringify({ seq: event.seq }) }, signal);
          if (!ack || ack.acked !== event.seq) throw new Error("Discord bridge acknowledgement failed");
          cursor = event.seq;
        }
        backoff = config.minBackoffMs;
        if (!config.pollWait && events.length === 0) await delay(250, signal);
      } catch (error) {
        if (signal.aborted) break;
        startupLogger(`${LOG_PREFIX} bridge poll failed; retrying in ${backoff}ms`);
        const jitter = crypto.randomInt(0, Math.max(1, Math.floor(backoff / 4)));
        await delay(backoff + jitter, signal).catch(() => {});
        backoff = Math.min(config.maxBackoffMs, backoff * 2);
      }
    }
    running = false;
  }

  return adapter;
}

export const channelPlugin = {
  metadata: {
    id: CHANNEL_ID,
    displayName: CHANNEL_DISPLAY_NAME,
    runtimePackages: [],
    runtimeModules: [],
  },

  createAdapter(account) {
    return createContinuityDiscordAdapter(account);
  },

  messageActions: {
    describeMessageTool() {
      return { actions: ["send", "react"] };
    },

    async handleAction({ adapter, request, formatText, route }) {
      if (request.action === "send") {
        const formatted = formatText(request.message ?? "");
        const result = await adapter.sendMessage({
          channel: request.channel,
          accountId: route.accountId,
          chatId: request.chatId,
          threadId: request.threadId,
          text: formatted.text,
          parseMode: formatted.parseMode,
          replyToMessageId: request.replyToMessageId,
        });
        return `Message sent to ${request.channel} (message_id: ${result.messageId})`;
      }
      if (request.action === "react") {
        if (request.remove) throw new Error("Removing Discord reactions is not supported by this bridge");
        if (!request.messageId || !request.emoji) throw new Error("Discord reaction requires messageId and emoji");
        await adapter.sendMessage({
          channel: request.channel,
          accountId: route.accountId,
          chatId: request.chatId,
          threadId: request.threadId,
          text: "",
          reaction: request.emoji,
          targetMessageId: request.messageId,
        });
        return `Reaction sent to ${request.channel} (message_id: ${request.messageId})`;
      }
      throw new Error(`Unsupported ${CHANNEL_ID} action`);
    },
  },
};

export default channelPlugin;
