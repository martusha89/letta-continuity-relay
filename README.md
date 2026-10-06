# Letta Continuity Relay

Run one existing Letta agent conversation through two doors: a private
Telegram bot and tightly allowlisted Discord channels. Messages from either
platform enter the same conversation, while a deterministic route guard sends
each reply back to the exact platform/channel that originated it.

> **Status:** experimental, version-pinned community infrastructure. Letta's
> public documentation currently describes custom CLI channels as a
> local-backend feature. This project uses a self-managed Railway listener with
> a cloud-hosted agent and must be regression-tested after every Letta Code
> upgrade.

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/new/template/OpRbiK)

> The Railway template is currently **unpublished and experimental**. The link
> is shareable, but it has not been submitted to Railway's template marketplace.

## What the template deploys

```text
Telegram Bot API ─┐
                  ├─ continuity-listener ── one agent / one conversation
Discord Gateway ─ discord-bridge ──────────┘
                       ▲
                       └─ authenticated Railway private network
```

- **`discord-bridge`** owns the only Discord Gateway connection, enforces
  guild/channel/mention policy, supplies typing, and exposes an optional
  authenticated MCP endpoint.
- **`continuity-listener`** owns the only Telegram poller and bridge consumer,
  renders channel state on a persistent volume, and runs pinned Letta Code.
- Both services are deliberately **single replica**. This is not a horizontally
  scalable queue consumer.

## Before deploying

You need:

1. An existing Letta agent, its exact `agent-...` ID, and a Letta API key that
   can access it. The beginner path uses the agent's `default` conversation.
2. A Telegram bot token from official `@BotFather` and your numeric private
   Telegram chat ID.
3. A Discord application/bot token, **Message Content Intent** enabled, the bot
   invited to one server, and the exact server/channel IDs copied with Discord
   Developer Mode.

Do not paste bot tokens into third-party “ID finder” websites. Do not reuse a
Telegram or Discord bot token already running in another listener.

## Railway deployment

Open the [unpublished Letta Continuity Relay
template](https://railway.com/new/template/OpRbiK). Railway will ask only for
the credentials and IDs it cannot create safely:

- `LETTA_API_KEY`
- `LETTA_AGENT_ID`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`
- `DISCORD_TOKEN`
- `DISCORD_ALLOWED_GUILD_IDS`
- `DISCORD_ALLOWED_CHANNEL_IDS`

The template generates separate MCP and bridge secrets, wires the listener to
the bridge over private networking, attaches persistent state at `/root`, and
creates exact routes into the same agent/default conversation.

After deployment, verify all five legs before relying on it:

1. Telegram → agent → Telegram.
2. Direct Discord bot mention → agent → same Discord channel.
3. Immediate switch back to Telegram with no reply spillover.
4. Rapid switch between two allowlisted Discord channels, if configured.
5. Native Discord typing while the agent is processing.

Green healthchecks are not an end-to-end test.

## Discord permissions

Grant the bot only what the selected channels require:

- View Channels
- Send Messages
- Read Message History
- Add Reactions
- Attach Files and Embed Links when file output is wanted
- Use External Emojis/Stickers when those output features are wanted

Inbound guild messages still require a direct bot mention or reply-to-bot by
default. Optional role mentions and `@everyone`/`@here` triggers are explicit,
separate opt-ins. Discord DMs remain disabled in the beginner template.

Bots already present inside the Discord permission boundary and an allowed,
routed channel may address the relay only by **directly mentioning its bot user**.
Replies, roles, `@everyone`/`@here`, ambient bot chatter, the relay's own
messages, webhooks, system messages, and bot DMs remain blocked. Accepted bot
messages also receive a per-bot/channel cooldown, and the listener permits at
most one unpinged outbound response for each bot-origin message.

## Administrative Discord MCP tools

Do **not** attach the general Discord MCP endpoint to the same continuity agent.
It exposes raw-target send, DM, reaction, typing, file, and sticker tools that
do not pass through the deterministic reply-route guard or the named proactive
destination registry. The continuity agent already receives ordinary replies
through its channel adapter and deliberate outreach through
`proactive_discord_send`.

If a separate trusted administrative agent or human-operated MCP client needs
the full Discord tool surface, generate a public domain for `discord-bridge`,
use:

```text
https://<your-generated-domain>/mcp
```

and configure the MCP host with:

```text
Authorization: Bearer <MCP_HTTP_BEARER_TOKEN>
```

The public MCP route is bearer-authenticated but still powerful. Keep it off
the continuity agent. Listener-to-bridge event traffic uses a different secret
and remains on Railway's private network.

## Fixed private Telegram updates

The listener installs `proactive_telegram_send` alongside the route guard. It
lets the agent deliberately send a brief private update to the one configured
`TELEGRAM_CHAT_ID` while another routed conversation is active. Its model-facing
schema contains only `message`; arbitrary chat IDs and raw Telegram methods are
not exposed.

This does not create an activity-reporting requirement or automatic transcript
mirror. The agent may use it when genuine context, company, or a safety update
calls for contact. Ordinary replies remain pinned to their inbound source. The
tool makes one Telegram `sendMessage` attempt only: an ambiguous network result
is reported as unknown and is never retried automatically.

## Proactive named destinations (bridge configuration)

The bridge can expose a `proactive_send` action on `POST /bridge/send` that
lets the agent deliberately initiate a Discord message at a **named
destination** — even when the current turn arrived through another channel or
has no inbound route. Raw Discord IDs never travel to the agent; the bridge
owns the only copy of them.

Configure three bridge-side values:

- `DISCORD_BRIDGE_PROACTIVE_DESTINATIONS_JSON` — strict JSON registry of
  named destinations. Empty or omitted means the feature is simply off.
- `DISCORD_ALLOWED_MENTION_USER_IDS` — users/bots a proactive destination may
  deliberately ping (the existing user mention allowlist).
- `DISCORD_ALLOWED_MENTION_ROLE_IDS` — roles a proactive destination may
  deliberately ping (new, comma-separated, empty by default).

Example registry:

```json
{
  "aidhd.porch": {
    "guildId": "111111111111111111",
    "channelId": "222222222222222222",
    "mentions": {
      "marta": { "kind": "user", "id": "333333333333333333" },
      "boys":  { "kind": "role", "id": "666666666666666666" }
    }
  }
}
```

The agent-facing `proactive_discord_send` tool accepts only:

```json
{ "destination": "aidhd.porch", "message": "standup in 5", "mentions": ["marta", "boys"] }
```

The listener adds a private UUID idempotency key when it calls the bridge. A
retry within the bridge's bounded ten-minute cache returns the original receipt
instead of posting twice.

Safety model:

- Destination and mention aliases are lowercase `[a-z0-9]` with `.`, `_`, or
  `-` separators, and cannot look like Discord snowflakes. Mixed-case input
  is normalized; duplicate normalized aliases are rejected at config load.
- `proactive_send` strictly rejects raw-route keys (`channel`, `userId`,
  `guildId`, `roleId`, `replyToMessageId`, `allowedMentions`, …) alongside
  it — the request fails with `400` before anything reaches Discord.
- Aliases resolve **only server-side**. The bridge composes mention tokens
  (`<@ID>` / `<@&ID>`) itself; callers never provide tokens or IDs. Unknown
  destinations or mention aliases fail closed.
- Mentioned user/role IDs must also pass the global mention allowlists above,
  and the send goes through the same hardened `sendMessage` path used by MCP
  tools: `@everyone`/`@here` parsing stays suppressed, `repliedUser` stays
  `false`, and `allowedMentions` is assigned last so no `extra` option can
  override it.
- At startup — after Discord login — every configured destination is verified:
  the guild and policy-allowed channel must exist, the bot must be able to view
  and send there, user aliases must resolve to members of that guild, and role
  aliases must resolve to globally allowlisted, non-managed, mentionable roles.
  Any mismatch aborts startup. There is no fuzzy fallback.

## Security and delivery model

- Exact guild/channel and Telegram-user allowlists fail closed.
- Unknown/self bot, webhook, system, and unaddressed Discord messages are ignored.
- The bridge secret is distinct from the public MCP credential.
- Account and route files are atomic, root-owned, and mode `0600`; malformed,
  conflicting, symlinked, or unsafe state aborts startup rather than being
  silently replaced.
- The reply guard resolves the newest genuine user turn from scoped
  conversation history at tool-execution time, validates its gateway
  notification against the selected agent's persisted route, and only then
  rewrites `MessageChannel` arguments. It does not retain a process-local
  previous route across rapid platform or Discord-channel switches.
- Discord queueing is currently best-effort and in memory. A restart can lose
  unacknowledged events; a crash after Letta accepts an event but before bridge
  acknowledgement can redeliver it once.
- A Railway volume causes brief listener downtime during redeploy because old
  and new deployments cannot mount the same volume simultaneously.

## Development

```bash
npm ci
npm test
docker build -t continuity-discord-bridge .
docker build -f deploy/continuity-listener/Dockerfile -t continuity-listener deploy/continuity-listener
```

CI tests Node 20 and 22 and builds both images. The listener itself pins Node
22.19.0 by digest and `@letta-ai/letta-code@0.32.12`.

The exact Railway Template Composer contract is in
[`deploy/railway-template/template-spec.md`](deploy/railway-template/template-spec.md).

## License

MIT.
