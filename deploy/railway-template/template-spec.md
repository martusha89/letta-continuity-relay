# Continuity Relay Railway template specification

This is the source-of-truth checklist for creating the unpublished Railway
template. Railway templates are currently composed from a project rather than
from a committed template manifest, so do not publish a template until its
generated project matches this document and passes the live regression in
`../continuity-listener/README.md`.

## Topology

Create exactly two services from the same repository and one persistent
volume:

| Resource | Source | Dockerfile | Public network | Replicas |
| --- | --- | --- | --- | --- |
| `discord-bridge` | repository root | `Dockerfile` | enabled | **1** |
| `continuity-listener` | repository root | `deploy/continuity-listener/Dockerfile` | not required | **1** |
| `continuity-state` | Railway volume | mount on listener at `/root` | n/a | n/a |

Do not set a service root directory. Both Dockerfiles require the repository
root as their build context.

The bridge owns the only Discord Gateway connection. The listener owns the
only Telegram poller and the only long-poll consumer of the bridge queue.
Neither service is horizontally scalable.

## `discord-bridge` settings

In the Template Composer service settings, set **Healthcheck Path** to `/ready`
and **Healthcheck Timeout** to `120` seconds for the first Discord login. The
Docker image's own `/health` check is only container liveness; it does not
replace Railway's `/ready` deployment gate.

### Required user inputs

| Variable | Description shown to the user |
| --- | --- |
| `DISCORD_TOKEN` | **Required configurable secret.** Discord bot token. Create the application/bot first, enable Message Content Intent, invite it to the intended server, then paste the token here. |
| `DISCORD_ALLOWED_GUILD_IDS` | **Required configurable value.** Comma-separated 17–20 digit Discord server IDs. Start with exactly one server. |
| `DISCORD_ALLOWED_CHANNEL_IDS` | **Required configurable value.** Comma-separated 17–20 digit channel IDs where the bot may read, send, and receive addressed messages. These same IDs become listener routes. |

### Generated or fixed values

```dotenv
PORT=3001
MCP_TRANSPORT=http
MCP_HOST=0.0.0.0
MCP_HTTP_BEARER_TOKEN=${{secret(64)}}
DISCORD_BRIDGE_ENABLED=true
DISCORD_BRIDGE_BEARER_TOKEN=${{secret(64)}}
DISCORD_ALLOWED_DM_USER_IDS=
DISCORD_ALLOWED_MENTION_USER_IDS=
DISCORD_BRIDGE_DM_USER_IDS=
DISCORD_BRIDGE_ROLE_IDS=
DISCORD_BRIDGE_ALLOW_EVERYONE=false
```

The MCP and bridge bearer tokens must be generated independently. Never reuse
the Discord token or either bearer token in another field.

### Optional expert inputs

- `DISCORD_BRIDGE_ROLE_IDS`: exact roles whose mentions wake the agent.
- `DISCORD_BRIDGE_ALLOW_EVERYONE`: keep `false` unless every `@everyone` and
  `@here` message should enter the selected agent conversation.
- `DISCORD_ALLOWED_MENTION_USER_IDS`: users/bots the MCP may deliberately ping.
- `ELEVENLABS_API_KEY` and `ELEVENLABS_VOICE_ID`: only when Discord voice-note
  output is wanted.

Keep Discord DMs empty/disabled in the beginner template. Their inbound and
outbound identity mapping must be validated separately before exposure.

## `continuity-listener` settings

Attach `continuity-state` at `/root`. In the Template Composer service settings,
set **Healthcheck Path** to `/ready` and **Healthcheck Timeout** to `180`
seconds for runtime installation and channel startup. The image's Docker
`/health` check is process liveness only.

### Required user inputs

| Variable | Description shown to the user |
| --- | --- |
| `LETTA_API_KEY` | **Required configurable secret.** Letta API key that can access the selected cloud agent. |
| `LETTA_AGENT_ID` | **Required configurable value.** Exact existing `agent-...` ID. The installer does not create or clone an agent. |
| `TELEGRAM_BOT_TOKEN` | **Required configurable secret.** Telegram token from BotFather. Use a bot not polled anywhere else. |
| `TELEGRAM_CHAT_ID` | **Required configurable value.** Numeric private-chat ID to allow and route. |

### References and fixed values

```dotenv
LETTA_BASE_URL=https://api.letta.com
LETTA_CONVERSATION_ID=default
LETTA_ENV_NAME=continuity-railway
LETTA_CHANNEL_CREDENTIALS_STORE=file
LETTA_RESTORE_ENABLED_CHANNELS=1
LETTA_LOCAL_BACKEND_EXPERIMENTAL=0
TELEGRAM_ACCOUNT_ID=continuity-main
TELEGRAM_DISPLAY_NAME=Continuity Telegram
TELEGRAM_RICH_MESSAGES=false
DISCORD_ACCOUNT_ID=continuity-main
DISCORD_DISPLAY_NAME=Continuity Discord
DISCORD_BRIDGE_BASE_URL=http://${{discord-bridge.RAILWAY_PRIVATE_DOMAIN}}:${{discord-bridge.PORT}}
DISCORD_BRIDGE_BEARER_TOKEN=${{discord-bridge.DISCORD_BRIDGE_BEARER_TOKEN}}
DISCORD_CHANNEL_IDS=${{discord-bridge.DISCORD_ALLOWED_CHANNEL_IDS}}
```

Leave `TELEGRAM_ALLOWED_USER_IDS` unset to default it to the private chat ID.
Do not put the Discord token or MCP bearer token on the listener service.

## Manual prerequisites the template cannot perform

1. Create/select the existing Letta agent and API key.
2. Create the Telegram bot with BotFather and learn the intended private chat
   ID.
3. Create the Discord application/bot, enable privileged Message Content
   Intent, invite it to the server, and grant only the channel permissions it
   needs.
4. Copy the Discord server/channel snowflakes with Developer Mode.
5. Optionally attach the public bridge MCP endpoint if proactive Discord
   read/list/file/sticker/status tools are desired. Generate a Railway domain
   for `discord-bridge`, use `https://<generated-domain>/mcp`, and authenticate
   with `Authorization: Bearer <MCP_HTTP_BEARER_TOKEN>` in the chosen MCP host.
   Channel replies do not require this optional MCP attachment.

The setup UI and template overview must state these prerequisites before the
user deploys. Do not market this as zero-configuration.

## Security and operational warnings

- The same Discord or Telegram bot token must never be running in a second
  listener. Duplicate gateway/poller owners produce duplicate replies and
  race acknowledgements.
- Bridge delivery is currently best-effort and in-memory. A service restart
  can lose unacknowledged events; a crash between Letta acceptance and bridge
  acknowledgement can redeliver one event.
- Every Telegram and Discord route must target the same agent ID and exact
  conversation ID. This is what creates cross-channel continuity.
- The reply-route guard is mandatory when multiple channels share one
  conversation. It prevents a stale `MessageChannel` schema from sending a
  reply back to the preceding platform.
- Letta's public documentation currently describes custom CLI channels as a
  local-backend surface. This cloud-agent listener is an advanced,
  self-managed community pattern and must remain version-pinned and regression
  tested.
- A listener volume causes brief redeploy downtime because the old and new
  deployments cannot mount the same volume simultaneously. Healthchecks going
  green still do not prove Telegram, Discord, or model routing end to end.

## Template Composer walkthrough

This is the nontechnical authoring path described by Railway's current
template documentation:

1. In Railway, open **Workspace Settings → Templates → New Template**.
2. Add the repository as a GitHub source twice. Name the services exactly
   `discord-bridge` and `continuity-listener`.
3. Leave both service root directories empty so the repository root remains
   the Docker build context.
4. For `discord-bridge`, select the root `Dockerfile`, enable HTTP public
   networking, click **Generate Domain**, set `/ready` plus a 120-second
   Healthcheck Timeout, and add the bridge variables above.
5. For `continuity-listener`, set the Dockerfile path to
   `deploy/continuity-listener/Dockerfile`, set `/ready` plus a 180-second
   Healthcheck Timeout, and add the listener variables/references above. Public
   networking is unnecessary for this service.
6. Add a Railway volume named `continuity-state`, attach it only to
   `continuity-listener`, and mount it at `/root`.
7. Confirm both services are fixed at one replica. Mark the four credentials
   and identity values in each **Required user inputs** table as configurable
   template inputs with their descriptions visible before deployment.
8. Create the template as an **unpublished draft**. Deploy that draft into a
   fresh project and complete the live validation sequence before sharing its
   URL.

The current Railway CLI also exposes `railway templates create` for maintainers
who have already built and tested a source project. The Template Composer is
the preferred path for the intended nontechnical audience because it makes the
variables, volume, healthchecks, networking, and service sources visible for
inspection.

## Acquiring the required IDs safely

- **Telegram:** create the bot through official `@BotFather`, send the new bot
  a private message, then query Telegram's official `getUpdates` Bot API from a
  local terminal to read `message.chat.id`. Do not paste a bot token into a
  third-party “ID finder” website.
- **Discord:** enable Developer Mode in Discord, then use **Copy Server ID** and
  **Copy Channel ID**. In the Developer Portal enable **Message Content Intent**.
  Invite the bot with only the permissions it needs: View Channels, Send
  Messages, Read Message History, Add Reactions, Attach Files, Embed Links, and
  Use External Emojis/Stickers where those output features are wanted.
- **Letta:** create an API key in the Letta account that owns the target agent,
  then copy the exact agent ID from that agent's details. The beginner template
  always uses the existing `default` conversation; advanced users may replace
  it with another exact conversation ID.

## Template creation gate

Before creating a draft in Template Composer or running
`railway templates create`:

1. Build both images from a clean checkout.
2. Confirm no secret appears in either image history or logs.
3. Deploy into a new project with new test bots, a new bridge secret, and a
   disposable test agent/conversation.
4. Run every live test in `../continuity-listener/README.md`.
5. Restart each service independently and repeat Telegram + Discord routing.
6. Confirm a second replica cannot be enabled accidentally in the template.
7. Generate an **unpublished** template draft and inspect every variable,
   description, reference, volume, healthcheck, and source before sharing its
   URL.

Publishing to the Railway marketplace is a separate external action and must
not be inferred from successful local or staging validation.
