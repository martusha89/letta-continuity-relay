import type { AccessPolicy } from "../config.js";

export class PolicyError extends Error {
  constructor(message = "Discord target is not allowed by policy") { super(message); this.name = "PolicyError"; }
}

export function assertGuildAllowed(policy: AccessPolicy, guildId: string): void {
  if (policy.allowedGuildIds.length > 0) {
    if (!policy.allowedGuildIds.includes(guildId)) throw new PolicyError();
    return;
  }
  if (policy.remoteMode) throw new PolicyError();
}

export function assertChannelAllowed(
  policy: AccessPolicy,
  channelId: string,
  guildId: string | null,
  parentChannelId?: string | null,
): void {
  if (!guildId) throw new PolicyError("DM channels cannot be addressed through channel tools");
  if (policy.allowedChannelIds.length > 0) {
    const channelAllowed = policy.allowedChannelIds.includes(channelId);
    const parentAllowed = Boolean(parentChannelId && policy.allowedChannelIds.includes(parentChannelId));
    if (!channelAllowed && !parentAllowed) throw new PolicyError();
  } else if (policy.remoteMode && policy.allowedGuildIds.length === 0) {
    throw new PolicyError();
  }
  if (policy.allowedGuildIds.length > 0) assertGuildAllowed(policy, guildId);
}

export function isChannelDiscoverable(
  policy: AccessPolicy,
  channel: { id: string; viewable: boolean; parentId?: string | null },
): boolean {
  return channel.viewable &&
    (policy.allowedChannelIds.length === 0 ||
      policy.allowedChannelIds.includes(channel.id) ||
      Boolean(channel.parentId && policy.allowedChannelIds.includes(channel.parentId)));
}

export function assertDmAllowed(policy: AccessPolicy, userId: string): void {
  if (!policy.allowedDmUserIds.includes(userId)) throw new PolicyError("DM recipient is not allowed by policy");
}

export function assertMentionUsersAllowed(policy: AccessPolicy, userIds: readonly string[]): string[] {
  const unique = [...new Set(userIds)];
  for (const userId of unique) {
    if (!/^\d{17,20}$/.test(userId) || !policy.allowedMentionUserIds.includes(userId)) {
      throw new PolicyError("Mention recipient is not allowed by policy");
    }
  }
  return unique;
}
