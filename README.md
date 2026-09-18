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

## Optional Discord MCP tools

Channel replies work without attaching the MCP endpoint. To give the agent
proactive Discord read/list/file/sticker/status tools as well, generate a public
domain for `discord-bridge`, use:

```text
https://<your-generated-domain>/mcp
```

and configure the MCP host with:

```text
Authorization: Bearer <MCP_HTTP_BEARER_TOKEN>
```

The public MCP route is bearer-authenticated; listener-to-bridge event traffic
uses a different secret and remains on Railway's private network.

## Security and delivery model

- Exact guild/channel and Telegram-user allowlists fail closed.
- Bot, webhook, system, and unaddressed Discord messages are ignored.
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
