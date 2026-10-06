import { Events, type Client } from "discord.js";
import type { RuntimeConfig } from "../config.js";
import { sendDirectMessage, sendMessage, reactToMessage, setTyping } from "../discord/messages.js";
import { composeMentionTokens, createClientVerifier, resolveProactiveTarget, verifyProactiveDestinations } from "../discord/destinations.js";
import { createInboundPipeline, type BridgePipeline } from "./discord-adapter.js";
import { createBridgeRouter, type BridgeRouterOptions, type BridgeSendHandlers } from "./router.js";
import type { BridgeEventQueue } from "./queue.js";

export interface BridgeRuntime {
  pipeline: BridgePipeline;
  queue: BridgeEventQueue;
  routerOptions: BridgeRouterOptions;
  /** Resolves after startup destination verification succeeds; never rejects silently. */
  ready: Promise<void>;
}

export interface BridgeDiscordOperations {
  sendMessage: typeof sendMessage;
  sendDirectMessage: typeof sendDirectMessage;
  reactToMessage: typeof reactToMessage;
  setTyping: typeof setTyping;
}

/**
 * Build authenticated bridge actions. Bridge channel targets are always exact
 * snowflake IDs, so they must be resolved by ID across every allowed guild,
 * not constrained to the optional default guild used for name-based MCP calls.
 * The underlying operations still enforce the exact outbound allowlists.
 */
export function createBridgeSendHandlers(
  cfg: RuntimeConfig,
  operations: BridgeDiscordOperations = { sendMessage, sendDirectMessage, reactToMessage, setTyping },
): BridgeSendHandlers {
  const proactiveRequests = new Map<string, {
    createdAt: number;
    settled: boolean;
    promise: ReturnType<BridgeSendHandlers["proactiveSend"]>;
  }>();
  const proactiveTtlMs = 10 * 60_000;
  const proactiveLimit = 512;

  function pruneProactiveRequests(now: number): void {
    for (const [requestId, entry] of proactiveRequests) {
      if (entry.settled && now - entry.createdAt > proactiveTtlMs) proactiveRequests.delete(requestId);
    }
    while (proactiveRequests.size >= proactiveLimit) {
      const oldestSettled = [...proactiveRequests].find(([, entry]) => entry.settled)?.[0];
      if (typeof oldestSettled !== "string") break;
      proactiveRequests.delete(oldestSettled);
    }
  }

  return {
    send: async action => {
      const result = await operations.sendMessage({
        channel: action.channel,
        content: action.text,
        replyToMessageId: action.replyToMessageId,
        limits: cfg.limits,
      });
      return { messageId: result.id, channelId: result.channelId };
    },
    sendDm: async action => {
      const result = await operations.sendDirectMessage({
        userId: action.userId,
        content: action.text,
        replyToMessageId: action.replyToMessageId,
        limits: cfg.limits,
      });
      return { messageId: result.id, channelId: result.channelId };
    },
    proactiveSend: async action => {
      const now = Date.now();
      pruneProactiveRequests(now);
      const existing = proactiveRequests.get(action.requestId);
      if (existing) return existing.promise;
      if (proactiveRequests.size >= proactiveLimit) {
        throw new Error("Proactive send capacity is temporarily exhausted");
      }
      const promise = Promise.resolve().then(async () => {
        // Server-side-only alias resolution: the registry, the global mention
        // allowlists, and the mention tokens are all composed here. The caller
        // never supplies tokens or raw IDs, and unknown aliases fail closed.
        const target = resolveProactiveTarget(cfg.bridge.proactiveDestinations, cfg.policy, action.destination, action.mentions ?? []);
        const tokens = composeMentionTokens(target.mentionUserIds, target.mentionRoleIds);
        const content = tokens.length > 0 ? `${tokens.join(" ")} ${action.text}` : action.text;
        // The existing safe send path re-validates the channel against the
        // outbound policy and re-validates every mention against the allowlists,
        // with allowedMentions assigned last (cannot be overridden).
        const result = await operations.sendMessage({
          channel: target.channelId,
          content,
          mentionUserIds: target.mentionUserIds,
          mentionRoleIds: target.mentionRoleIds,
          limits: cfg.limits,
        });
        return {
          messageId: result.id,
          channelId: result.channelId,
          destination: action.destination,
          requestId: action.requestId,
        };
      });
      const entry = { createdAt: now, settled: false, promise };
      proactiveRequests.set(action.requestId, entry);
      try {
        const result = await promise;
        entry.settled = true;
        entry.createdAt = Date.now();
        return result;
      } catch (error) {
        proactiveRequests.delete(action.requestId);
        throw error;
      }
    },
    react: async action => {
      await operations.reactToMessage({
        channel: action.channel,
        messageId: action.messageId,
        emoji: action.emoji,
      });
    },
    typing: async action => {
      await operations.setTyping({ channel: action.channel });
    },
  };
}

/**
 * Assemble the bridge runtime around the EXISTING Discord.js client.
 *
 * Outbound actions reuse the same sendMessage/reactToMessage pathways used by
 * MCP tools, so guild/channel policy, mention suppression, and size limits
 * remain in force without duplication.
 */
export function createBridgeRuntime(cfg: RuntimeConfig, client: Client): BridgeRuntime {
  const pipeline = createInboundPipeline({
    policy: cfg.policy,
    bridge: cfg.bridge,
    botUserId: () => (client.isReady() ? client.user?.id ?? "" : ""),
    log: line => console.log(line),
  });
  pipeline.attach(client);

  const sendHandlers = createBridgeSendHandlers(cfg);

  // After Discord login, verify every configured proactive destination
  // resolves to an allowed sendable channel in its configured guild, and that
  // configured mentions belong to that guild where Discord permits
  // verification. Any mismatch fails startup — no fuzzy fallback.
  const routerOptions: BridgeRouterOptions = {
    bridge: cfg.bridge,
    queue: pipeline.queue,
    sendHandlers,
    log: scope => console.error(`[bridge] ${scope}`),
  };

  return { pipeline, queue: pipeline.queue, routerOptions, ready: verifyStartup(client, cfg) };
}

async function verifyStartup(client: Client, cfg: RuntimeConfig): Promise<void> {
  if (cfg.bridge.proactiveDestinations.size === 0) return;
  if (!client.isReady()) {
    await new Promise<void>(resolve => {
      client.once(Events.ClientReady, () => resolve());
    });
  }
  await verifyProactiveDestinations(cfg.bridge.proactiveDestinations, createClientVerifier(client), cfg.policy);
}
