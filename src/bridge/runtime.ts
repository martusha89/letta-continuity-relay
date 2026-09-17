import type { Client } from "discord.js";
import type { RuntimeConfig } from "../config.js";
import { sendMessage, reactToMessage, setTyping } from "../discord/messages.js";
import { createInboundPipeline, type BridgePipeline } from "./discord-adapter.js";
import { createBridgeRouter, type BridgeRouterOptions, type BridgeSendHandlers } from "./router.js";
import type { BridgeEventQueue } from "./queue.js";

export interface BridgeRuntime {
  pipeline: BridgePipeline;
  queue: BridgeEventQueue;
  routerOptions: BridgeRouterOptions;
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
    log: line => console.error(line),
  });
  pipeline.attach(client);

  const sendHandlers: BridgeSendHandlers = {
    send: async action => {
      const result = await sendMessage({
        channel: action.channel,
        content: action.text,
        replyToMessageId: action.replyToMessageId,
        fallbackGuildId: cfg.defaults.guildId,
        limits: cfg.limits,
      });
      return { messageId: result.id, channelId: result.channelId };
    },
    react: async action => {
      await reactToMessage({
        channel: action.channel,
        messageId: action.messageId,
        emoji: action.emoji,
        fallbackGuildId: cfg.defaults.guildId,
      });
    },
    typing: async action => {
      await setTyping({
        channel: action.channel,
        fallbackGuildId: cfg.defaults.guildId,
      });
    },
  };

  const routerOptions: BridgeRouterOptions = {
    bridge: cfg.bridge,
    queue: pipeline.queue,
    sendHandlers,
    log: scope => console.error(`[bridge] ${scope}`),
  };

  return { pipeline, queue: pipeline.queue, routerOptions };
}
