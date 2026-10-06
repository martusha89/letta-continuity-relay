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
    DISCORD_ALLOWED_MENTION_ROLE_IDS: "55555555555555555",
    ELEVENLABS_VOICE_ID: "voice-id",
  });

  assert.equal(cfg.http.port, 4567);
  assert.equal(cfg.defaults.guildId, "11111111111111111");
  assert.deepEqual(cfg.policy.allowedGuildIds, ["11111111111111111"]);
  assert.deepEqual(cfg.policy.allowedChannelIds, ["22222222222222222", "33333333333333333"]);
  assert.deepEqual(cfg.policy.allowedDmUserIds, []);
  assert.deepEqual(cfg.policy.allowedMentionUserIds, ["44444444444444444"]);
  assert.deepEqual(cfg.policy.allowedMentionRoleIds, ["55555555555555555"]);
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

test("proactive destination registry is empty by default and parsed when provided", () => {
  const base = {
    DISCORD_TOKEN: "not-a-real-token",
    MCP_TRANSPORT: "http",
    MCP_HTTP_BEARER_TOKEN: "x".repeat(32),
    MCP_CONFIG_PATH: "/definitely/missing/config.json",
    DISCORD_ALLOWED_GUILD_IDS: "11111111111111111",
    DISCORD_BRIDGE_ENABLED: "true",
    DISCORD_BRIDGE_BEARER_TOKEN: "b".repeat(32),
  };
  const empty = loadConfig({ ...base });
  assert.equal(empty.bridge.proactiveDestinations.size, 0);

  const configured = loadConfig({
    ...base,
    DISCORD_BRIDGE_PROACTIVE_DESTINATIONS_JSON: JSON.stringify({
      "aidhd.porch": {
        guildId: "11111111111111111",
        channelId: "22222222222222222",
        mentions: { marta: { kind: "user", id: "33333333333333333" } },
      },
    }),
  });
  assert.equal(configured.bridge.proactiveDestinations.size, 1);
  const porch = configured.bridge.proactiveDestinations.get("aidhd.porch");
  assert.equal(porch.guildId, "11111111111111111");
  assert.equal(porch.channelId, "22222222222222222");
  assert.deepEqual(porch.mentions.get("marta"), { kind: "user", id: "33333333333333333" });

  // Malformed registries fail closed at config load.
  assert.throws(() => loadConfig({ ...base, DISCORD_BRIDGE_PROACTIVE_DESTINATIONS_JSON: "{oops" }), /strict JSON/);
  assert.throws(() => loadConfig({
    ...base,
    DISCORD_BRIDGE_PROACTIVE_DESTINATIONS_JSON: JSON.stringify({
      porch: { guildId: "11111111111111111", channelId: "22222222222222222" },
      PORCH: { guildId: "11111111111111111", channelId: "22222222222222222" },
    }),
  }), /duplicate destination alias/);
});

test("invalid DISCORD_ALLOWED_MENTION_ROLE_IDS fails closed", () => {
  assert.throws(() => loadConfig({
    DISCORD_TOKEN: "not-a-real-token",
    MCP_CONFIG_PATH: "/definitely/missing/config.json",
    DISCORD_ALLOWED_MENTION_ROLE_IDS: "not-a-snowflake",
  }), /Discord snowflakes/);
});
