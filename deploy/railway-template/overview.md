# Deploy and host Continuity Relay with Railway

Continuity Relay connects one existing Letta agent conversation to both a
private Telegram bot and an allowlisted Discord bot. Messages from either
platform enter the same conversation, preserving immediate context across
doors while deterministic routing sends each reply back to the platform and
channel that originated it.

## About hosting Continuity Relay

The template deploys two single-replica services. A Discord gateway performs
strict guild/channel and mention gating. A persistent listener configures
Telegram plus a custom Discord channel and routes both into the same selected
Letta agent and conversation. The services communicate over Railway's private
network with an independently generated bridge credential.

This is advanced community infrastructure, not an official Letta Cloud
Telegram/Discord integration. Letta's public custom-channel documentation
currently describes CLI channels as a local-backend feature. The template pins
the tested Letta Code version and requires end-to-end verification after every
upgrade.

## Common use cases

- Continue one agent conversation privately on Telegram and socially on
  Discord.
- Give an AI companion a bounded Discord presence without creating a second
  public-facing agent.
- Keep Discord ingress limited to explicit mentions, replies, and optional
  allowlisted role/`@everyone` triggers.
- Preserve cross-channel context while preventing stale-route reply leaks.

## Dependencies

- An existing Letta agent and API key. The beginner template routes both doors
  into that agent's existing `default` conversation.
- A Telegram bot token from BotFather and the numeric private chat ID.
- A Discord bot application/token, Message Content Intent, server invite, and
  allowlisted server/channel IDs.
- Railway persistent storage for listener state.

## Important operating limits

Run one replica of each service. Do not reuse either bot token in another
gateway or poller. Discord event delivery is currently an in-memory,
best-effort queue rather than a durable message broker. Discord DMs are disabled
in the beginner configuration.

Deployment is not complete when both services merely turn green. Test
Telegram → agent → Telegram, Discord → agent → Discord, an immediate switch
back to Telegram, a rapid two-Discord-channel switch, and native Discord typing
before relying on the installation.
