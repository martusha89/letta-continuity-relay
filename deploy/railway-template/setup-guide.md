# Continuity Relay: Railway setup guide

This guide deploys one existing Letta agent conversation through a private
Telegram bot and tightly allowlisted Discord channels.

Start here:

**https://railway.com/new/template/OpRbiK**

Railway should ask you for exactly seven values. Everything else is fixed,
generated, or connected privately by the template:

1. `LETTA_API_KEY`
2. `LETTA_AGENT_ID`
3. `TELEGRAM_BOT_TOKEN`
4. `TELEGRAM_CHAT_ID`
5. `DISCORD_TOKEN`
6. `DISCORD_ALLOWED_GUILD_IDS`
7. `DISCORD_ALLOWED_CHANNEL_IDS`

Do not paste any token into chat, a public issue, or a third-party “ID finder.”

## 1. Choose the Letta agent

This template connects an agent that already exists. It does not create or
copy one.

1. Open the agent in Letta.
2. Copy its exact ID. It starts with `agent-`. This is `LETTA_AGENT_ID`.
3. Create a Letta API key in the account or organisation that can access that
   agent. This is `LETTA_API_KEY`.

The beginner setup uses the agent's existing `default` conversation for both
Telegram and Discord.

## 2. Create the Telegram bot

1. In Telegram, open the verified official **@BotFather** account.
2. Send `/newbot` and follow its prompts.
3. Copy the token BotFather gives you. This is `TELEGRAM_BOT_TOKEN`.
4. Open your new bot and send it one ordinary message, such as `hello`.

Now obtain the numeric private chat ID from Telegram's official API. On macOS
or Linux, run this locally so the token is not placed in browser history:

```bash
read -s TELEGRAM_BOT_TOKEN
curl --silent "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates"
unset TELEGRAM_BOT_TOKEN
```

Paste the token when the terminal waits, then press Enter. In the JSON result,
find the message you just sent and copy its numeric `message.chat.id`. This is
`TELEGRAM_CHAT_ID`.

On Windows PowerShell:

```powershell
$token = Read-Host "Telegram bot token"
(Invoke-RestMethod "https://api.telegram.org/bot$token/getUpdates").result.message.chat.id
Remove-Variable token
```

Use a bot token that is not running in another gateway or listener. Telegram
allows only one polling owner; a duplicate poller causes stolen updates and
missing replies.

## 3. Create the Discord bot

1. Open the official Discord Developer Portal:
   **https://discord.com/developers/applications**
2. Select **New Application**.
3. Open **Bot**, create the bot if needed, and copy/reset its token. This is
   `DISCORD_TOKEN`.
4. On the same page, enable **Message Content Intent**.
5. Open **OAuth2 → URL Generator**.
6. Select the `bot` scope.
7. Select only the permissions the chosen channels need:
   - View Channels
   - Send Messages
   - Read Message History
   - Add Reactions
   - Attach Files
   - Embed Links
   - Use External Emojis and Use External Stickers only when wanted
8. Open the generated invite URL and add the bot to the intended server.

Do not grant Administrator.

## 4. Copy the Discord IDs

1. In Discord, open **User Settings → Advanced** and enable **Developer Mode**.
2. Right-click the server icon and choose **Copy Server ID**. This is
   `DISCORD_ALLOWED_GUILD_IDS`.
3. Right-click each allowed text channel or forum parent and choose
   **Copy Channel ID**. This is `DISCORD_ALLOWED_CHANNEL_IDS`.

For more than one server or channel, use comma-separated IDs with no quotes.
Start with one server and one ordinary text channel until the acceptance tests
pass.

## 5. Deploy the template

1. Open **https://railway.com/new/template/OpRbiK**.
2. Confirm the template contains exactly:
   - `discord-bridge`
   - `continuity-listener`
   - one `continuity-state` volume mounted on the listener at `/root`
3. Enter the seven values collected above.
4. Deploy.

The template creates separate random bridge and MCP secrets. It connects the
listener to the bridge over Railway's private network and fixes both services
at one replica. The beginner template does not need a public bridge domain.

Wait for both `/ready` healthchecks to become healthy. Green healthchecks prove
that the processes started; they do not prove end-to-end delivery.

## 6. Run every acceptance test

Do these in order:

1. **Telegram:** send a message from the configured private chat. Confirm the
   agent receives it and the reply returns to Telegram.
2. **Discord mention:** directly mention the bot in the allowed channel.
   Confirm the agent receives it and replies in that same channel.
3. **Immediate platform switch:** as soon as the Discord reply finishes, send
   another Telegram message. Confirm the reply returns only to Telegram.
4. **Rapid Discord switch:** if two channels are configured, mention the bot in
   one and then the other. Confirm each reply stays with its source channel.
5. **Typing:** confirm native Discord typing appears while the agent works.
6. **Attachment:** attach one small PNG, JPEG, GIF, or WebP to an addressed
   Discord message. Confirm the agent can inspect it.
7. **Approval recovery:** trigger a tool action that waits for approval, approve
   it, and confirm the original waiting turn continues rather than becoming
   stranded.
8. **Bridge restart:** restart only `discord-bridge`, then repeat one Telegram
   and one Discord message.
9. **Listener restart:** restart only `continuity-listener`, then repeat one
   Telegram and one Discord message.

Do not hand the deployment to someone else until every applicable check passes.

## 7. Safe defaults and optional trusted rooms

By default, a guild message enters only when a human or companion bot directly
mentions the relay, or directly replies to a relay-authored message. Replies to
other people, ambient messages, self messages, webhooks, system messages,
unlisted servers, and unlisted channels stay blocked.

`DISCORD_BRIDGE_ALL_MESSAGE_GUILD_IDS` is an advanced trusted-room option. It
allows ambient human and companion-bot messages only in explicitly listed
guilds and still only through `DISCORD_ALLOWED_CHANNEL_IDS`. Leave it empty
until the default setup has passed every test.

Do not attach the bridge's raw administrative MCP endpoint to the continuity
agent. That endpoint includes raw-target Discord tools that intentionally sit
outside ordinary reply-route pinning. The listener already supplies safe
ordinary replies and bounded proactive tools.

## Updating and rolling back

Before updating, record the currently working Git revision and Railway
deployment IDs.

1. Deploy the new revision without changing bot tokens or IDs.
2. Wait for both `/ready` checks.
3. Repeat the complete acceptance sequence above.
4. If any route, approval, attachment, or restart check fails, roll each
   affected service back to its last known-good Railway deployment.
5. Repeat Telegram and Discord checks after rollback.

The listener volume causes brief downtime during redeploy because two
deployments cannot mount the same `/root` volume simultaneously. Never work
around this by increasing the listener replica count.
