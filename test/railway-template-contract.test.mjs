import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { loadConfig } from "../build/config.js";

const railwaySource = await readFile(new URL("../.railway/railway.ts", import.meta.url), "utf8");
const bridgeDockerfile = await readFile(new URL("../Dockerfile", import.meta.url), "utf8");
const listenerDockerfile = await readFile(
  new URL("../deploy/continuity-listener/Dockerfile", import.meta.url),
  "utf8",
);
const listenerEntrypoint = await readFile(
  new URL("../deploy/continuity-listener/entrypoint.mjs", import.meta.url),
  "utf8",
);

test("Railway authoring exposes exactly seven human inputs and two generated credentials", () => {
  const envKeys = [...railwaySource.matchAll(/^      ([A-Z][A-Z0-9_]+):/gm)].map(match => match[1]).sort();
  assert.deepEqual(envKeys, [
    "DISCORD_ALLOWED_CHANNEL_IDS",
    "DISCORD_ALLOWED_GUILD_IDS",
    "DISCORD_BRIDGE_BASE_URL",
    "DISCORD_BRIDGE_BEARER_TOKEN",
    "DISCORD_BRIDGE_BEARER_TOKEN",
    "DISCORD_CHANNEL_IDS",
    "DISCORD_TOKEN",
    "LETTA_AGENT_ID",
    "LETTA_API_KEY",
    "MCP_HTTP_BEARER_TOKEN",
    "TELEGRAM_BOT_TOKEN",
    "TELEGRAM_CHAT_ID",
  ]);
  assert.equal((railwaySource.match(/isOptional: false/g) ?? []).length, 7);
  assert.equal((railwaySource.match(/generator: "secret\(64\)"/g) ?? []).length, 2);
  // Two generated credentials plus the three human-supplied token/key secrets.
  assert.equal((railwaySource.match(/isSealed: true/g) ?? []).length, 5);
  assert.equal((railwaySource.match(/bridge\.env\./g) ?? []).length, 2);
  assert.equal((railwaySource.match(/RAILWAY_PRIVATE_DOMAIN/g) ?? []).length, 1);
});

test("Railway topology remains private, single-replica, persistent, and always-on", () => {
  assert.equal((railwaySource.match(/\bservice\(/g) ?? []).length, 2);
  assert.equal((railwaySource.match(/\bvolume\(/g) ?? []).length, 1);
  assert.equal((railwaySource.match(/cronSchedule: null/g) ?? []).length, 2);
  assert.equal((railwaySource.match(/replicas: 1/g) ?? []).length, 2);
  assert.match(railwaySource, /"\/root": state/);
  assert.match(railwaySource, /resources: \[bridge, listener, state\]/);
  assert.doesNotMatch(railwaySource, /\bdomain\(|\bnetworking\s*:|RAILWAY_PUBLIC_DOMAIN/);
});

test("ordinary service variables stay in image and runtime defaults", () => {
  for (const expected of [
    "MCP_TRANSPORT=http",
    "MCP_HOST=0.0.0.0",
    "DISCORD_BRIDGE_ENABLED=true",
    "DISCORD_BRIDGE_ALLOW_EVERYONE=false",
    "DISCORD_BRIDGE_BOT_COOLDOWN_MS=30000",
  ]) {
    assert.ok(bridgeDockerfile.includes(expected), `bridge image is missing ${expected}`);
  }
  for (const expected of [
    "LETTA_BASE_URL=https://api.letta.com",
    "LETTA_CHANNEL_CREDENTIALS_STORE=file",
    "LETTA_RESTORE_ENABLED_CHANNELS=1",
    "LETTA_LOCAL_BACKEND_EXPERIMENTAL=0",
  ]) {
    assert.ok(listenerDockerfile.includes(expected), `listener image is missing ${expected}`);
  }

  for (const expected of [
    'process.env.LETTA_CONVERSATION_ID || "default"',
    'process.env.LETTA_ENV_NAME || "continuity-railway"',
    'process.env.TELEGRAM_ACCOUNT_ID || "continuity-main"',
    'process.env.TELEGRAM_DISPLAY_NAME || "Continuity Telegram"',
    'process.env.DISCORD_ACCOUNT_ID || "continuity-main"',
    'process.env.DISCORD_DISPLAY_NAME || "Continuity Discord"',
    'process.env.DISCORD_CHANNEL_CONVERSATION_OVERRIDES || "{}"',
    'requestedDiscordChannelId || "continuity-discord"',
    'process.env.TELEGRAM_RICH_MESSAGES === "true"',
  ]) {
    assert.ok(listenerEntrypoint.includes(expected), `listener runtime is missing ${expected}`);
  }

  const bridge = loadConfig({
    DISCORD_TOKEN: "not-a-real-token",
    MCP_TRANSPORT: "http",
    MCP_HTTP_BEARER_TOKEN: "m".repeat(64),
    MCP_CONFIG_PATH: "/definitely/missing/config.json",
    DISCORD_ALLOWED_GUILD_IDS: "111111111111111111",
    DISCORD_ALLOWED_CHANNEL_IDS: "222222222222222222",
    DISCORD_BRIDGE_ENABLED: "true",
    DISCORD_BRIDGE_BEARER_TOKEN: "b".repeat(64),
  });
  assert.deepEqual(bridge.policy.allowedDmUserIds, []);
  assert.deepEqual(bridge.policy.allowedMentionUserIds, []);
  assert.deepEqual(bridge.policy.allowedMentionRoleIds, []);
  assert.deepEqual(bridge.bridge.dmUserIds, []);
  assert.deepEqual(bridge.bridge.roleIds, []);
  assert.deepEqual(bridge.bridge.allMessageGuildIds, []);
  assert.equal(bridge.bridge.proactiveDestinations.size, 0);
  assert.equal(bridge.bridge.allowEveryone, false);
  assert.equal(bridge.bridge.botCooldownMs, 30000);
});
