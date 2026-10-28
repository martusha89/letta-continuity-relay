import { defineRailway, github, project, service, volume } from "railway/iac";

export default defineRailway(() => {
  const state = volume("continuity-state", {
    sizeMB: 5000,
    // Source-project synchronization only: keep its existing volume in place.
    // The generated template does not require users to choose Singapore.
    // Omitting this is interpreted as a destructive region removal on apply.
    region: "asia-southeast1-eqsg3a",
  });

  const bridge = service("discord-bridge", {
    source: github("martusha89/letta-continuity-relay", { branch: "main" }),
    build: {
      builder: "DOCKERFILE",
      dockerfilePath: "Dockerfile",
    },
    healthcheck: "/ready",
    healthcheckTimeout: 120,
    replicas: 1,
    deploy: {
      restartPolicyType: "ON_FAILURE",
      restartPolicyMaxRetries: 10,
    },
    env: {
      MCP_TRANSPORT: "http",
      MCP_HOST: "0.0.0.0",
      MCP_HTTP_BEARER_TOKEN: {
        description: "Generated administrative MCP credential. The beginner template does not expose a public bridge domain.",
        isSealed: true,
        generator: "secret(64)",
      },
      DISCORD_BRIDGE_BEARER_TOKEN: {
        description: "Generated private credential shared only with the listener.",
        isSealed: true,
        generator: "secret(64)",
      },
      DISCORD_TOKEN: {
        description: "Required Discord bot token. Enable Message Content Intent before deployment.",
        isOptional: false,
        isSealed: true,
      },
      DISCORD_ALLOWED_GUILD_IDS: {
        description: "Required comma-separated 17–20 digit Discord server IDs. Start with one server.",
        isOptional: false,
      },
      DISCORD_ALLOWED_CHANNEL_IDS: {
        description: "Required comma-separated 17–20 digit Discord channel or forum-parent IDs.",
        isOptional: false,
      },
      DISCORD_BRIDGE_ENABLED: "true",
      DISCORD_ALLOWED_DM_USER_IDS: "",
      DISCORD_ALLOWED_MENTION_USER_IDS: "",
      DISCORD_ALLOWED_MENTION_ROLE_IDS: "",
      DISCORD_BRIDGE_DM_USER_IDS: "",
      DISCORD_BRIDGE_ROLE_IDS: "",
      DISCORD_BRIDGE_ALL_MESSAGE_GUILD_IDS: "",
      DISCORD_BRIDGE_PROACTIVE_DESTINATIONS_JSON: "",
      DISCORD_BRIDGE_BOT_COOLDOWN_MS: "30000",
      DISCORD_BRIDGE_ALLOW_EVERYONE: "false",
    },
  });

  const listener = service("continuity-listener", {
    source: github("martusha89/letta-continuity-relay", {
      branch: "main",
      rootDirectory: "deploy/continuity-listener",
    }),
    build: {
      builder: "DOCKERFILE",
      dockerfilePath: "Dockerfile",
    },
    healthcheck: "/ready",
    healthcheckTimeout: 180,
    replicas: 1,
    deploy: {
      restartPolicyType: "ON_FAILURE",
      restartPolicyMaxRetries: 10,
      overlapSeconds: 0,
    },
    volumeMounts: {
      "/root": state,
    },
    env: {
      LETTA_BASE_URL: "https://api.letta.com",
      LETTA_API_KEY: {
        description: "Required Letta API key with access to the selected cloud agent.",
        isOptional: false,
        isSealed: true,
      },
      LETTA_AGENT_ID: {
        description: "Required exact existing Letta agent ID (agent-...).",
        isOptional: false,
      },
      TELEGRAM_BOT_TOKEN: {
        description: "Required Telegram bot token from official @BotFather.",
        isOptional: false,
        isSealed: true,
      },
      TELEGRAM_CHAT_ID: {
        description: "Required numeric private Telegram chat ID to allow and route.",
        isOptional: false,
      },
      LETTA_CONVERSATION_ID: "default",
      LETTA_ENV_NAME: "continuity-railway",
      LETTA_CHANNEL_CREDENTIALS_STORE: "file",
      LETTA_RESTORE_ENABLED_CHANNELS: "1",
      LETTA_LOCAL_BACKEND_EXPERIMENTAL: "0",
      TELEGRAM_ACCOUNT_ID: "continuity-main",
      TELEGRAM_DISPLAY_NAME: "Continuity Telegram",
      TELEGRAM_RICH_MESSAGES: "false",
      DISCORD_CHANNEL_ID: "continuity-discord",
      DISCORD_ACCOUNT_ID: "continuity-main",
      DISCORD_DISPLAY_NAME: "Continuity Discord",
      DISCORD_CHANNEL_CONVERSATION_OVERRIDES: "{}",
      DISCORD_BRIDGE_BASE_URL: "http://${{discord-bridge.RAILWAY_PRIVATE_DOMAIN}}:3001",
      DISCORD_BRIDGE_BEARER_TOKEN: bridge.env.DISCORD_BRIDGE_BEARER_TOKEN,
      DISCORD_CHANNEL_IDS: bridge.env.DISCORD_ALLOWED_CHANNEL_IDS,
    },
  });

  return project("letta-continuity-relay", {
    resources: [bridge, listener, state],
  });
});
