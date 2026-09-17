import fs from "node:fs";
import path from "node:path";

const ROUTE_MAX_AGE_MS = 15 * 60 * 1000;
const ALLOWED_CHANNELS = new Set(["telegram", "continuity-discord"]);

function textPartsFromContent(content) {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  return content
    .filter(part => part?.type === "text" && typeof part.text === "string")
    .map(part => part.text);
}

function attribute(tag, name) {
  return tag.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1] ?? null;
}

function approvedRoute(route, agentId, conversationId, home) {
  if (!ALLOWED_CHANNELS.has(route.channel) || !route.accountId) return false;
  const directory = path.join(home, ".letta", "channels", route.channel);
  for (const name of ["routing.json", "routing.yaml"]) {
    const file = path.join(directory, name);
    try {
      const metadata = fs.lstatSync(file);
      const currentUid = typeof process.getuid === "function" ? process.getuid() : metadata.uid;
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.uid !== currentUid || (metadata.mode & 0o022) !== 0) {
        return false;
      }
      const state = JSON.parse(fs.readFileSync(file, "utf8"));
      if (!state || !Array.isArray(state.routes)) return false;
      return state.routes.some(candidate =>
        candidate?.accountId === route.accountId &&
        String(candidate?.chatId ?? "") === route.chatId &&
        candidate?.agentId === agentId &&
        candidate?.conversationId === conversationId &&
        candidate?.enabled !== false &&
        candidate?.outboundEnabled !== false
      );
    } catch (error) {
      if (error?.code !== "ENOENT") return false;
    }
  }
  return false;
}

export function extractSingleChannelRoute(input, options = {}) {
  const routes = [];
  for (const item of input ?? []) {
    if (item?.type === "approval" || item?.role !== "user") continue;
    for (const text of textPartsFromContent(item.content)) {
      // Letta's channel gateway creates this outer wrapper and XML-escapes the
      // user's message body. Requiring the wrapper at the beginning of one
      // content part prevents channel text from manufacturing a second tag.
      const tag = text.match(/^<channel-notification\b[^>]*>/)?.[0];
      if (!tag) continue;
      const channel = attribute(tag, "source");
      const chatId = attribute(tag, "chat_id");
      const accountId = attribute(tag, "account_id");
      if (!channel || !chatId || !accountId) continue;
      routes.push({
        channel,
        chatId,
        accountId,
        threadId: attribute(tag, "thread_id"),
      });
    }
  }

  const unique = new Map();
  for (const route of routes) {
    const key = [route.channel, route.accountId ?? "", route.chatId, route.threadId ?? ""].join(":");
    unique.set(key, route);
  }
  if (unique.size !== 1) return null;
  const route = [...unique.values()][0];
  const home = options.home ?? process.env.HOME ?? "/root";
  return approvedRoute(route, options.agentId, options.conversationId, home) ? route : null;
}

function containsUserMessage(input) {
  return (input ?? []).some(item => item?.type !== "approval" && item?.role === "user");
}

function isMessageChannelTool(toolName) {
  const leaf = String(toolName ?? "").split(".").at(-1) ?? "";
  return leaf.replace(/[^a-z0-9]/gi, "").toLowerCase() === "messagechannel";
}

function routeReminder(route) {
  return [
    `Deterministic channel route guard: this turn arrived through ${route.channel} chat ${route.chatId}.`,
    "The shared MessageChannel schema can remain stale after another channel used this same conversation.",
    "For any user-visible reply, call MessageChannel once as usual; the route guard will pin the executed channel, account, chat, and thread back to this notification source.",
    "Do not deliberately cross-post from this routed turn.",
  ].join(" ");
}

export default function activate(letta) {
  if (!letta.capabilities.events.turns || !letta.capabilities.events.tools) return;

  const agentId = process.env.LETTA_AGENT_ID?.trim();
  const conversationId = (process.env.LETTA_CONVERSATION_ID || "default").trim();
  if (!agentId) {
    letta.diagnostics?.report?.({
      severity: "error",
      message: "channel-reply-route-guard requires LETTA_AGENT_ID",
    });
    return;
  }

  const activeRoutes = new Map();
  const keyFor = (candidateAgentId, candidateConversationId) =>
    `${candidateAgentId ?? ""}:${candidateConversationId ?? ""}`;

  const disposeTurn = letta.events.on("turn_start", event => {
    if (event.agentId !== agentId || event.conversationId !== conversationId) return;
    const key = keyFor(event.agentId, event.conversationId);
    const route = extractSingleChannelRoute(event.input, {
      agentId,
      conversationId,
      home: process.env.HOME ?? "/root",
    });
    if (!route) {
      // Tool-result and approval continuations belong to the routed turn in
      // progress. A genuinely new non-channel user turn clears stale state.
      if (containsUserMessage(event.input)) activeRoutes.delete(key);
      return;
    }
    activeRoutes.set(key, { ...route, capturedAt: Date.now() });
    return {
      input: [
        { type: "message", role: "system", content: routeReminder(route) },
        ...event.input,
      ],
    };
  });

  const disposeTool = letta.events.on("tool_start", event => {
    if (event.agentId !== agentId || event.conversationId !== conversationId) return;
    if (!isMessageChannelTool(event.toolName)) return;
    const key = keyFor(event.agentId, event.conversationId);
    const route = activeRoutes.get(key);
    if (!route || Date.now() - route.capturedAt > ROUTE_MAX_AGE_MS) return;
    if (!event.args || typeof event.args !== "object") return;

    const rewritten = {
      ...event.args,
      channel: route.channel,
      chat_id: route.chatId,
      accountId: route.accountId ?? undefined,
      threadId: route.threadId ?? undefined,
    };
    delete rewritten.target;
    return { args: rewritten };
  });

  return () => {
    disposeTool();
    disposeTurn();
    activeRoutes.clear();
  };
}
