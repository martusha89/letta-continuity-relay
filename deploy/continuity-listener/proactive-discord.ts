import { randomUUID } from "node:crypto";

const DESTINATION_ALIAS = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const DISCORD_SNOWFLAKE = /^\d{17,20}$/;
const REQUEST_TIMEOUT_MS = 15_000;

function parseBridgeUrl(value) {
  try {
    const parsed = new URL(String(value ?? "").trim());
    if (parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error();
    const hostname = parsed.hostname.toLowerCase();
    const privateHttp = parsed.protocol === "http:" &&
      (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname.endsWith(".railway.internal"));
    if (parsed.protocol !== "https:" && !privateHttp) throw new Error();
    parsed.pathname = parsed.pathname.replace(/\/+$/, "");
    return parsed.toString().replace(/\/$/, "");
  } catch {
    throw new Error("DISCORD_BRIDGE_BASE_URL must be HTTPS or private HTTP without credentials, query, or fragment");
  }
}

export function proactiveDiscordConfig(env = process.env) {
  const auth = String(env.DISCORD_BRIDGE_BEARER_TOKEN ?? "").trim();
  if (auth.length < 32) throw new Error("DISCORD_BRIDGE_BEARER_TOKEN must be at least 32 characters");
  return { baseUrl: parseBridgeUrl(env.DISCORD_BRIDGE_BASE_URL), auth };
}

function normalizedAliases(value, label) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  const aliases = value.map(item => String(item).trim().toLowerCase());
  if (aliases.some(alias => !DESTINATION_ALIAS.test(alias) || DISCORD_SNOWFLAKE.test(alias))) {
    throw new Error(`${label} contains an invalid alias`);
  }
  if (new Set(aliases).size !== aliases.length) throw new Error(`${label} contains a duplicate alias`);
  return aliases;
}

export function createProactiveDiscordTool(config, fetchImpl = globalThis.fetch) {
  return {
    name: "proactive_discord_send",
    description:
      "Intentionally initiate a new Discord message at a preconfigured named destination, even when the current turn arrived through another channel or has no inbound route. Use only for deliberate proactive outreach; ordinary replies must use MessageChannel and remain pinned to their source.",
    parameters: {
      type: "object",
      properties: {
        destination: {
          type: "string",
          pattern: "^[a-z0-9]+(?:[._-][a-z0-9]+)*$",
          description: "Verified configured destination alias, for example aidhd.porch. Never pass a Discord channel ID.",
        },
        message: { type: "string", minLength: 1, description: "Message text." },
        mentions: {
          type: "array",
          items: { type: "string", pattern: "^[a-z0-9]+(?:[._-][a-z0-9]+)*$" },
          uniqueItems: true,
          description: "Optional configured mention aliases. Never pass Discord user or role IDs.",
        },
      },
      required: ["destination", "message"],
      additionalProperties: false,
    },
    parallelSafe: false,
    async run(ctx) {
      if (!ctx.args || typeof ctx.args !== "object" || Array.isArray(ctx.args)) {
        return { status: "error", content: "proactive Discord arguments are invalid" };
      }
      const allowedKeys = new Set(["destination", "message", "mentions"]);
      if (Object.keys(ctx.args).some(key => !allowedKeys.has(key))) {
        return { status: "error", content: "proactive Discord accepts only destination, message, and mention aliases" };
      }
      const destination = String(ctx.args.destination ?? "").trim().toLowerCase();
      const message = String(ctx.args.message ?? "");
      if (!DESTINATION_ALIAS.test(destination) || DISCORD_SNOWFLAKE.test(destination)) {
        return { status: "error", content: "destination must be a configured alias, not a raw channel ID" };
      }
      if (!message.trim()) return { status: "error", content: "message is required" };
      let mentions;
      try {
        mentions = normalizedAliases(ctx.args.mentions, "mentions");
      } catch (error) {
        return { status: "error", content: error instanceof Error ? error.message : "mentions are invalid" };
      }

      const requestId = randomUUID();
      const requestBody = JSON.stringify({
        kind: "proactive_send",
        requestId,
        destination,
        text: message,
        ...(mentions.length ? { mentions } : {}),
      });
      let response = null;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
        const signal = ctx.signal ? AbortSignal.any([ctx.signal, timeout]) : timeout;
        try {
          response = await fetchImpl(`${config.baseUrl}/bridge/send`, {
            method: "POST",
            headers: {
              authorization: `Bearer ${config.auth}`,
              "content-type": "application/json",
            },
            body: requestBody,
            signal,
          });
          if (response.ok || (response.status < 500 && response.status !== 429)) break;
        } catch {
          response = null;
        }
        if (ctx.signal?.aborted) break;
      }
      if (!response) {
        return {
          status: "error",
          content: ctx.signal?.aborted
            ? "Proactive Discord send was cancelled"
            : "Proactive Discord send has unknown delivery status; do not repeat it automatically",
        };
      }

      let body = null;
      const contentType = response.headers.get("content-type") ?? "";
      if (contentType.toLowerCase().includes("application/json")) {
        try { body = await response.json(); } catch {}
      }
      if (!response.ok) {
        const safeMessage = typeof body?.message === "string" && body.message.length <= 200
          ? body.message
          : "Proactive Discord send was rejected";
        return { status: "error", content: safeMessage };
      }
      if (body?.ok !== true || body?.kind !== "proactive_send" ||
          !/^\d{17,20}$/.test(String(body?.messageId ?? "")) ||
          body?.destination !== destination || body?.requestId !== requestId) {
        return { status: "error", content: "Proactive Discord bridge returned an invalid receipt" };
      }
      return `Message sent to ${destination} (message_id: ${body.messageId})`;
    },
  };
}

export default function activate(letta) {
  if (!letta.capabilities.tools) return;
  let config;
  try {
    config = proactiveDiscordConfig();
  } catch (error) {
    letta.diagnostics.report({
      severity: "error",
      message: `Proactive Discord tool unavailable: ${error instanceof Error ? error.message : "invalid bridge configuration"}`,
    });
    return;
  }
  return letta.tools.register(createProactiveDiscordTool(config));
}
