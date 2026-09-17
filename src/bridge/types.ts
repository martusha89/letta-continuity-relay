/**
 * Shared types for the Discord -> Letta custom-channel bridge.
 *
 * The bridge is transport plumbing only: it normalizes Discord messages into
 * InboundChannelMessage-shaped events and exposes authenticated HTTP endpoints
 * for a separate listener process. It never calls the Letta API itself.
 */

/** Attachment metadata only; content is fetched on demand by the listener. */
export interface BridgeAttachmentMetadata {
  id: string;
  name: string;
  contentType: string | null;
  size: number;
  url: string;
}

/**
 * Shape aligned with what a Letta InboundChannelMessage needs:
 * account/channel identity, author, text, and routing metadata.
 */
export interface InboundMessage {
  /** Discord snowflake of the message; unique and used for idempotency. */
  messageId: string;
  /** ISO-8601 creation timestamp. */
  timestamp: string;
  /** Bot-facing channel identity ("discord"). */
  account: "discord";
  /** Channel identifier: guild channel/thread ID, or DM user ID. */
  channel: string;
  /** Letta ChannelChatType value. */
  chatType: "direct" | "channel";
  guildId: string | null;
  guildName: string | null;
  channelId: string;
  channelName: string | null;
  /** Thread ID when the message arrived in a thread, else null. */
  threadId: string | null;
  /** Parent channel ID for threads, else null. */
  parentChannelId: string | null;
  authorId: string;
  authorName: string;
  /** Message text with the bot mention stripped. */
  text: string;
  attachments: BridgeAttachmentMetadata[];
  isMention: boolean;
}

/** Queue event wrapper with a monotonically increasing sequence ID. */
export interface BridgeEvent {
  seq: number;
  /** Wall-clock enqueue time, ISO-8601. */
  enqueuedAt: string;
  message: InboundMessage;
}

/** Result of gating an inbound Discord message. */
export type GateResult =
  | { verdict: "deliver"; message: InboundMessage }
  | { verdict: "ignore"; reason: IgnoreReason };

export type IgnoreReason =
  | "disabled"
  | "bot_author"
  | "webhook_author"
  | "system_author"
  | "guild_not_allowed"
  | "channel_not_allowed"
  | "dm_not_allowed"
  | "not_addressed_to_bot"
  | "duplicate"
  | "queue_full";

/** Action request accepted on POST /bridge/send. */
export type BridgeSendAction =
  | { kind: "send"; channel: string; text: string; replyToMessageId?: string }
  | { kind: "react"; channel: string; messageId: string; emoji: string }
  | { kind: "typing"; channel: string };
