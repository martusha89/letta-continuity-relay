import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../build/config.js";

test("Railway environment variables configure a remote deployment without a config file", () => {
  const cfg = loadConfig({
    DISCORD_TOKEN: "not-a-real-token",
    MCP_TRANSPORT: "streamable-http",
    MCP_HTTP_BEARER_TOKEN: "x".repeat(32),
    MCP_CONFIG_PATH: "/definitely/missing/config.json",
    PORT: "4567",
    DISCORD_DEFAULT_GUILD_ID: "11111111111111111",
    DISCORD_ALLOWED_GUILD_IDS: "11111111111111111",
    DISCORD_ALLOWED_CHANNEL_IDS: "22222222222222222, 33333333333333333",
    DISCORD_ALLOWED_DM_USER_IDS: "",
    DISCORD_ALLOWED_MENTION_USER_IDS: "44444444444444444",
    ELEVENLABS_VOICE_ID: "voice-id",
  });

  assert.equal(cfg.http.port, 4567);
  assert.equal(cfg.defaults.guildId, "11111111111111111");
  assert.deepEqual(cfg.policy.allowedGuildIds, ["11111111111111111"]);
  assert.deepEqual(cfg.policy.allowedChannelIds, ["22222222222222222", "33333333333333333"]);
  assert.deepEqual(cfg.policy.allowedDmUserIds, []);
  assert.deepEqual(cfg.policy.allowedMentionUserIds, ["44444444444444444"]);
  assert.equal(cfg.elevenlabs.voiceId, "voice-id");
  assert.equal(cfg.limits.voiceQueueLimit, 4);
});

test("remote mode still refuses an empty target policy", () => {
  assert.throws(() => loadConfig({
    DISCORD_TOKEN: "not-a-real-token",
    MCP_TRANSPORT: "http",
    MCP_HTTP_BEARER_TOKEN: "x".repeat(32),
    MCP_CONFIG_PATH: "/definitely/missing/config.json",
    DISCORD_ALLOWED_GUILD_IDS: "",
    DISCORD_ALLOWED_CHANNEL_IDS: "",
    DISCORD_ALLOWED_DM_USER_IDS: "",
  }), /explicit policy allowlist/);
});

test("invalid policy environment values fail closed", () => {
  assert.throws(() => loadConfig({
    DISCORD_TOKEN: "not-a-real-token",
    MCP_CONFIG_PATH: "/definitely/missing/config.json",
    DISCORD_ALLOWED_GUILD_IDS: "not-a-snowflake",
  }), /Discord snowflakes/);
});

test("an unrelated PORT does not affect stdio mode", () => {
  const cfg = loadConfig({
    DISCORD_TOKEN: "not-a-real-token",
    MCP_CONFIG_PATH: "/definitely/missing/config.json",
    MCP_TRANSPORT: "stdio",
    PORT: "not-a-port",
  });
  assert.equal(cfg.http.port, 3001);
});
