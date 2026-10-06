const TELEGRAM_BOT_TOKEN = /^\d{5,}:[A-Za-z0-9_-]{20,}$/;
const TELEGRAM_CHAT_ID = /^\d+$/;
const REQUEST_TIMEOUT_MS = 15_000;

export function proactiveTelegramConfig(env = process.env) {
  const token = String(env.TELEGRAM_BOT_TOKEN ?? "").trim();
  const chatId = String(env.TELEGRAM_CHAT_ID ?? "").trim();
  if (!TELEGRAM_BOT_TOKEN.test(token)) {
    throw new Error("TELEGRAM_BOT_TOKEN has an invalid format");
  }
  if (!TELEGRAM_CHAT_ID.test(chatId)) {
    throw new Error("TELEGRAM_CHAT_ID must be a numeric private-chat ID");
  }
  return { token, chatId };
}

export function createProactiveTelegramTool(config, fetchImpl = globalThis.fetch) {
  return {
    name: "proactive_telegram_send",
    description:
      "Deliberately send Marta a brief private Telegram update from another routed context. Use for genuine context or safety updates, not obligatory surveillance or mirrored conversation. Ordinary replies must use MessageChannel and remain pinned to their source.",
    parameters: {
      type: "object",
      properties: {
        message: {
          type: "string",
          minLength: 1,
          maxLength: 4096,
          description: "Private update for Marta. The destination is fixed by listener configuration.",
        },
      },
      required: ["message"],
      additionalProperties: false,
    },
    parallelSafe: false,
    async run(ctx) {
      if (!ctx.args || typeof ctx.args !== "object" || Array.isArray(ctx.args)) {
        return { status: "error", content: "proactive Telegram arguments are invalid" };
      }
      if (Object.keys(ctx.args).some(key => key !== "message")) {
        return { status: "error", content: "proactive Telegram accepts only a message" };
      }
      const message = ctx.args.message;
      if (typeof message !== "string" || !message.trim()) {
        return { status: "error", content: "message is required" };
      }
      if (message.length > 4096) {
        return { status: "error", content: "message exceeds Telegram's 4096 character limit" };
      }

      const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
      const signal = ctx.signal ? AbortSignal.any([ctx.signal, timeout]) : timeout;
      let response;
      try {
        response = await fetchImpl(`https://api.telegram.org/bot${config.token}/sendMessage`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ chat_id: config.chatId, text: message }),
          signal,
        });
      } catch {
        return {
          status: "error",
          content: "Proactive Telegram send has unknown delivery status; do not repeat it automatically",
        };
      }

      let body = null;
      const contentType = response.headers.get("content-type") ?? "";
      if (contentType.toLowerCase().includes("application/json")) {
        try { body = await response.json(); } catch {}
      }
      if (!response.ok) {
        return { status: "error", content: "Proactive Telegram send was rejected" };
      }
      if (body?.ok !== true || !Number.isInteger(body?.result?.message_id) || body.result.message_id < 1 ||
          String(body?.result?.chat?.id ?? "") !== config.chatId) {
        return {
          status: "error",
          content: "Proactive Telegram returned an invalid receipt; delivery status is unknown, so do not repeat it automatically",
        };
      }
      return `Private Telegram update sent to Marta (message_id: ${body.result.message_id})`;
    },
  };
}

export default function activate(letta) {
  if (!letta.capabilities.tools) return;
  let config;
  try {
    config = proactiveTelegramConfig();
  } catch (error) {
    letta.diagnostics?.report?.({
      severity: "error",
      message: `Proactive Telegram tool unavailable: ${error instanceof Error ? error.message : "invalid Telegram configuration"}`,
    });
    return;
  }
  return letta.tools.register(createProactiveTelegramTool(config));
}
