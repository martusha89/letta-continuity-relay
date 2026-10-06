import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

const SAFE_CHANNEL_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const CHANNEL_OTID = /^cm-channel-[0-9a-f]{32}$/;

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

function channelSourcesFromContent(content) {
  const sources = [];
  for (const text of textPartsFromContent(content)) {
    const tag = text.match(/^<channel-notification\b[^>]*>/)?.[0];
    if (!tag) continue;
    const channel = attribute(tag, "source");
    const chatId = attribute(tag, "chat_id");
    const accountId = attribute(tag, "account_id");
    if (!channel || !chatId || !accountId) return null;
    sources.push({
      channel,
      accountId,
      chatId,
      threadId: attribute(tag, "thread_id"),
      messageId: attribute(tag, "message_id"),
    });
  }
  return sources;
}

export function channelMessageOtid(content, agentId, conversationId) {
  const sources = channelSourcesFromContent(content);
  if (!sources?.length || sources.some(source => !source.messageId)) return null;
  const sourceIdentity = sources
    .map(source => ({
      channel: source.channel,
      accountId: source.accountId ?? null,
      chatId: source.chatId,
      threadId: source.threadId ?? null,
      messageId: source.messageId ?? null,
    }))
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  const digest = createHash("sha256").update(JSON.stringify({
    agentId,
    conversationId,
    sources: sourceIdentity,
  })).digest("hex").slice(0, 32);
  return `cm-channel-${digest}`;
}

function approvedRoute(route, agentId, conversationId, home) {
  if (!SAFE_CHANNEL_ID.test(route.channel) || !route.accountId) return false;
  const directory = path.join(home, ".letta", "channels", route.channel);
  // Letta's runtime registry is routing.yaml. routing.json is a migration-only
  // fallback and must never override an existing authoritative YAML registry.
  for (const name of ["routing.yaml", "routing.json"]) {
    const file = path.join(directory, name);
    try {
      const metadata = fs.lstatSync(file);
      const unsafePosixPermissions = typeof process.getuid === "function" &&
        (metadata.uid !== process.getuid() || (metadata.mode & 0o022) !== 0);
      if (!metadata.isFile() || metadata.isSymbolicLink() || unsafePosixPermissions) {
        return false;
      }
      const state = JSON.parse(fs.readFileSync(file, "utf8"));
      if (!state || !Array.isArray(state.routes)) return false;
      return state.routes.some(candidate =>
        candidate?.accountId === route.accountId &&
        String(candidate?.chatId ?? "") === route.chatId &&
        String(candidate?.threadId ?? "") === String(route.threadId ?? "") &&
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

function isUserMessage(item) {
  return item?.role === "user" || item?.message_type === "user_message";
}

export function extractSingleChannelRoute(input, options = {}) {
  const routes = [];
  for (const item of input ?? []) {
    if (item?.type === "approval" || !isUserMessage(item)) continue;
    // Letta's channel gateway creates this outer wrapper and XML-escapes the
    // user's message body. Requiring the wrapper at the beginning of one
    // content part prevents channel text from manufacturing a second tag.
    const sources = channelSourcesFromContent(item.content);
    if (!sources) continue;
    routes.push(...sources);
  }

  const unique = new Map();
  for (const route of routes) {
    // A route is not only a destination. The source message is part of the
    // provenance boundary: two notifications from different messages in the
    // same channel are still ambiguous and must fail closed.
    const key = JSON.stringify([
      route.channel,
      route.accountId ?? "",
      route.chatId,
      route.threadId ?? "",
      route.messageId ?? "",
    ]);
    unique.set(key, route);
  }
  if (unique.size !== 1) return null;
  const route = [...unique.values()][0];
  const home = options.home ?? process.env.HOME ?? "/root";
  return approvedRoute(route, options.agentId, options.conversationId, home) ? route : null;
}

function toolCallIds(item) {
  const primary = item?.tool_call;
  const calls = item?.tool_calls;
  if (!primary || typeof primary !== "object" || Array.isArray(primary) ||
      !Array.isArray(calls) || calls.length === 0 ||
      JSON.stringify(primary) !== JSON.stringify(calls[0])) return null;
  const ids = [];
  for (const call of calls) {
    if (!call || typeof call !== "object" || Array.isArray(call) ||
        typeof call.tool_call_id !== "string" || call.tool_call_id.length === 0 ||
        typeof call.name !== "string" || call.name.length === 0 ||
        typeof call.arguments !== "string") return null;
    if (ids.includes(call.tool_call_id)) return null;
    ids.push(call.tool_call_id);
  }
  return ids;
}

function mentionsToolCallId(item, toolCallId) {
  if (item?.tool_call?.tool_call_id === toolCallId || item?.tool_call?.id === toolCallId) return true;
  return Array.isArray(item?.tool_calls) && item.tool_calls.some(call =>
    call?.tool_call_id === toolCallId || call?.id === toolCallId
  );
}

function uniqueToolCarrier(history, toolCallId) {
  const carriers = [];
  for (const item of history ?? []) {
    if (item?.message_type !== "approval_request_message" || !mentionsToolCallId(item, toolCallId)) continue;
    const ids = toolCallIds(item);
    if (!ids?.includes(toolCallId)) return null;
    carriers.push(item);
  }
  return carriers.length === 1 ? carriers[0] : null;
}

function recordSequence(item) {
  return Number.isSafeInteger(item?.seq_id) ? item.seq_id : null;
}

function resolveOriginatingUser(history, initialCarrier) {
  let runId = initialCarrier.run_id;
  let boundaryCarriers = [initialCarrier];
  const visited = new Set();

  for (let depth = 0; depth < 64; depth += 1) {
    if (visited.has(runId)) {
      return { kind: "blocked", reason: "tool continuation chain contains a cycle" };
    }
    visited.add(runId);

    const runItems = (history ?? []).filter(item => item?.run_id === runId);
    const users = runItems.filter(item =>
      item?.run_id === runId && item?.message_type === "user_message"
    );
    const returns = runItems.filter(item => item?.message_type === "tool_return_message");
    if (users.length > 1) {
      return { kind: "blocked", reason: "originating user turn is ambiguous" };
    }
    if (users.length === 1) {
      const userSequence = recordSequence(users[0]);
      const boundarySequences = boundaryCarriers.map(recordSequence);
      if (userSequence != null && boundarySequences.every(value => value != null) &&
          boundarySequences.some(value => value <= userSequence)) {
        return { kind: "blocked", reason: "originating user turn follows its tool carrier" };
      }
      if (returns.length > 0) {
        const returnSequences = returns.map(recordSequence);
        if (userSequence == null || boundarySequences.some(value => value == null) ||
            returnSequences.some(value => value == null) ||
            returnSequences.some(value =>
              boundarySequences.some(boundary => value >= boundary)
            ) ||
            boundarySequences.some(value => value <= userSequence)) {
          return { kind: "blocked", reason: "origin run contains contradictory tool returns" };
        }
      }
      return { kind: "resolved", user: users[0] };
    }

    // Letta assigns each continuation after a tool result a fresh run_id. Walk
    // backwards through persisted tool returns to the carrier run that issued
    // them. Parallel results are safe only when every call converges on one
    // predecessor run.
    if (returns.length === 0) {
      return { kind: "blocked", reason: "originating user turn is missing" };
    }
    const boundarySequences = boundaryCarriers.map(recordSequence);
    const returnSequences = returns.map(recordSequence);
    if (boundarySequences.some(value => value == null) || returnSequences.some(value => value == null) ||
        returnSequences.some(value => boundarySequences.some(boundary => value >= boundary))) {
      return { kind: "blocked", reason: "tool continuation chronology is invalid" };
    }
    const priorCallIds = [];
    const seenReturnIds = new Set();
    for (const item of returns) {
      const priorCallId = item?.tool_call_id;
      if (typeof priorCallId !== "string" || priorCallId.length === 0 ||
          Object.prototype.hasOwnProperty.call(item, "tool_call_ids")) {
        return { kind: "blocked", reason: "tool continuation return is malformed" };
      }
      if (seenReturnIds.has(priorCallId)) {
        return { kind: "blocked", reason: "tool continuation return is duplicated" };
      }
      seenReturnIds.add(priorCallId);
      priorCallIds.push(priorCallId);
    }

    const predecessorRuns = new Set();
    const predecessorCarriers = [];
    for (const priorCallId of priorCallIds) {
      const carrier = uniqueToolCarrier(history, priorCallId);
      if (!carrier) {
        return { kind: "blocked", reason: "tool continuation carrier is missing or ambiguous" };
      }
      if (typeof carrier.run_id !== "string" || carrier.run_id.length === 0) {
        return { kind: "blocked", reason: "tool continuation is not correlated to a persisted run" };
      }
      predecessorRuns.add(carrier.run_id);
      predecessorCarriers.push(carrier);
    }
    if (predecessorRuns.size !== 1) {
      return { kind: "blocked", reason: "tool continuation chain is ambiguous" };
    }
    runId = [...predecessorRuns][0];
    boundaryCarriers = predecessorCarriers;
  }

  return { kind: "blocked", reason: "tool continuation chain exceeded its safety bound" };
}

function containsChannelNotification(item) {
  return textPartsFromContent(item?.content)
    .some(text => text.startsWith("<channel-notification"));
}

export function resolveToolChannelRoute(history, toolCallId, options = {}) {
  if (typeof toolCallId !== "string" || toolCallId.length === 0) {
    return { kind: "blocked", reason: "missing tool call identity" };
  }

  const carrier = uniqueToolCarrier(history, toolCallId);
  if (!carrier) {
    return { kind: "blocked", reason: "tool call carrier is missing or ambiguous" };
  }
  const runId = carrier?.run_id;
  if (typeof runId !== "string" || runId.length === 0) {
    return { kind: "blocked", reason: "tool call is not correlated to a persisted run" };
  }

  // Persisted history must use the server's raw user_message shape. `role:
  // "user"` is accepted only by turn_start parsing, never as history proof.
  const origin = resolveOriginatingUser(history, carrier);
  if (origin.kind === "blocked") return origin;
  const user = origin.user;
  if (!containsChannelNotification(user)) return { kind: "ordinary" };
  const expectedOtid = channelMessageOtid(user.content, options.agentId, options.conversationId);
  if (!CHANNEL_OTID.test(user?.otid ?? "") || user.otid !== expectedOtid) {
    return { kind: "blocked", reason: "originating channel marker is missing or invalid" };
  }
  const route = extractSingleChannelRoute([user], options);
  if (!route) {
    return { kind: "blocked", reason: "originating channel route is malformed or not authorized" };
  }
  return { kind: "routed", route };
}

function isMessageChannelTool(toolName) {
  const leaf = String(toolName ?? "").split(".").at(-1) ?? "";
  return leaf.replace(/[^a-z0-9]/gi, "").toLowerCase() === "messagechannel";
}

function routeReminder(route) {
  return [
    `Deterministic channel route guard: this turn arrived through ${route.channel} chat ${route.chatId}.`,
    "The shared MessageChannel schema can remain stale after another channel used this same conversation.",
    "For any user-visible reply, call MessageChannel as usual; the route guard will pin every call to this notification source.",
    "Do not deliberately cross-post with MessageChannel. A separate approved proactive tool may be used only when deliberate outreach is genuinely intended.",
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

  const disposeTurn = letta.events.on("turn_start", event => {
    if (event.agentId !== agentId || event.conversationId !== conversationId) return;
    const route = extractSingleChannelRoute(event.input, {
      agentId,
      conversationId,
      home: process.env.HOME ?? "/root",
    });
    if (!route) return;
    return {
      input: [
        { type: "message", role: "system", content: routeReminder(route) },
        ...event.input,
      ],
    };
  });

  const disposeTool = letta.events.on("tool_start", async (event, ctx) => {
    if (event.agentId !== agentId || event.conversationId !== conversationId) return;
    if (!isMessageChannelTool(event.toolName)) return;
    if (!event.args || typeof event.args !== "object") return;

    // Channel ingress and tool execution can run in separate process contexts,
    // while multiple channel runs may overlap. Correlate this exact tool call
    // to its persisted run and originating user message; never use process-local
    // or merely-latest conversation state.
    let history;
    try {
      history = await ctx?.conversation?.getHistory({ limit: 500, order: "desc" });
    } catch {
      letta.diagnostics?.report?.({
        severity: "error",
        message: "channel-reply-route-guard could not resolve current conversation history",
      });
      return {
        result: {
          status: "error",
          output: "MessageChannel route guard blocked the call because its originating turn could not be verified.",
        },
      };
    }
    const resolved = resolveToolChannelRoute(history, event.toolCallId, {
      agentId,
      conversationId,
      home: process.env.HOME ?? "/root",
    });
    if (resolved.kind === "ordinary") return;
    if (resolved.kind === "blocked") {
      letta.diagnostics?.report?.({
        severity: "error",
        message: `channel-reply-route-guard blocked MessageChannel: ${resolved.reason}`,
      });
      return {
        result: {
          status: "error",
          output: "MessageChannel route guard blocked the call because its originating turn could not be verified.",
        },
      };
    }
    const { route } = resolved;
    const discordSource = route.channel === "cass-discord" || route.channel === "continuity-discord";

    const rewritten = {
      ...event.args,
      channel: route.channel,
      chat_id: route.chatId,
      accountId: route.accountId ?? undefined,
      threadId: route.threadId ?? undefined,
      // Exact source correlation is transport provenance, not a model choice.
      // `replyTo` is the public MessageChannel argument; the channel runtime
      // normalizes it to `replyToMessageId` before calling the adapter. Keep
      // the normalized spelling pinned too for runtimes that expose it at
      // tool_start. The adapter uses that value both for human reply references
      // and for persistent one-shot enforcement on companion-bot-origin turns.
      ...(discordSource ? {
        replyTo: route.messageId ?? undefined,
        replyToMessageId: route.messageId ?? undefined,
      } : {}),
      ...(discordSource && event.args.action === "react" ? { messageId: route.messageId ?? undefined } : {}),
    };
    delete rewritten.target;
    return { args: rewritten };
  });

  return () => {
    disposeTool();
    disposeTurn();
  };
}
