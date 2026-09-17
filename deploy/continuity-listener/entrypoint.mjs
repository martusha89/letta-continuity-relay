import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
} from "node:fs/promises";
import path from "node:path";

const required = [
  "LETTA_API_KEY",
  "LETTA_AGENT_ID",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_CHAT_ID",
  "DISCORD_BRIDGE_BASE_URL",
  "DISCORD_BRIDGE_BEARER_TOKEN",
  "DISCORD_CHANNEL_IDS",
];

const missing = required.filter(name => !process.env[name]?.trim());
if (missing.length > 0) {
  console.error(`Missing required environment variables: ${missing.join(", ")}`);
  process.exit(1);
}

const SNOWFLAKE = /^\d{17,20}$/;
const TELEGRAM_ID = /^\d+$/;
const seedOnly = process.env.SEED_ONLY === "1";
const testHome = seedOnly ? process.env.CONTINUITY_TEST_HOME?.trim() : "";
const home = testHome || process.env.HOME || "/root";
if (!testHome && path.resolve(home) !== "/root") {
  console.error("The continuity listener requires HOME=/root and a persistent volume mounted at /root.");
  process.exit(1);
}

function commaList(name, value, validator) {
  const values = [...new Set(String(value ?? "").split(",").map(item => item.trim()).filter(Boolean))];
  const invalid = values.find(item => !validator.test(item));
  if (invalid) throw new Error(`${name} contains an invalid identifier`);
  return values;
}

const agentId = process.env.LETTA_AGENT_ID.trim();
const conversationId = (process.env.LETTA_CONVERSATION_ID || "default").trim();
if (!agentId || !conversationId) throw new Error("LETTA_AGENT_ID and LETTA_CONVERSATION_ID must not be blank");
const telegramChatId = process.env.TELEGRAM_CHAT_ID.trim();
if (!TELEGRAM_ID.test(telegramChatId)) throw new Error("TELEGRAM_CHAT_ID must be numeric");

const telegramAllowedUsers = commaList(
  "TELEGRAM_ALLOWED_USER_IDS",
  process.env.TELEGRAM_ALLOWED_USER_IDS || telegramChatId,
  TELEGRAM_ID,
);
if (telegramAllowedUsers.length === 0) throw new Error("At least one Telegram allowed user is required");
if (!telegramAllowedUsers.includes(telegramChatId)) {
  throw new Error("TELEGRAM_ALLOWED_USER_IDS must include TELEGRAM_CHAT_ID for a private-chat route");
}

const discordChannelIds = commaList("DISCORD_CHANNEL_IDS", process.env.DISCORD_CHANNEL_IDS, SNOWFLAKE);
if (discordChannelIds.length === 0) throw new Error("At least one Discord channel ID is required");

const bridgeToken = process.env.DISCORD_BRIDGE_BEARER_TOKEN.trim();
if (bridgeToken.length < 32) throw new Error("DISCORD_BRIDGE_BEARER_TOKEN must be at least 32 characters");

let bridgeBaseUrl;
try {
  const parsed = new URL(process.env.DISCORD_BRIDGE_BASE_URL.trim());
  if (parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error("unsafe URL components");
  const hostname = parsed.hostname.toLowerCase();
  const privateHttp = parsed.protocol === "http:" &&
    (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname.endsWith(".railway.internal"));
  if (parsed.protocol !== "https:" && !privateHttp) throw new Error("unsafe protocol");
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  bridgeBaseUrl = parsed.toString().replace(/\/$/, "");
} catch {
  throw new Error("DISCORD_BRIDGE_BASE_URL must be HTTPS or HTTP on localhost/private Railway DNS, without credentials, query, or fragment");
}

const telegramAccountId = (process.env.TELEGRAM_ACCOUNT_ID || "continuity-main").trim();
const discordAccountId = (process.env.DISCORD_ACCOUNT_ID || "continuity-main").trim();
const telegramDisplayName = (process.env.TELEGRAM_DISPLAY_NAME || "Continuity Telegram").trim();
const discordDisplayName = (process.env.DISCORD_DISPLAY_NAME || "Continuity Discord").trim();
for (const [name, value] of [
  ["TELEGRAM_ACCOUNT_ID", telegramAccountId],
  ["DISCORD_ACCOUNT_ID", discordAccountId],
  ["TELEGRAM_DISPLAY_NAME", telegramDisplayName],
  ["DISCORD_DISPLAY_NAME", discordDisplayName],
]) {
  if (!value || value.length > 160 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`${name} is blank, too long, or contains control characters`);
  }
}
const now = new Date().toISOString();

const lettaRoot = path.join(home, ".letta");
const telegramDir = path.join(lettaRoot, "channels", "telegram");
const discordChannelId = "continuity-discord";
const discordDir = path.join(lettaRoot, "channels", discordChannelId);
const modsDir = path.join(lettaRoot, "mods");
const discordPluginAsset = testHome && process.env.CONTINUITY_TEST_PLUGIN_PATH?.trim()
  ? process.env.CONTINUITY_TEST_PLUGIN_PATH.trim()
  : "/app/continuity-discord/plugin.mjs";
const routeGuardAsset = testHome && process.env.CONTINUITY_TEST_GUARD_PATH?.trim()
  ? process.env.CONTINUITY_TEST_GUARD_PATH.trim()
  : "/app/channel-reply-route-guard.ts";

const currentUid = typeof process.getuid === "function" ? process.getuid() : 0;

async function ensureSafeDirectory(directory) {
  let metadata;
  try {
    metadata = await lstat(directory);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    await mkdir(directory, { mode: 0o700 });
    metadata = await lstat(directory);
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`State path ${directory} must be a real directory`);
  }
  if (metadata.uid !== currentUid || (metadata.mode & 0o022) !== 0) {
    throw new Error(`State directory ${directory} has unsafe ownership or permissions`);
  }
}

for (const directory of [
  home,
  lettaRoot,
  path.join(lettaRoot, "channels"),
  telegramDir,
  discordDir,
  modsDir,
]) {
  await ensureSafeDirectory(directory);
}

async function readJson(paths, fallback) {
  for (const file of paths) {
    try {
      const metadata = await lstat(file);
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.uid !== currentUid || (metadata.mode & 0o022) !== 0) {
        throw new Error(`State file ${path.basename(file)} has unsafe ownership, permissions, or type`);
      }
      return JSON.parse(await readFile(file, "utf8"));
    } catch (error) {
      if (error?.code !== "ENOENT") throw new Error(`State file ${path.basename(file)} is unreadable or invalid`);
    }
  }
  return structuredClone(fallback);
}

async function writeAtomic(file, data, mode = 0o600) {
  const validateDestination = async () => {
    try {
      const metadata = await lstat(file);
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.uid !== currentUid || (metadata.mode & 0o022) !== 0) {
        throw new Error(`State destination ${file} is not a safe owned regular file`);
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  };
  await validateDestination();
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporary, "wx", mode);
    await handle.writeFile(data, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await validateDestination();
    await rename(temporary, file);
    await chmod(file, mode);
    const directory = await open(path.dirname(file), "r");
    try { await directory.sync(); } finally { await directory.close(); }
  } finally {
    if (handle) await handle.close().catch(() => {});
    await rm(temporary, { force: true }).catch(() => {});
  }
}

async function writeJsonAtomic(file, value) {
  await writeAtomic(file, `${JSON.stringify(value, null, 2)}\n`, 0o600);
}

async function installFile(source, destination, mode = 0o600) {
  await writeAtomic(destination, await readFile(source, "utf8"), mode);
}

// Install the repository's audited custom Discord channel and the generic
// route guard on every boot so image updates cannot leave stale code on the
// persistent volume. The plugin derives its channel ID from this directory.
const discordPluginSource = await readFile(discordPluginAsset, "utf8");
await writeAtomic(path.join(discordDir, "plugin.mjs"), discordPluginSource, 0o644);
await writeJsonAtomic(path.join(discordDir, "channel.json"), {
  id: discordChannelId,
  displayName: discordDisplayName,
  entry: "./plugin.mjs",
  runtimePackages: [],
  runtimeModules: [],
});
await installFile(routeGuardAsset, path.join(modsDir, "channel-reply-route-guard.ts"), 0o600);

const telegramAccountsPath = path.join(telegramDir, "accounts.json");
const telegramAccounts = await readJson([telegramAccountsPath], { accounts: [] });
if (!telegramAccounts || typeof telegramAccounts !== "object" || !Array.isArray(telegramAccounts.accounts)) {
  throw new Error("Telegram accounts state has an invalid schema");
}
let telegramAccount = telegramAccounts.accounts.find(
  candidate => candidate?.channel === "telegram" && candidate?.accountId === telegramAccountId,
);
if (!telegramAccount) {
  telegramAccount = { channel: "telegram", accountId: telegramAccountId, createdAt: now };
  telegramAccounts.accounts.push(telegramAccount);
}
Object.assign(telegramAccount, {
  channel: "telegram",
  accountId: telegramAccountId,
  displayName: telegramDisplayName,
  enabled: true,
  token: process.env.TELEGRAM_BOT_TOKEN.trim(),
  dmPolicy: "allowlist",
  allowedUsers: telegramAllowedUsers,
  binding: { agentId, conversationId },
  group_mode: "disabled",
  inbound_debounce_ms: 0,
  rich_private_chat_default: process.env.TELEGRAM_RICH_MESSAGES === "true",
  transcribe_voice: false,
  updatedAt: now,
});
await writeJsonAtomic(telegramAccountsPath, telegramAccounts);

const telegramRoutingYaml = path.join(telegramDir, "routing.yaml");
const telegramRoutingJson = path.join(telegramDir, "routing.json");
const telegramRouting = await readJson([telegramRoutingJson, telegramRoutingYaml], { routes: [] });
if (!telegramRouting || typeof telegramRouting !== "object" || !Array.isArray(telegramRouting.routes)) {
  throw new Error("Telegram routing state has an invalid schema");
}
const telegramManagedPath = path.join(telegramDir, "continuity-managed-route.json");
const telegramManaged = await readJson([telegramManagedPath], { accountId: null, chatId: null });
if (!telegramManaged || typeof telegramManaged !== "object" || Array.isArray(telegramManaged)) {
  throw new Error("Telegram managed-route state has an invalid schema");
}
const ownsTelegramRoute = telegramManaged.accountId === telegramAccountId &&
  String(telegramManaged.chatId ?? "") === telegramChatId;
let telegramRoute = telegramRouting.routes.find(
  candidate => candidate?.accountId === telegramAccountId && String(candidate?.chatId) === telegramChatId,
);
if (telegramRoute && !ownsTelegramRoute) {
  const sameTarget = telegramRoute.agentId === agentId && telegramRoute.conversationId === conversationId &&
    telegramRoute.chatType === "direct" && telegramRoute.enabled !== false && telegramRoute.outboundEnabled !== false;
  if (!sameTarget) throw new Error("Telegram route conflicts with existing unmanaged state");
}
if (!telegramRoute) {
  telegramRoute = {
    accountId: telegramAccountId,
    chatId: telegramChatId,
    chatType: "direct",
    threadId: null,
    createdAt: now,
  };
  telegramRouting.routes.push(telegramRoute);
}
Object.assign(telegramRoute, {
  agentId,
  conversationId,
  enabled: true,
  outboundEnabled: true,
  updatedAt: now,
});
await writeJsonAtomic(telegramRoutingJson, telegramRouting);
await writeJsonAtomic(telegramManagedPath, {
  accountId: telegramAccountId,
  chatId: telegramChatId,
  updatedAt: now,
});

const discordAccountsPath = path.join(discordDir, "accounts.json");
const discordAccounts = await readJson([discordAccountsPath], { accounts: [] });
if (!discordAccounts || typeof discordAccounts !== "object" || !Array.isArray(discordAccounts.accounts)) {
  throw new Error("Discord accounts state has an invalid schema");
}
let discordAccount = discordAccounts.accounts.find(
  candidate => candidate?.channel === discordChannelId && candidate?.accountId === discordAccountId,
);
if (!discordAccount) {
  discordAccount = {
    channel: discordChannelId,
    accountId: discordAccountId,
    createdAt: now,
  };
  discordAccounts.accounts.push(discordAccount);
}
Object.assign(discordAccount, {
  channel: discordChannelId,
  accountId: discordAccountId,
  displayName: discordDisplayName,
  enabled: true,
  dmPolicy: "open",
  allowedUsers: [],
  config: {
    base_url: bridgeBaseUrl,
    auth: bridgeToken,
    poll_wait: true,
    request_timeout_ms: 30000,
    min_backoff_ms: 500,
    max_backoff_ms: 10000,
  },
  updatedAt: now,
});
await writeJsonAtomic(discordAccountsPath, discordAccounts);

const discordRoutingYaml = path.join(discordDir, "routing.yaml");
const discordRoutingJson = path.join(discordDir, "routing.json");
const discordRouting = await readJson([discordRoutingJson, discordRoutingYaml], { routes: [] });
if (!discordRouting || typeof discordRouting !== "object" || !Array.isArray(discordRouting.routes)) {
  throw new Error("Discord routing state has an invalid schema");
}

const managedRoutesPath = path.join(discordDir, "continuity-managed-routes.json");
const previousManaged = await readJson([managedRoutesPath], { channelIds: [] });
if (!previousManaged || typeof previousManaged !== "object" || !Array.isArray(previousManaged.channelIds)) {
  throw new Error("Discord managed-route state has an invalid schema");
}
const previousIds = new Set(previousManaged.channelIds);
const desiredIds = new Set(discordChannelIds);
discordRouting.routes = discordRouting.routes.filter(route => {
  if (route?.accountId !== discordAccountId) return true;
  const chatId = String(route?.chatId ?? "");
  return !previousIds.has(chatId) || desiredIds.has(chatId);
});

for (const channelId of discordChannelIds) {
  let route = discordRouting.routes.find(
    candidate => candidate?.accountId === discordAccountId && String(candidate?.chatId) === channelId,
  );
  if (route && !previousIds.has(channelId)) {
    const sameTarget = route.agentId === agentId && route.conversationId === conversationId &&
      route.chatType === "channel" && route.enabled !== false && route.outboundEnabled !== false;
    if (!sameTarget) throw new Error(`Discord route ${channelId} conflicts with existing unmanaged state`);
  }
  if (!route) {
    route = {
      accountId: discordAccountId,
      chatId: channelId,
      chatType: "channel",
      threadId: null,
      createdAt: now,
    };
    discordRouting.routes.push(route);
  }
  Object.assign(route, {
    agentId,
    conversationId,
    enabled: true,
    outboundEnabled: true,
    updatedAt: now,
  });
}
await writeJsonAtomic(discordRoutingJson, discordRouting);
await writeJsonAtomic(managedRoutesPath, { channelIds: discordChannelIds, updatedAt: now });

console.log(
  `Prepared one Telegram route and ${discordChannelIds.length} Discord route(s) for the selected agent conversation.`,
);

if (seedOnly) {
  console.log("SEED_ONLY complete.");
  process.exit(0);
}

let ready = false;
let stopping = false;
let child;
const port = Number(process.env.PORT || 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT is invalid");

const healthServer = createServer((request, response) => {
  response.setHeader("content-type", "application/json; charset=utf-8");
  if (request.url === "/health") {
    response.statusCode = 200;
    response.end(JSON.stringify({ status: "ok" }));
    return;
  }
  if (request.url === "/ready") {
    response.statusCode = ready ? 200 : 503;
    response.end(JSON.stringify({ status: ready ? "ready" : "starting" }));
    return;
  }
  response.statusCode = 404;
  response.end(JSON.stringify({ error: "not_found" }));
});

healthServer.listen(port, "0.0.0.0");
healthServer.on("error", error => {
  ready = false;
  console.error(`Continuity health server failed: ${error.message}`);
  if (child && child.exitCode === null) child.kill("SIGTERM");
  process.exit(1);
});

child = spawn(
  "letta",
  [
    "server",
    "--computer-name",
    (process.env.LETTA_ENV_NAME || "continuity-railway").trim(),
    "--channels",
    `telegram,${discordChannelId}`,
    "--install-channel-runtimes",
    ...(process.env.LETTA_DEBUG === "1" ? ["--debug"] : []),
  ],
  { stdio: "inherit", env: process.env },
);

child.once("spawn", () => {
  const settle = setTimeout(() => {
    if (child.exitCode === null) ready = true;
  }, 2000);
  settle.unref?.();
});

async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  ready = false;
  healthServer.close();
  if (child && child.exitCode === null) child.kill(signal);
  const force = setTimeout(() => {
    if (child && child.exitCode === null) {
      child.kill("SIGKILL");
      setTimeout(() => process.exit(1), 2000);
    }
  }, 10000);
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => { void shutdown(signal); });
}

child.on("error", error => {
  ready = false;
  console.error(`Failed to start the Letta listener: ${error.message}`);
  healthServer.close();
  process.exit(1);
});

child.on("exit", (code, signal) => {
  ready = false;
  healthServer.close();
  if (stopping && signal) process.exit(0);
  if (signal) {
    console.error(`Letta listener exited from signal ${signal}.`);
    process.exit(1);
  }
  process.exit(code ?? 1);
});
