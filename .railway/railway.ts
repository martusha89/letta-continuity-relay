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
      // Railway's template serializer needs an explicit null schedule to
      // distinguish an ordinary always-on service from an unconfigured cron.
      cronSchedule: null,
      restartPolicyType: "ON_FAILURE",
      restartPolicyMaxRetries: 10,
    },
    env: {
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
      // See the bridge service note above. Null means no cron.
      cronSchedule: null,
      restartPolicyType: "ON_FAILURE",
      restartPolicyMaxRetries: 10,
      overlapSeconds: 0,
    },
    volumeMounts: {
      "/root": state,
    },
    env: {
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
      DISCORD_BRIDGE_BASE_URL: "http://${{discord-bridge.RAILWAY_PRIVATE_DOMAIN}}:3001",
      DISCORD_BRIDGE_BEARER_TOKEN: bridge.env.DISCORD_BRIDGE_BEARER_TOKEN,
      DISCORD_CHANNEL_IDS: bridge.env.DISCORD_ALLOWED_CHANNEL_IDS,
    },
  });

  return project("letta-continuity-relay", {
    resources: [bridge, listener, state],
  });
});
