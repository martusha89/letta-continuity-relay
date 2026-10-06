import type { Client, Message } from "discord.js";
import type { AccessPolicy, BridgeConfig } from "../config.js";
import { gateInbound, type InboundMessageView } from "./inbound.js";
import { BoundedIdempotencySet, BridgeEventQueue } from "./queue.js";
import type { IgnoreReason } from "./types.js";

const IDEMPOTENCY_CAPACITY = 4096;
const BOT_COOLDOWN_CAPACITY = 4096;

class BoundedBotCooldowns {
  private readonly acceptedAt = new Map<string, number>();
  constructor(private readonly capacity: number, private readonly cooldownMs: number) {}

  permits(key: string, now = Date.now()): boolean {
    const previous = this.acceptedAt.get(key);
    return previous === undefined || now - previous >= this.cooldownMs;
  }

  record(key: string, now = Date.now()): void {
    this.acceptedAt.delete(key);
    this.acceptedAt.set(key, now);
    while (this.acceptedAt.size > this.capacity) {
      const oldest = this.acceptedAt.keys().next().value;
      if (typeof oldest !== "string") break;
      this.acceptedAt.delete(oldest);
    }
  }
}

/** Extract the pure structural view from a discord.js Message. */
export function toMessageView(message: Message): InboundMessageView {
  const dm = !message.guild;
  const thread = message.channel.isThread?.() === true ? message.channel : null;
  const parent = thread?.parent ?? null;
  return {
    id: message.id,
    author: message.author
      ? { id: message.author.id, username: message.author.username, bot: message.author.bot, system: message.author.system }
      : null,
    webhookId: message.webhookId ?? null,
    system: message.system,
    content: message.content,
    createdAt: message.createdAt,
    isDM: dm,
    dmUserId: dm ? message.author?.id ?? null : null,
    guildId: message.guildId ?? null,
    guildName: message.guild?.name ?? null,
    channelId: message.channelId,
    channelName: "name" in message.channel ? (message.channel.name as string) : null,
    threadId: thread?.id ?? null,
    parentChannelId: parent?.id ?? null,
    mentionsUserIds: Array.from(message.mentions.users.keys()),
    mentionsRoleIds: Array.from(message.mentions.roles.keys()),
    mentionsEveryone: message.mentions.everyone,
    referencedMessageId: message.reference?.messageId ?? null,
    referencedAuthorId: message.mentions.repliedUser?.id ?? null,
    attachments: message.attachments.map(a => ({
      id: a.id, name: a.name || "attachment", contentType: a.contentType ?? null, size: a.size, url: a.url,
    })),
  };
}

export interface BridgePipeline {
  /** Attach the messageCreate handler to the existing client. */
  attach(client: Client): void;
  queue: BridgeEventQueue;
}

/**
 * Build the inbound pipeline around the EXISTING Discord.js client. The
 * client remains the sole Gateway owner; this only subscribes to events.
 */
export function createInboundPipeline(options: {
  policy: AccessPolicy;
  bridge: BridgeConfig;
  botUserId: () => string;
  log?: (line: string) => void;
}): BridgePipeline {
  const { policy, bridge, botUserId } = options;
  const log = options.log ?? (() => {});
  const queue = new BridgeEventQueue(bridge.queueLimit);
  const seen = new BoundedIdempotencySet(IDEMPOTENCY_CAPACITY);
  const botCooldowns = new BoundedBotCooldowns(BOT_COOLDOWN_CAPACITY, bridge.botCooldownMs);

  async function handle(message: Message): Promise<void> {
    const view = toMessageView(message);
    const currentBotUserId = botUserId();
    if (
      view.referencedMessageId !== null &&
      view.referencedAuthorId === null &&
      !view.mentionsUserIds.includes(currentBotUserId)
    ) {
      try {
        view.referencedAuthorId = (await message.fetchReference()).author.id;
      } catch {
        // A deleted/inaccessible reference cannot establish that the relay bot was
        // addressed. The pure gate will reject it without exposing details.
      }
    }
    const gated = gateInbound(view, policy, bridge, currentBotUserId);
    if (gated.verdict === "ignore") {
      // Log the reason only; never log message content or author names.
      log(`[bridge] inbound ignored: ${gated.reason}`);
      return;
    }
    if (!seen.add(view.id)) {
      log("[bridge] inbound ignored: duplicate");
      return;
    }
    const cooldownKey = gated.message.authorIsBot
      ? `${gated.message.authorId}:${gated.message.channel}`
      : null;
    if (cooldownKey && !botCooldowns.permits(cooldownKey)) {
      log("[bridge] inbound ignored: bot_cooldown");
      return;
    }
    const event = queue.enqueue(gated.message);
    if (!event) {
      log(`[bridge] inbound dropped: ${"queue_full" satisfies IgnoreReason}`);
      return;
    }
    if (cooldownKey) botCooldowns.record(cooldownKey);
    log(`[bridge] inbound queued seq=${event.seq} channel=${gated.message.channelId}`);
  }

  return {
    attach(client: Client): void {
      client.on("messageCreate", message => void handle(message));
    },
    queue,
  };
}
