/**
 * Server-side resolution of proactive named destinations and mention aliases.
 *
 * The bridge owns the only copy of the raw Discord IDs: the authoritative
 * registry is parsed from DISCORD_BRIDGE_PROACTIVE_DESTINATIONS_JSON at
 * startup, verified against the live Discord client, and callers (the
 * listener / agent) only ever pass aliases. Unknown or disallowed aliases
 * fail closed.
 */
import { PermissionFlagsBits, type Client } from "discord.js";
import type { AccessPolicy, ProactiveDestinationRegistry, ProactiveMention } from "../config.js";
import { assertChannelAllowed, assertMentionRolesAllowed, assertMentionUsersAllowed, PolicyError } from "./policy.js";

const SNOWFLAKE = /^\d{17,20}$/;
const SENDABLE_CHANNEL_TYPES = new Set([0 /* GuildText */, 5 /* GuildNews */, 11 /* PublicThread */, 12 /* PrivateThread */]);

export interface ResolvedProactiveTarget {
  guildId: string;
  channelId: string;
  mentionUserIds: string[];
  mentionRoleIds: string[];
}

export interface DestinationVerifier {
  /** Fetch a guild by exact ID; null when unknown to the client. */
  fetchGuild(guildId: string): Promise<{ id: string } | null>;
  /** Fetch a sendable guild channel by exact ID; null when unknown/not sendable. */
  fetchSendableChannel(channelId: string): Promise<{ id: string; guildId: string | null; parentId: string | null } | null>;
  /** Fetch a role by exact ID within a guild; null when unknown. */
  fetchRole(guildId: string, roleId: string): Promise<{ id: string; managed: boolean; mentionable: boolean } | null>;
  /** Fetch a guild member by exact IDs; null when unknown or outside the guild. */
  fetchMember(guildId: string, userId: string): Promise<{ id: string } | null>;
  /** Confirm the bot can view and send to the exact destination channel. */
  canSendToChannel(channelId: string): Promise<boolean>;
}

/**
 * Build a verifier over the live discord.js client. Channel sendability is
 * determined structurally from the discord.js channel type (text, news, or
 * thread), not by name or fuzzy matching. Roles are verified through the
 * guild cache; users through the REST user fetch.
 */
export function createClientVerifier(client: Client): DestinationVerifier {
  return {
    async fetchGuild(guildId) {
      try {
        return await client.guilds.fetch(guildId);
      } catch {
        return null;
      }
    },
    async fetchSendableChannel(channelId) {
      try {
        const channel = await client.channels.fetch(channelId);
        if (channel && "type" in channel && SENDABLE_CHANNEL_TYPES.has(channel.type) && "guildId" in channel) {
          return {
            id: channel.id,
            guildId: (channel as { guildId: string | null }).guildId,
            parentId: "parentId" in channel ? String(channel.parentId ?? "") || null : null,
          };
        }
        return null;
      } catch {
        return null;
      }
    },
    async fetchRole(guildId, roleId) {
      try {
        const guild = client.guilds.cache.get(guildId) ?? await client.guilds.fetch(guildId);
        const role = await guild.roles.fetch(roleId);
        return role ? { id: role.id, managed: role.managed, mentionable: role.mentionable } : null;
      } catch {
        return null;
      }
    },
    async fetchMember(guildId, userId) {
      try {
        const guild = client.guilds.cache.get(guildId) ?? await client.guilds.fetch(guildId);
        return await guild.members.fetch(userId);
      } catch {
        return null;
      }
    },
    async canSendToChannel(channelId) {
      try {
        const channel = await client.channels.fetch(channelId);
        if (!channel || !("permissionsFor" in channel) || !client.user) return false;
        const permissions = channel.permissionsFor(client.user);
        if (!permissions?.has(PermissionFlagsBits.ViewChannel)) return false;
        const sendPermission = "isThread" in channel && channel.isThread()
          ? PermissionFlagsBits.SendMessagesInThreads
          : PermissionFlagsBits.SendMessages;
        return permissions.has(sendPermission);
      } catch {
        return false;
      }
    },
  };
}

/**
 * Verify every configured destination against the live Discord client.
 * Throws when any destination is unknown, sits in the wrong guild, is not a
 * sendable channel, or — where Discord permits verification — references a
 * mention that does not belong to the configured guild. No fuzzy fallback.
 */
export async function verifyProactiveDestinations(
  registry: ProactiveDestinationRegistry,
  verifier: DestinationVerifier,
  policy: AccessPolicy,
): Promise<void> {
  for (const destination of registry.values()) {
    const guild = await verifier.fetchGuild(destination.guildId);
    if (!guild) {
      throw new Error(`Proactive destination "${destination.alias}" references an unknown guild`);
    }
    const channel = await verifier.fetchSendableChannel(destination.channelId);
    if (!channel) {
      throw new Error(`Proactive destination "${destination.alias}" references an unknown or non-sendable channel`);
    }
    if (channel.guildId !== destination.guildId) {
      throw new Error(`Proactive destination "${destination.alias}" channel is not in its configured guild`);
    }
    assertChannelAllowed(policy, destination.channelId, destination.guildId, channel.parentId);
    if (!await verifier.canSendToChannel(destination.channelId)) {
      throw new Error(`Proactive destination "${destination.alias}" is not viewable and sendable by the bot`);
    }
    for (const [mentionAlias, mention] of destination.mentions) {
      if (mention.kind === "role") {
        assertMentionRolesAllowed(policy, [mention.id]);
        const role = await verifier.fetchRole(destination.guildId, mention.id);
        if (!role || role.id === destination.guildId || role.managed || !role.mentionable) {
          throw new Error(`Proactive destination "${destination.alias}" mention "${mentionAlias}" references an unknown, managed, or unmentionable role`);
        }
      } else {
        assertMentionUsersAllowed(policy, [mention.id]);
        const member = await verifier.fetchMember(destination.guildId, mention.id);
        if (!member) {
          throw new Error(`Proactive destination "${destination.alias}" mention "${mentionAlias}" references an unknown user`);
        }
      }
    }
  }
}

/**
 * Resolve a proactive_send action server-side. Throws a PolicyError for
 * unknown destinations, unknown mention aliases, or mentions that fail the
 * global user/role allowlists. Returns only resolved, validated IDs; the
 * caller composes mention tokens and passes them through the hardened
 * sendMessage path.
 */
export function resolveProactiveTarget(
  registry: ProactiveDestinationRegistry,
  policy: { allowedMentionUserIds: readonly string[]; allowedMentionRoleIds: readonly string[] },
  destinationAlias: string,
  mentionAliases: readonly string[],
): ResolvedProactiveTarget {
  const destination = registry.get(destinationAlias);
  if (!destination) throw new PolicyError("Unknown proactive destination");
  const mentionUserIds: string[] = [];
  const mentionRoleIds: string[] = [];
  for (const alias of mentionAliases) {
    const mention: ProactiveMention | undefined = destination.mentions.get(alias);
    if (!mention) throw new PolicyError("Unknown proactive mention for this destination");
    if (mention.kind === "user") {
      if (!SNOWFLAKE.test(mention.id) || !policy.allowedMentionUserIds.includes(mention.id)) {
        throw new PolicyError("Mention recipient is not allowed by policy");
      }
      mentionUserIds.push(mention.id);
    } else {
      if (!SNOWFLAKE.test(mention.id) || !policy.allowedMentionRoleIds.includes(mention.id)) {
        throw new PolicyError("Mentioned role is not allowed by policy");
      }
      mentionRoleIds.push(mention.id);
    }
  }
  return {
    guildId: destination.guildId,
    channelId: destination.channelId,
    mentionUserIds: [...new Set(mentionUserIds)],
    mentionRoleIds: [...new Set(mentionRoleIds)],
  };
}

/**
 * Compose mention tokens server-side. Callers never provide tokens or IDs.
 * Role pings render as <@&ID>, user pings as <@ID>; both only actually ping
 * because sendMessage passes them through validated allowedMentions.
 */
export function composeMentionTokens(mentionUserIds: readonly string[], mentionRoleIds: readonly string[]): string[] {
  return [...mentionRoleIds.map(id => `<@&${id}>`), ...mentionUserIds.map(id => `<@${id}>`)];
}
