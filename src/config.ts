import dotenv from "dotenv";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: join(PROJECT_ROOT, ".env") });

const snowflake = z.string().regex(/^\d{17,20}$/, "must be a Discord snowflake");
const nonNegativeInt = z.number().int().nonnegative();
const positiveInt = z.number().int().positive();

const fileSchema = z.object({
  elevenlabs: z.object({
    voiceId: z.string().default(""),
    modelId: z.string().default("eleven_turbo_v2_5"),
    stability: z.number().min(0).max(1).default(0.5),
    similarityBoost: z.number().min(0).max(1).default(0.75),
    style: z.number().min(0).max(1).default(0),
    useSpeakerBoost: z.boolean().default(true),
  }).partial().optional(),
  defaults: z.object({ guildId: z.union([snowflake, z.literal("")]).optional() }).optional(),
  policy: z.object({
    allowedGuildIds: z.array(snowflake).default([]),
    allowedChannelIds: z.array(snowflake).default([]),
    allowedDmUserIds: z.array(snowflake).default([]),
    allowedMentionUserIds: z.array(snowflake).default([]),
    allowLocalFiles: z.boolean().default(false),
    allowedLocalRoots: z.array(z.string().min(1)).default([]),
  }).partial().optional(),
  limits: z.object({
    messageChars: positiveInt.default(2000),
    ttsChars: positiveInt.default(2000),
    attachmentBytes: positiveInt.default(8 * 1024 * 1024),
    attachmentTimeoutMs: positiveInt.default(15000),
    elevenLabsTimeoutMs: positiveInt.default(30000),
    ffmpegTimeoutMs: positiveInt.default(30000),
    voiceConcurrency: positiveInt.max(8).default(2),
    voiceQueueLimit: nonNegativeInt.max(64).default(4),
    typingDelayMinMs: nonNegativeInt.default(0),
    typingDelayMaxMs: nonNegativeInt.default(0),
  }).partial().optional(),
}).strict();

export interface ElevenLabsConfig {
  voiceId: string;
  modelId: string;
  stability: number;
  similarityBoost: number;
  style: number;
  useSpeakerBoost: boolean;
}
export interface AccessPolicy {
  allowedGuildIds: string[];
  allowedChannelIds: string[];
  allowedDmUserIds: string[];
  allowedMentionUserIds: string[];
  allowLocalFiles: boolean;
  allowedLocalRoots: string[];
  remoteMode: boolean;
}
export interface LimitsConfig {
  messageChars: number;
  ttsChars: number;
  attachmentBytes: number;
  attachmentTimeoutMs: number;
  elevenLabsTimeoutMs: number;
  ffmpegTimeoutMs: number;
  voiceConcurrency: number;
  voiceQueueLimit: number;
  typingDelayMinMs: number;
  typingDelayMaxMs: number;
}
export interface BridgeConfig {
  enabled: boolean;
  bearerToken: string | null;
  dmUserIds: string[];
  /** Optional inbound-only channel/thread fence, narrower than the shared MCP policy. */
  channelIds: string[];
  /** Guild roles whose mention deliberately addresses the bot. */
  roleIds: string[];
  /** Whether @everyone and @here deliberately address the bot. */
  allowEveryone: boolean;
  queueLimit: number;
  pollTimeoutMs: number;
  jsonLimitBytes: number;
  rateLimitPerMinute: number;
}
export interface RuntimeConfig {
  discordToken: string;
  elevenLabsApiKey: string | null;
  elevenlabs: ElevenLabsConfig;
  defaults: { guildId?: string };
  policy: AccessPolicy;
  limits: LimitsConfig;
  transport: "stdio" | "http";
  http: {
    host: string;
    port: number;
    bearerToken: string | null;
    allowedOrigins: string[];
    jsonLimitBytes: number;
    rateLimitPerMinute: number;
  };
  bridge: BridgeConfig;
}

const ELEVEN_DEFAULTS: ElevenLabsConfig = {
  voiceId: "", modelId: "eleven_turbo_v2_5", stability: 0.5,
  similarityBoost: 0.75, style: 0, useSpeakerBoost: true,
};
const LIMIT_DEFAULTS: LimitsConfig = {
  messageChars: 2000, ttsChars: 2000, attachmentBytes: 8 * 1024 * 1024,
  attachmentTimeoutMs: 15000, elevenLabsTimeoutMs: 30000, ffmpegTimeoutMs: 30000,
  voiceConcurrency: 2, voiceQueueLimit: 4, typingDelayMinMs: 0, typingDelayMaxMs: 0,
};

function parseInteger(name: string, value: string | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || value === "") return fallback;
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be an integer between ${min} and ${max}`);
  const result = Number(value);
  if (result < min || result > max) throw new Error(`${name} must be between ${min} and ${max}`);
  return result;
}

export function normalizeTransport(value: string | undefined): "stdio" | "http" {
  const mode = (value ?? "stdio").trim().toLowerCase();
  if (mode === "sse") {
    console.error("[config] MCP_TRANSPORT=sse is deprecated; use streamable-http");
    return "http";
  }
  if (mode === "http" || mode === "streamable-http") return "http";
  if (mode === "stdio") return "stdio";
  throw new Error("MCP_TRANSPORT must be stdio, http, or streamable-http (sse is a deprecated alias)");
}

function loadConfigFile(env: NodeJS.ProcessEnv): unknown {
  const path = env.MCP_CONFIG_PATH ? resolve(env.MCP_CONFIG_PATH) : join(PROJECT_ROOT, "config.json");
  if (!existsSync(path)) return {};
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch { throw new Error(`Configuration file is not valid JSON: ${path}`); }
}

function parseSnowflakeList(name: string, value: string | undefined, fallback: string[]): string[] {
  if (value === undefined) return fallback;
  const parsed = value.split(",").map(item => item.trim()).filter(Boolean);
  const invalid = parsed.find(item => !/^\d{17,20}$/.test(item));
  if (invalid) throw new Error(`${name} must be a comma-separated list of Discord snowflakes`);
  return [...new Set(parsed)];
}

function parseSnowflake(name: string, value: string | undefined, fallback: string | undefined): string | undefined {
  const parsed = value === undefined ? fallback : value.trim() || undefined;
  if (parsed && !/^\d{17,20}$/.test(parsed)) throw new Error(`${name} must be a Discord snowflake`);
  return parsed;
}

function parseBoolean(name: string, value: string | undefined, fallback = false): boolean {
  if (value === undefined || value === "") return fallback;
  const normalized = value.trim().toLowerCase();
  if (normalized === "true" || normalized === "1") return true;
  if (normalized === "false" || normalized === "0") return false;
  throw new Error(`${name} must be true or false`);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const discordToken = env.DISCORD_TOKEN?.trim();
  if (!discordToken) throw new Error("DISCORD_TOKEN is required");
  const parsed = fileSchema.safeParse(loadConfigFile(env));
  if (!parsed.success) throw new Error(`Invalid config.json: ${parsed.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  const file = parsed.data;
  const transport = normalizeTransport(env.MCP_TRANSPORT);
  const allowedOrigins = (env.MCP_ALLOWED_ORIGINS ?? "").split(",").map(v => v.trim()).filter(Boolean);
  for (const origin of allowedOrigins) {
    if (origin === "*" || new URL(origin).origin !== origin) throw new Error("MCP_ALLOWED_ORIGINS must contain exact http(s) origins and cannot use *");
  }
  const bearerToken = env.MCP_HTTP_BEARER_TOKEN?.trim() || null;
  if (transport === "http" && (!bearerToken || bearerToken.length < 24)) {
    throw new Error("MCP_HTTP_BEARER_TOKEN is required in HTTP mode and must be at least 24 characters");
  }
  const guilds = parseSnowflakeList("DISCORD_ALLOWED_GUILD_IDS", env.DISCORD_ALLOWED_GUILD_IDS, file.policy?.allowedGuildIds ?? []);
  const channels = parseSnowflakeList("DISCORD_ALLOWED_CHANNEL_IDS", env.DISCORD_ALLOWED_CHANNEL_IDS, file.policy?.allowedChannelIds ?? []);
  const dms = parseSnowflakeList("DISCORD_ALLOWED_DM_USER_IDS", env.DISCORD_ALLOWED_DM_USER_IDS, file.policy?.allowedDmUserIds ?? []);
  const mentions = parseSnowflakeList("DISCORD_ALLOWED_MENTION_USER_IDS", env.DISCORD_ALLOWED_MENTION_USER_IDS, file.policy?.allowedMentionUserIds ?? []);
  if (transport === "http" && guilds.length === 0 && channels.length === 0 && dms.length === 0) {
    throw new Error("HTTP mode requires an explicit policy allowlist in config.json");
  }
  const roots = (file.policy?.allowedLocalRoots ?? []).map(root => resolve(PROJECT_ROOT, root));
  const allowLocalFiles = file.policy?.allowLocalFiles ?? false;
  if (allowLocalFiles && roots.length === 0) throw new Error("policy.allowedLocalRoots is required when allowLocalFiles is true");

  const bridgeEnabled = parseBoolean("DISCORD_BRIDGE_ENABLED", env.DISCORD_BRIDGE_ENABLED, false);
  const bridgeBearerToken = env.DISCORD_BRIDGE_BEARER_TOKEN?.trim() || null;
  const bridgeDmUserIds = parseSnowflakeList("DISCORD_BRIDGE_DM_USER_IDS", env.DISCORD_BRIDGE_DM_USER_IDS, []);
  const bridgeChannelIds = parseSnowflakeList("DISCORD_BRIDGE_CHANNEL_IDS", env.DISCORD_BRIDGE_CHANNEL_IDS, []);
  const bridgeRoleIds = parseSnowflakeList("DISCORD_BRIDGE_ROLE_IDS", env.DISCORD_BRIDGE_ROLE_IDS, []);
  const bridgeAllowEveryone = parseBoolean("DISCORD_BRIDGE_ALLOW_EVERYONE", env.DISCORD_BRIDGE_ALLOW_EVERYONE, false);
  if (bridgeEnabled) {
    if (!bridgeBearerToken || bridgeBearerToken.length < 32) {
      throw new Error("DISCORD_BRIDGE_BEARER_TOKEN is required when DISCORD_BRIDGE_ENABLED is true and must be at least 32 characters");
    }
    if (bridgeBearerToken === bearerToken) {
      throw new Error("DISCORD_BRIDGE_BEARER_TOKEN must be distinct from MCP_HTTP_BEARER_TOKEN");
    }
    if (transport !== "http") {
      throw new Error("DISCORD_BRIDGE_ENABLED requires MCP_TRANSPORT=http (bridge endpoints are served over HTTP)");
    }
    if (guilds.length === 0 && channels.length === 0 && bridgeDmUserIds.length === 0) {
      throw new Error("DISCORD_BRIDGE_ENABLED requires an explicit policy allowlist (guilds, channels, or bridge DM users)");
    }
  }
  const bridge: BridgeConfig = {
    enabled: bridgeEnabled,
    bearerToken: bridgeBearerToken,
    dmUserIds: bridgeDmUserIds,
    channelIds: bridgeChannelIds,
    roleIds: bridgeRoleIds,
    allowEveryone: bridgeAllowEveryone,
    queueLimit: parseInteger("DISCORD_BRIDGE_QUEUE_LIMIT", env.DISCORD_BRIDGE_QUEUE_LIMIT, 256, 1, 10000),
    pollTimeoutMs: parseInteger("DISCORD_BRIDGE_POLL_TIMEOUT_MS", env.DISCORD_BRIDGE_POLL_TIMEOUT_MS, 20000, 0, 120000),
    jsonLimitBytes: parseInteger("DISCORD_BRIDGE_JSON_LIMIT_BYTES", env.DISCORD_BRIDGE_JSON_LIMIT_BYTES, 64 * 1024, 1024, 1024 * 1024),
    rateLimitPerMinute: parseInteger("DISCORD_BRIDGE_RATE_LIMIT_PER_MINUTE", env.DISCORD_BRIDGE_RATE_LIMIT_PER_MINUTE, 120, 1, 10000),
  };

  return {
    discordToken,
    elevenLabsApiKey: env.ELEVENLABS_API_KEY?.trim() || null,
    elevenlabs: { ...ELEVEN_DEFAULTS, ...file.elevenlabs, ...(env.ELEVENLABS_VOICE_ID !== undefined ? { voiceId: env.ELEVENLABS_VOICE_ID.trim() } : {}) },
    defaults: { guildId: parseSnowflake("DISCORD_DEFAULT_GUILD_ID", env.DISCORD_DEFAULT_GUILD_ID, file.defaults?.guildId || undefined) },
    policy: {
      allowedGuildIds: guilds,
      allowedChannelIds: channels,
      allowedDmUserIds: dms,
      allowedMentionUserIds: mentions,
      allowLocalFiles,
      allowedLocalRoots: roots,
      remoteMode: transport === "http",
    },
    limits: { ...LIMIT_DEFAULTS, ...file.limits },
    transport,
    http: {
      host: env.MCP_HOST?.trim() || "127.0.0.1",
      port: parseInteger("MCP_PORT", transport === "http" ? env.MCP_PORT ?? env.PORT : env.MCP_PORT, 3001, 1, 65535),
      bearerToken,
      allowedOrigins,
      jsonLimitBytes: parseInteger("MCP_JSON_LIMIT_BYTES", env.MCP_JSON_LIMIT_BYTES, 1024 * 1024, 1024, 4 * 1024 * 1024),
      rateLimitPerMinute: parseInteger("MCP_RATE_LIMIT_PER_MINUTE", env.MCP_RATE_LIMIT_PER_MINUTE, 60, 1, 10000),
    },
    bridge,
  };
}

export function isElevenLabsReady(cfg: RuntimeConfig): boolean {
  return Boolean(cfg.elevenLabsApiKey && cfg.elevenlabs.voiceId);
}
