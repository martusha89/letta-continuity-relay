import type { AccessPolicy, BridgeConfig } from "../config.js";
import type { BridgeAttachmentMetadata, GateResult, IgnoreReason, InboundMessage } from "./types.js";

/** Minimal structural view of a discord.js Message for pure gating/mapping. */
export interface InboundMessageView {
  id: string;
  author: { id: string; username: string; bot?: boolean; system?: boolean } | null;
  webhookId: string | null;
  system: boolean;
  content: string;
  createdAt: Date;
  isDM: boolean;
  dmUserId: string | null;
  guildId: string | null;
  guildName: string | null;
  channelId: string;
  channelName: string | null;
  threadId: string | null;
  parentChannelId: string | null;
  /** Raw user mentions (<@id> / <@!id>) present in the message. */
  mentionsUserIds: string[];
  /** Raw role mentions (<@&id>) present in the message. */
  mentionsRoleIds: string[];
  /** True when Discord parsed an @everyone or @here mention. */
  mentionsEveryone: boolean;
  /** ID of the message this one replies to, when it is a direct reply. */
  referencedMessageId: string | null;
  /** Author ID of the referenced message, when Discord provides it. */
  referencedAuthorId: string | null;
  attachments: Array<{ id: string; name: string; contentType: string | null; size: number; url: string }>;
}

/**
 * Strip a leading bot mention from message text and report whether the bot
 * was mentioned at all. Handles "<@id>" and legacy "<@!id>" forms, including
 * mentions preceded only by whitespace.
 */
export function stripBotMention(content: string, botUserId: string): { text: string; mentioned: boolean } {
  if (!botUserId) return { text: content, mentioned: false };
  const pattern = new RegExp(`^\\s*(?:<@!?${botUserId}>\\s*)+`);
  const matched = pattern.exec(content);
  if (matched) return { text: content.slice(matched[0].length), mentioned: true };
  const mentioned = new RegExp(`<@!?${botUserId}>`).test(content);
  return { text: content, mentioned };
}

/** Strip only leading addressing tokens that ingress policy has allowed. */
function stripLeadingAddressing(
  content: string,
  botUserId: string,
  roleIds: string[],
  allowEveryone: boolean,
): string {
  const tokens: string[] = [];
  if (botUserId) tokens.push(`<@!?${botUserId}>`);
  if (roleIds.length > 0) tokens.push(`<@&(?:${roleIds.join("|")})>`);
  if (allowEveryone) tokens.push("@(?:everyone|here)");
  if (tokens.length === 0) return content;
  const pattern = new RegExp(`^\\s*(?:(?:${tokens.join("|")})\\s*)+`, "i");
  return content.replace(pattern, "");
}

/** Map a gated message into the InboundChannelMessage-shaped event. */
export function toInboundMessage(
  view: InboundMessageView,
  botUserId: string,
  addressing: { roleIds: string[]; allowEveryone: boolean } = { roleIds: [], allowEveryone: false },
): InboundMessage {
  const botMentioned = stripBotMention(view.content, botUserId).mentioned;
  const allowedRoleIds = view.mentionsRoleIds.filter(id => addressing.roleIds.includes(id));
  const everyoneMentioned = addressing.allowEveryone && view.mentionsEveryone;
  const text = stripLeadingAddressing(view.content, botUserId, allowedRoleIds, everyoneMentioned);
  const attachments: BridgeAttachmentMetadata[] = view.attachments.map(a => ({
    id: a.id, name: a.name, contentType: a.contentType, size: a.size, url: a.url,
  }));
  return {
    messageId: view.id,
    timestamp: view.createdAt.toISOString(),
    account: "discord",
    channel: view.isDM ? (view.dmUserId ?? view.channelId) : (view.threadId ?? view.channelId),
    chatType: view.isDM ? "direct" : "channel",
    guildId: view.guildId,
    guildName: view.guildName,
    channelId: view.channelId,
    channelName: view.channelName,
    threadId: view.threadId,
    parentChannelId: view.parentChannelId,
    authorId: view.author?.id ?? "unknown",
    authorName: view.author?.username ?? "unknown",
    text,
    attachments,
    isMention: botMentioned || allowedRoleIds.length > 0 || everyoneMentioned,
  };
}

/**
 * Pure gate for an inbound Discord message.
 *
 * Order matters and is fail-closed:
 *  1. author sanity (bot/webhook/system are never delivered),
 *  2. policy allowlists (guild + channel; DMs require the separate bridge
 *     DM allowlist regardless of the general DM policy),
 *  3. addressed-to-bot (mention or reply-to-bot) — no firehose.
 */
export function gateInbound(
  view: InboundMessageView,
  policy: AccessPolicy,
  bridge: Pick<BridgeConfig, "dmUserIds" | "channelIds" | "roleIds" | "allowEveryone">,
  botUserId: string,
): GateResult {
  if (view.author?.bot) return ignore("bot_author");
  if (view.webhookId !== null) return ignore("webhook_author");
  if (view.system || view.author?.system) return ignore("system_author");
  if (!view.author) return ignore("system_author");

  if (view.isDM) {
    const dmUserId = view.dmUserId ?? view.author.id;
    // Bridge DMs are deny-by-default and use their OWN allowlist, distinct
    // from the outbound DM policy.
    if (!bridge.dmUserIds.includes(dmUserId)) return ignore("dm_not_allowed");
    return { verdict: "deliver", message: toInboundMessage(view, botUserId) };
  } else {
    const guildId = view.guildId;
    if (!guildId) return ignore("guild_not_allowed");
    if (policy.allowedGuildIds.length > 0 && !policy.allowedGuildIds.includes(guildId)) {
      return ignore("guild_not_allowed");
    }
    if (policy.allowedChannelIds.length > 0) {
      // A thread inherits its parent channel policy; check both IDs.
      const channelIds = new Set<string>([view.channelId]);
      if (view.parentChannelId) channelIds.add(view.parentChannelId);
      if (view.threadId) channelIds.add(view.threadId);
      if (![...channelIds].some(id => policy.allowedChannelIds.includes(id))) {
        return ignore("channel_not_allowed");
      }
    }
    if (bridge.channelIds.length > 0) {
      const channelIds = new Set<string>([view.channelId]);
      if (view.parentChannelId) channelIds.add(view.parentChannelId);
      if (view.threadId) channelIds.add(view.threadId);
      if (![...channelIds].some(id => bridge.channelIds.includes(id))) {
        return ignore("channel_not_allowed");
      }
    }
  }

  const addressedToBot =
    view.mentionsUserIds.includes(botUserId) ||
    view.mentionsRoleIds.some(id => bridge.roleIds.includes(id)) ||
    (bridge.allowEveryone && view.mentionsEveryone) ||
    (view.referencedMessageId !== null && view.referencedAuthorId === botUserId);
  if (!addressedToBot) return ignore("not_addressed_to_bot");

  return {
    verdict: "deliver",
    message: toInboundMessage(view, botUserId, { roleIds: bridge.roleIds, allowEveryone: bridge.allowEveryone }),
  };
}

function ignore(reason: IgnoreReason): GateResult {
  return { verdict: "ignore", reason };
}
