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
const DELIVERY_CONCURRENCY = 4;
const DELIVERY_QUARANTINE_LIMIT = 4;
const DELIVERY_TIMEOUT_MS = 30_000;
const PENDING_POLL_DELAY_MS = 2_000;
const BOT_REPLY_LEDGER_TTL_MS = 7 * 24 * 60 * 60_000;
const BOT_REPLY_LEDGER_LIMIT = 4096;
const LEDGER_LOCK_STALE_MS = 30_000;
const LEDGER_LOCK_WAIT_MS = 5_000;
const LEDGER_SLEEP = new Int32Array(new SharedArrayBuffer(4));

function safeLedgerFile(file) {
  try {
    const metadata = fs.lstatSync(file);
    const unsafePosixPermissions = typeof process.getuid === "function" &&
      (metadata.uid !== process.getuid() || (metadata.mode & 0o022) !== 0);
    return metadata.isFile() && !metadata.isSymbolicLink() && !unsafePosixPermissions;
  } catch (error) {
    if (error?.code === "ENOENT") return true;
    throw error;
  }
}

function writeLedgerAtomic(file, state) {
  if (!safeLedgerFile(file)) throw new Error("Discord bot reply ledger has unsafe ownership, permissions, or type");
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  let fd;
  try {
    fd = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(fd, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    if (!safeLedgerFile(file)) throw new Error("Discord bot reply ledger destination became unsafe");
    fs.renameSync(temporary, file);
    fs.chmodSync(file, 0o600);
    if (process.platform !== "win32") {
      const directoryFd = fs.openSync(path.dirname(file), "r");
      try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
    }
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.rmSync(temporary, { force: true }); } catch {}
  }
}

function processIdentity(pid) {
  if (process.platform !== "linux" || !Number.isInteger(pid) || pid < 1) return null;
  try {
    const bootId = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = stat.lastIndexOf(")");
    const fields = close >= 0 ? stat.slice(close + 2).trim().split(/\s+/) : [];
    const startTime = fields[19];
    return bootId && startTime ? `${bootId}:${startTime}` : null;
  } catch {
    return null;
  }
}

function processOwnerIsAlive(owner) {
  if (!owner || !Number.isInteger(owner.pid) || owner.pid < 1) return false;
  try {
    process.kill(owner.pid, 0);
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    return true;
  }
  const currentIdentity = processIdentity(owner.pid);
  return !(owner.processIdentity && currentIdentity && owner.processIdentity !== currentIdentity);
}

function readOwnedLock(lockPath, unsafeMessage) {
  const metadata = fs.lstatSync(lockPath);
  const unsafePosixPermissions = typeof process.getuid === "function" &&
    (metadata.uid !== process.getuid() || (metadata.mode & 0o022) !== 0);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || unsafePosixPermissions) {
    throw new Error(unsafeMessage);
  }
  let owner = null;
  try {
    const ownerPath = path.join(lockPath, "owner.json");
    const ownerMetadata = fs.lstatSync(ownerPath);
    const unsafeOwnerPermissions = typeof process.getuid === "function" &&
      (ownerMetadata.uid !== process.getuid() || (ownerMetadata.mode & 0o022) !== 0);
    if (!ownerMetadata.isFile() || ownerMetadata.isSymbolicLink() || unsafeOwnerPermissions) {
      throw new Error(unsafeMessage);
    }
    const parsed = JSON.parse(fs.readFileSync(ownerPath, "utf8"));
    if (typeof parsed?.token === "string" && parsed.token.length >= 16 &&
        Number.isInteger(parsed.pid) && parsed.pid > 0 &&
        (parsed.processIdentity === null || typeof parsed.processIdentity === "string")) {
      owner = parsed;
    }
  } catch (error) {
    if (error?.message === unsafeMessage) throw error;
  }
  return { metadata, owner };
}

function withOwnedFilesystemLock(lockPath, options, operation) {
  const { staleMs, waitMs, busyMessage, unsafeMessage } = options;
  const deadline = Date.now() + waitMs;
  const owner = {
    token: crypto.randomUUID(),
    pid: process.pid,
    processIdentity: processIdentity(process.pid),
  };
  const reclaimPath = `${lockPath}.reclaim`;
  let ownsLock = false;
  while (!ownsLock) {
    try {
      fs.mkdirSync(lockPath, { mode: 0o700 });
      ownsLock = true;
      const ownerPath = path.join(lockPath, "owner.json");
      const ownerFd = fs.openSync(ownerPath, "wx", 0o600);
      try {
        fs.writeFileSync(ownerFd, `${JSON.stringify(owner)}\n`, "utf8");
        fs.fsyncSync(ownerFd);
      } finally {
        fs.closeSync(ownerFd);
      }
    } catch (error) {
      if (ownsLock) {
        try { fs.rmSync(lockPath, { recursive: true, force: true }); } catch {}
        ownsLock = false;
      }
      if (error?.code !== "EEXIST") throw error;
      let existing;
      try {
        existing = readOwnedLock(lockPath, unsafeMessage);
      } catch (readError) {
        if (readError?.code === "ENOENT") continue;
        throw readError;
      }
      const apparentlyStale = Date.now() - existing.metadata.mtimeMs > staleMs;
      if (apparentlyStale && !processOwnerIsAlive(existing.owner)) {
        let reclaimer = false;
        try {
          fs.mkdirSync(reclaimPath, { mode: 0o700 });
          reclaimer = true;
          let current;
          try { current = readOwnedLock(lockPath, unsafeMessage); } catch (readError) {
            if (readError?.code === "ENOENT") continue;
            throw readError;
          }
          if (Date.now() - current.metadata.mtimeMs > staleMs && !processOwnerIsAlive(current.owner)) {
            const quarantine = `${lockPath}.stale-${process.pid}-${crypto.randomUUID()}`;
            fs.renameSync(lockPath, quarantine);
            fs.rmSync(quarantine, { recursive: true, force: true });
          }
        } catch (reclaimError) {
          if (reclaimError?.code !== "EEXIST" && reclaimError?.code !== "ENOENT") throw reclaimError;
        } finally {
          if (reclaimer) {
            try { fs.rmdirSync(reclaimPath); } catch (removeError) {
              if (removeError?.code !== "ENOENT") throw removeError;
            }
          }
        }
        continue;
      }
      if (Date.now() >= deadline) throw new Error(busyMessage);
      Atomics.wait(LEDGER_SLEEP, 0, 0, 10);
    }
  }
  try {
    return operation();
  } finally {
    let current;
    try { current = readOwnedLock(lockPath, unsafeMessage); } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    if (!current || current.owner?.token !== owner.token) {
      throw new Error(`${busyMessage}: lock ownership was lost`);
    }
    fs.rmSync(lockPath, { recursive: true });
  }
}

function withLedgerLock(file, operation) {
  const lockFile = `${file}.lock`;
  return withOwnedFilesystemLock(lockFile, {
    staleMs: LEDGER_LOCK_STALE_MS,
    waitMs: LEDGER_LOCK_WAIT_MS,
    busyMessage: "Discord source ledger is busy",
    unsafeMessage: "Discord source ledger lock has unsafe ownership, permissions, or type",
  }, operation);
}

/**
 * Persistent at-most-once ledger for bot-origin turns. Reservations are
 * written before the network call and survive restarts. A known failed call is
 * released in-process; an ambiguous crash remains consumed rather than risking
 * a duplicate response loop.
 */
export function createBotReplyLedger(options = {}) {
  const file = options.filePath ?? path.join(CHANNEL_DIRECTORY, "bot-reply-ledger.json");
  const ttlMs = options.ttlMs ?? BOT_REPLY_LEDGER_TTL_MS;
  const limit = options.limit ?? BOT_REPLY_LEDGER_LIMIT;
  const now = typeof options.now === "function" ? options.now : () => Date.now();
  if (!Number.isInteger(ttlMs) || ttlMs < 1 || !Number.isInteger(limit) || limit < 1) {
    throw new Error("Discord bot reply ledger limits are invalid");
  }

  function load() {
    if (!safeLedgerFile(file)) throw new Error("Discord bot reply ledger has unsafe ownership, permissions, or type");
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") return { version: 1, entries: {} };
      throw new Error("Discord bot reply ledger is unreadable or invalid");
    }
    if (parsed?.version !== 1 || !parsed.entries || typeof parsed.entries !== "object" || Array.isArray(parsed.entries)) {
      throw new Error("Discord bot reply ledger has an invalid schema");
    }
    for (const [messageId, entry] of Object.entries(parsed.entries)) {
      if (!SNOWFLAKE.test(messageId) || !entry || typeof entry !== "object" ||
          !["available", "reserved", "sent"].includes(entry.status) ||
          typeof entry.botOrigin !== "boolean" || !SNOWFLAKE.test(entry.channelId ?? "") ||
          !Number.isSafeInteger(entry.updatedAt)) {
        throw new Error("Discord bot reply ledger has an invalid schema");
      }
    }
    return parsed;
  }

  function prune(state, timestamp) {
    for (const [messageId, entry] of Object.entries(state.entries)) {
      if (timestamp - entry.updatedAt > ttlMs) delete state.entries[messageId];
    }
    if (Object.keys(state.entries).length > limit) throw new Error("Discord source ledger is full");
  }

  function save(state) {
    prune(state, now());
    writeLedgerAtomic(file, state);
  }

  return {
    register(messageId, channelId, botOrigin) {
      if (!SNOWFLAKE.test(messageId) || !SNOWFLAKE.test(channelId)) {
        throw new Error("Discord bot reply ledger identity is invalid");
      }
      if (typeof botOrigin !== "boolean") throw new Error("Discord source classification is invalid");
      return withLedgerLock(file, () => {
        const state = load();
        prune(state, now());
        if (!state.entries[messageId]) {
          if (Object.keys(state.entries).length >= limit) throw new Error("Discord source ledger is full");
          state.entries[messageId] = { status: "available", botOrigin, channelId, updatedAt: now() };
          save(state);
        } else if (state.entries[messageId].channelId !== channelId || state.entries[messageId].botOrigin !== botOrigin) {
          throw new Error("Discord source ledger identity mismatch");
        }
      });
    },
    reserve(messageId, channelId) {
      return withLedgerLock(file, () => {
        const state = load();
        prune(state, now());
        const entry = state.entries[messageId];
        if (!entry) throw new Error("Discord source classification is unavailable");
        if (entry.channelId !== channelId) throw new Error("Discord bot reply ledger route mismatch");
        if (!entry.botOrigin) return false;
        if (entry.status !== "available") throw new Error("Discord bot-origin turn already used its one outbound response");
        entry.status = "reserved";
        entry.updatedAt = now();
        save(state);
        return true;
      });
    },
    complete(messageId) {
      return withLedgerLock(file, () => {
        const state = load();
        const entry = state.entries[messageId];
        if (!entry || entry.status !== "reserved") throw new Error("Discord bot reply reservation is missing");
        entry.status = "sent";
        entry.updatedAt = now();
        save(state);
      });
    },
    release(messageId) {
      return withLedgerLock(file, () => {
        const state = load();
        const entry = state.entries[messageId];
        if (!entry || entry.status !== "reserved") return;
        entry.status = "available";
        entry.updatedAt = now();
        save(state);
      });
    },
    inspect(messageId) {
      return withLedgerLock(file, () => load().entries[messageId] ?? null);
    },
  };
}

function defaultRoutingPath() {
  const candidates = ["routing.yaml", "routing.json"].map(name => path.join(CHANNEL_DIRECTORY, name));
  return candidates.find(candidate => fs.existsSync(candidate)) ?? candidates[0];
}

function normalizedAccountId(value) {
  return typeof value === "string" && value.trim() ? value.trim() : LEGACY_ACCOUNT_ID;
}

function typingTarget(source) {
  const directChannel = source?.chatType === "direct" ? source?.raw?.discord?.channelId?.trim() : null;
  const target = source?.threadId?.trim() || directChannel || source?.chatId?.trim();
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
  return withOwnedFilesystemLock(lockPath, {
    staleMs: 60_000,
    waitMs: 0,
    busyMessage: "Discord route update is already in progress",
    unsafeMessage: "Discord route update lock has unsafe ownership, permissions, or type",
  }, () => {
    const existingFile = fs.lstatSync(routingPath);
    if (!existingFile.isFile() || existingFile.isSymbolicLink()) {
      throw new Error("Discord routing path is not a regular file");
    }
    if (typeof process.getuid === "function" && existingFile.uid !== process.getuid()) {
      throw new Error("Discord routing file has an unexpected owner");
    }
    // POSIX permission bits are not authoritative on Windows; the same check
    // would reject every normal temporary file there. Production is Linux.
    if (process.platform !== "win32" && (existingFile.mode & 0o022) !== 0) {
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
      if (process.platform !== "win32") {
        const directoryFd = fs.openSync(path.dirname(routingPath), "r");
        try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
      }
    } finally {
      if (temporaryFd !== undefined) fs.closeSync(temporaryFd);
      try { fs.unlinkSync(temporaryPath); } catch {}
    }
    return true;
  });
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
  const deliveryConcurrency = integer("delivery_concurrency", DELIVERY_CONCURRENCY, 2, 32);
  const deliveryQuarantineLimit = integer("delivery_quarantine_limit", DELIVERY_QUARANTINE_LIMIT, 1, 32);
  const deliveryTimeoutMs = integer("delivery_timeout_ms", DELIVERY_TIMEOUT_MS, 100, 10 * 60_000);
  const pendingPollDelayMs = integer("pending_poll_delay_ms", PENDING_POLL_DELAY_MS, 10, 60_000);
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
    deliveryConcurrency,
    deliveryQuarantineLimit,
    deliveryMaxUnresolved: deliveryConcurrency + deliveryQuarantineLimit,
    deliveryTimeoutMs,
    pendingPollDelayMs,
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
  if (typeof message.authorIsBot !== "boolean") {
    throw new Error("Invalid Discord bridge author classification");
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
        authorIsBot: message.authorIsBot === true,
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
    if (!response.ok) {
      const error = new Error(`Discord bridge request failed (HTTP ${response.status})`);
      // A completed HTTP response is a known rejection and may safely release
      // a bot reservation. Transport aborts and malformed success responses
      // remain ambiguous and deliberately consume the one-shot reservation.
      error.definitiveFailure = true;
      throw error;
    }
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

export function createContinuityDiscordAdapter(account, options = {}) {
  const config = parseAccountConfig(account);
  const botReplies = createBotReplyLedger({ filePath: options.botReplyLedgerPath });
  let running = false;
  let generation = 0;
  let currentRun = null;
  let startupLogger = () => {};
  // Unresolved onMessage calls cannot be cancelled. Keep them across run
  // generations solely for a hard process-wide bound; routing, retries, and
  // acknowledgements remain scoped to the run that created them.
  const unresolvedDeliveries = new Map();
  const typing = createDiscordTypingController({
    sendTyping: async channel => {
      await requestJson(config, "/bridge/send", {
        method: "POST",
        body: JSON.stringify({ kind: "typing", channel }),
      }, currentRun?.controller.signal);
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
      startupLogger = typeof options.logger === "function" ? options.logger : () => {};
      const run = {
        id: ++generation,
        controller: new AbortController(),
        pendingDeliveries: new Map(),
        retryState: new Map(),
        directChannelIds: new Map(),
        sourceMessageIds: new Set(),
        loopPromise: null,
        stopped: false,
      };
      currentRun = run;
      running = true;
      startupLogger(`${LOG_PREFIX} bridge listener started`);
      run.loopPromise = pollLoop(run);
    },

    async stop() {
      const run = currentRun;
      if (!run) return;
      running = false;
      currentRun = null;
      run.stopped = true;
      typing.stopAll();
      run.controller.abort();
      // Do not let an uncancellable old turn block a chat key after restart.
      // The unresolved promise stays in the global budget until it really
      // settles, but it loses every route/retry/ACK capability from this run.
      for (const entry of run.pendingDeliveries.values()) {
        clearTimeout(entry.timeout);
        entry.state = "orphaned";
      }
      run.pendingDeliveries.clear();
      run.retryState.clear();
      run.directChannelIds.clear();
      run.sourceMessageIds.clear();
      try { await run.loopPromise; } catch {}
      startupLogger(`${LOG_PREFIX} bridge listener stopped`);
    },

    isRunning() { return running; },

    async handleTurnLifecycleEvent(event) {
      const run = currentRun;
      if (!running || !run) return;
      if (event.type === "queued") {
        if (run.sourceMessageIds.has(event.source?.messageId)) typing.start(event.source);
        return;
      }
      const currentSources = event.sources.filter(source => run.sourceMessageIds.has(source?.messageId));
      if (event.type === "processing") {
        for (const source of currentSources) typing.start(source);
        return;
      }
      for (const source of currentSources) {
        typing.stop(source);
        run.sourceMessageIds.delete(source.messageId);
      }
    },

    async sendMessage(message) {
      const target = message.threadId?.trim() || message.chatId;
      if (!SNOWFLAKE.test(target)) throw new Error("Discord bridge target is invalid");
      if (message.reaction && (!message.targetMessageId || !SNOWFLAKE.test(message.targetMessageId))) {
        throw new Error("Discord bridge reaction message ID is invalid");
      }
      const direct = message.chatType === "direct";
      const originMessageId = message.originMessageId ?? message.replyToMessageId;
      const botOrigin = SNOWFLAKE.test(originMessageId ?? "")
        ? botReplies.reserve(originMessageId, target)
        : false;
      let networkAccepted = false;
      try {
        if (message.reaction) {
          const reactionTarget = currentRun?.directChannelIds.get(message.chatId) ?? target;
          await requestJson(config, "/bridge/send", {
            method: "POST",
            body: JSON.stringify({ kind: "react", channel: reactionTarget, messageId: message.targetMessageId, emoji: message.reaction }),
          });
          networkAccepted = true;
          if (botOrigin) botReplies.complete(originMessageId);
          return { messageId: message.targetMessageId };
        }
        const result = await requestJson(config, "/bridge/send", {
          method: "POST",
          body: JSON.stringify({
            kind: direct ? "send_dm" : "send",
            ...(direct ? { userId: target } : { channel: target }),
            text: message.text,
            ...(!botOrigin && message.replyToMessageId ? { replyToMessageId: message.replyToMessageId } : {}),
          }),
        });
        if (!result || !SNOWFLAKE.test(result.messageId)) throw new Error("Discord bridge returned an invalid message ID");
        networkAccepted = true;
        if (botOrigin) botReplies.complete(originMessageId);
        typing.stopTarget(result.channelId ?? target);
        return { messageId: result.messageId };
      } catch (error) {
        if (botOrigin && !networkAccepted && error?.definitiveFailure === true) {
          botReplies.release(originMessageId);
        }
        throw error;
      }
    },

    async sendDirectReply(chatId, text, options = {}) {
      await adapter.sendMessage({
        chatId,
        text,
        replyToMessageId: options.replyToMessageId,
        threadId: options.threadId,
        chatType: options.chatType ?? (currentRun?.directChannelIds.has(chatId) ? "direct" : undefined),
      });
    },
  };

  function deliveryKey(event) {
    return `${event?.message?.account ?? "discord"}:${event?.message?.channel ?? "unknown"}`;
  }

  function isCurrentRun(run) {
    return currentRun === run && !run.stopped && !run.controller.signal.aborted;
  }

  function activeDeliveryCount(run) {
    let count = 0;
    for (const delivery of run.pendingDeliveries.values()) {
      if (delivery.state !== "quarantined") count += 1;
    }
    return count;
  }

  function quarantinedDeliveryCount(run) {
    let count = 0;
    for (const delivery of run.pendingDeliveries.values()) {
      if (delivery.state === "quarantined") count += 1;
    }
    return count;
  }

  function keyIsPending(run, key) {
    for (const delivery of run.pendingDeliveries.values()) {
      if (delivery.key === key) return true;
    }
    return false;
  }

  function startDelivery(event, run) {
    const messageId = event.message.messageId;
    if (run.pendingDeliveries.has(messageId)) return false;
    if (unresolvedDeliveries.size >= config.deliveryMaxUnresolved) return false;
    const key = deliveryKey(event);
    const unresolvedId = `${run.id}:${messageId}`;
    const entry = { key, state: "active", accepted: false, timeout: null, promise: null, unresolvedId };
    const inbound = mapBridgeEvent(event, account.accountId);
    // Persist source classification before handing the turn to Letta. Unknown
    // or expired origins fail closed rather than silently becoming human turns.
    botReplies.register(inbound.messageId, inbound.chatId, inbound.raw.discord.authorIsBot);
    run.sourceMessageIds.add(messageId);
    const dmChannelId = inbound.chatType === "direct" ? inbound.raw?.discord?.channelId : null;
    if (SNOWFLAKE.test(dmChannelId ?? "")) run.directChannelIds.set(inbound.chatId, dmChannelId);
    typing.start(inbound);
    entry.timeout = setTimeout(() => {
      if (!isCurrentRun(run) || entry.state !== "active") return;
      // onMessage has no cancellation contract. Move only a finite number of
      // timed-out calls into quarantine so active slots can keep serving other
      // chats. Both active and quarantined calls remain in the process-wide
      // unresolved budget, preventing restarts or repeated hangs from growing
      // promises without bound.
      typing.stop(inbound);
      if (quarantinedDeliveryCount(run) < config.deliveryQuarantineLimit) {
        entry.state = "quarantined";
        startupLogger(`${LOG_PREFIX} delivery seq=${event.seq} exceeded ${config.deliveryTimeoutMs}ms; quarantined, acknowledgement deferred until delivery completes`);
      } else {
        entry.state = "timed_out_active";
        startupLogger(`${LOG_PREFIX} delivery seq=${event.seq} exceeded ${config.deliveryTimeoutMs}ms; quarantine full, active slot retained`);
      }
    }, config.deliveryTimeoutMs);
    entry.timeout.unref?.();
    run.pendingDeliveries.set(messageId, entry);
    unresolvedDeliveries.set(unresolvedId, entry);
    entry.promise = (async () => {
      try {
        if (typeof adapter.onMessage !== "function") throw new Error("Discord bridge route handler is unavailable");
        await adapter.onMessage(inbound);
        entry.accepted = true;
        // A stopped generation may finish much later. It must never ACK a
        // sequence that a newer bridge generation may have reused.
        if (!isCurrentRun(run)) return;
        const ack = await requestJson(config, "/bridge/ack", {
          method: "POST",
          body: JSON.stringify({ seq: event.seq, messageId, exact: true }),
        }, run.controller.signal);
        if (!ack || ack.acked !== event.seq || ack.messageId !== messageId || ack.exact !== true || ack.removed !== 1) {
          throw new Error("Discord bridge acknowledgement did not remove the delivered event");
        }
        run.retryState.delete(messageId);
      } catch (error) {
        typing.stop(inbound);
        if (isCurrentRun(run)) {
          const previous = run.retryState.get(messageId) ?? { attempts: 0, retryAt: 0 };
          const attempts = previous.attempts + 1;
          const retryDelay = Math.min(config.maxBackoffMs, config.minBackoffMs * (2 ** Math.min(attempts - 1, 10)));
          run.retryState.set(messageId, { attempts, retryAt: Date.now() + retryDelay });
          startupLogger(`${LOG_PREFIX} delivery seq=${event.seq} failed; retained for retry in ${retryDelay}ms`);
        }
      } finally {
        clearTimeout(entry.timeout);
        if (!entry.accepted) run.sourceMessageIds.delete(messageId);
        if (run.pendingDeliveries.get(messageId) === entry) run.pendingDeliveries.delete(messageId);
        unresolvedDeliveries.delete(unresolvedId);
      }
    })();
    return true;
  }

  async function pollLoop(run) {
    const signal = run.controller.signal;
    let backoff = config.minBackoffMs;
    while (!signal.aborted) {
      try {
        // Always ask for all unacknowledged events. Exact acknowledgements let
        // later unrelated chats complete while an older event remains pending.
        const result = await requestJson(config, `/bridge/events?after=0&wait=${config.pollWait ? "1" : "0"}`, {}, signal);
        if (!result || !Array.isArray(result.events) || !Number.isInteger(result.lastSeq) || typeof result.reset !== "boolean") {
          throw new Error("Discord bridge event response is invalid");
        }
        const events = [...result.events].sort((a, b) => a.seq - b.seq);
        let launched = 0;
        for (const event of events) {
          const messageId = event.message.messageId;
          if (run.pendingDeliveries.has(messageId)) continue;
          const retry = run.retryState.get(messageId);
          if (retry && retry.retryAt > Date.now()) continue;
          const key = deliveryKey(event);
          if (keyIsPending(run, key)) continue;
          if (activeDeliveryCount(run) >= config.deliveryConcurrency) break;
          if (unresolvedDeliveries.size >= config.deliveryMaxUnresolved) break;
          ensureThreadRoute(event.message, account.accountId);
          if (startDelivery(event, run)) launched += 1;
        }
        backoff = config.minBackoffMs;
        if (events.length > 0) {
          // The endpoint returns immediately while any unacked event exists.
          // Avoid a hot loop while deliveries are active or cooling down.
          await delay(launched > 0 ? 10 : config.pendingPollDelayMs, signal);
        } else if (!config.pollWait) {
          await delay(250, signal);
        }
      } catch (error) {
        if (signal.aborted) break;
        startupLogger(`${LOG_PREFIX} bridge poll failed; retrying in ${backoff}ms`);
        const jitter = crypto.randomInt(0, Math.max(1, Math.floor(backoff / 4)));
        await delay(backoff + jitter, signal).catch(() => {});
        backoff = Math.min(config.maxBackoffMs, backoff * 2);
      }
    }
    if (currentRun === run) {
      currentRun = null;
      running = false;
    }
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
          chatType: route.chatType,
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
          targetMessageId: request.replyToMessageId ?? request.messageId,
          originMessageId: request.replyToMessageId,
        });
        return `Reaction sent to ${request.channel} (message_id: ${request.messageId})`;
      }
      throw new Error(`Unsupported ${CHANNEL_ID} action`);
    },
  },
};

export default channelPlugin;
