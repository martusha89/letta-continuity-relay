# Continuity Listener

This image runs Telegram and the repository's custom Discord channel in one
Letta channel gateway so both platforms route into the **same agent and the
same conversation**. It is the stateful listener half of a two-service Railway
installation; the repository root image remains the Discord gateway/bridge.

The listener is deliberately single-purpose:

- seed one allowlisted Telegram private chat;
- seed exact Discord channel routes;
- install the audited bridge plugin as the distinct `continuity-discord` custom channel under the generic display
  name **Continuity Discord**;
- install a deterministic reply-route guard scoped to the selected agent and
  conversation;
- start one `letta server` process with `telegram,continuity-discord`;
- retain account, route, pairing, and listener state on a `/root` volume.

## Railway service shape

Build this service with its self-contained listener directory as the service
root:

```text
Root directory:  deploy/continuity-listener
Dockerfile path: Dockerfile
Volume mount:    /root
Replicas:        1
Healthcheck:     /ready
```

The separate Discord bridge service should use the repository root
`Dockerfile` and expose its HTTP port. Prefer Railway private networking from
the listener to the bridge, for example:

```text
DISCORD_BRIDGE_BASE_URL=http://${{discord-bridge.RAILWAY_PRIVATE_DOMAIN}}:${{discord-bridge.PORT}}
```

Generate `DISCORD_BRIDGE_BEARER_TOKEN` once on the bridge service with a
Railway template variable such as `${{secret(64)}}`, then reference that same
service variable from the listener. Never generate it independently on both
services.

## Required environment variables

| Variable | Purpose |
| --- | --- |
| `LETTA_API_KEY` | Letta Cloud API key able to access the selected agent. |
| `LETTA_AGENT_ID` | Exact target agent ID. |
| `TELEGRAM_BOT_TOKEN` | Token from Telegram BotFather. Stored only in the mode-0600 account file on the volume. |
| `TELEGRAM_CHAT_ID` | Exact private Telegram chat to route. |
| `DISCORD_BRIDGE_BASE_URL` | Absolute HTTP(S) URL of the companion Discord bridge service. Use Railway private networking where possible. |
| `DISCORD_BRIDGE_BEARER_TOKEN` | Shared bridge secret, at least 32 characters and identical on both services. |
| `DISCORD_CHANNEL_IDS` | Comma-separated Discord channel/forum-parent IDs routed into the target conversation. Each must be a 17–20 digit snowflake. |

## Optional environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `LETTA_BASE_URL` | `https://api.letta.com` | Letta API endpoint. |
| `LETTA_CONVERSATION_ID` | `default` | Shared conversation used by both channels. |
| `LETTA_ENV_NAME` | `continuity-railway` | Value passed to Letta 0.32.12 as `--computer-name`. The legacy variable name is retained for compatibility with existing deployments. |
| `TELEGRAM_ALLOWED_USER_IDS` | `TELEGRAM_CHAT_ID` | Comma-separated Telegram user IDs allowed to use the private bot. |
| `TELEGRAM_ACCOUNT_ID` | `continuity-main` | Stable local channel account ID. |
| `TELEGRAM_DISPLAY_NAME` | `Continuity Telegram` | Local account label. |
| `TELEGRAM_RICH_MESSAGES` | `false` | Set to exact string `true` only when the user's Telegram clients render rich private messages correctly. |
| `DISCORD_ACCOUNT_ID` | `continuity-main` | Stable local custom-channel account ID. |
| `DISCORD_DISPLAY_NAME` | `Continuity Discord` | Local custom-channel label. |
| `LETTA_DEBUG` | unset | Set to `1` to start Letta with debug logging. Do not leave enabled casually in shared logs. |
| `SEED_ONLY` | `0` | Set to `1` to write validated state and exit without starting Letta. |

The image also sets `LETTA_CHANNEL_CREDENTIALS_STORE=file`,
`LETTA_RESTORE_ENABLED_CHANNELS=1`, and
`LETTA_LOCAL_BACKEND_EXPERIMENTAL=0`.

## Discord bridge contract

The bridge service remains the sole Discord Gateway owner. At minimum it must
have its own Discord bot token, HTTP/bridge secrets, and explicit guild/channel
policy. Enable Discord's privileged **Message Content Intent** in the Developer
Portal. Do not run a second Discord listener on the same bot token.

The listener creates exact routes only for `DISCORD_CHANNEL_IDS`. Removing an
ID removes only routes previously owned by this bootstrap; unrelated manual or
dynamically-created routes are preserved. New base channels require updating
the variable and redeploying. The existing custom channel may create thread
routes under approved forum parents, but that behavior must be verified
against the installed Letta version before relying on it.

## Persistence and safety

- Mount a persistent volume at `/root`. Without it, route/account state and
  listener identity are disposable on every deploy.
- Railway volume deployments have brief restart downtime because the outgoing
  and incoming deployment cannot mount the same volume simultaneously.
- Run exactly one replica. Telegram polling, the Discord bridge long poll, and
  listener locks are not a horizontally-scaled workload.
- State and credential files are written atomically with mode `0600`.
- The reply guard accepts only the gateway-generated notification wrapper at
  the beginning of a content part and verifies its account/chat against the
  selected agent's mode-0600 route registry before rewriting a tool call.
  Channel message text is XML-escaped by Letta and cannot mint a second trusted
  notification tag.
- The bootstrap logs no token or API-key values.
- Letta 0.32.12's own structured listener-lock handling remains intact. The
  bootstrap does not delete or bypass locks; a live competing listener must
  cause startup to fail rather than creating duplicate delivery.
- `/health` proves the bootstrap process is alive. `/ready` proves the Letta
  child process spawned and has not exited; it is not an end-to-end Telegram,
  Discord, or model-call probe.

## Important limitation

Letta's public custom-channel documentation currently describes CLI channels
as a **local-backend** feature. This package follows the already-working
advanced pattern of running a signed-in Letta listener on Railway against a
cloud-hosted agent. Treat that as community infrastructure, not a first-party
supported Letta Cloud integration. Pinning `@letta-ai/letta-code@0.32.12`
prevents silent listener changes; upgrades require a full Telegram → agent →
Telegram and Discord → agent → Discord regression test.

## Validation sequence

After both Railway services are healthy:

1. Send a Telegram message from the allowlisted user and verify the reply
   returns to Telegram.
2. Directly mention the Discord bot in one listed channel and verify the reply
   returns to that exact channel.
3. Send another Telegram message immediately afterward and verify it does not
   spill into Discord.
4. If using more than one Discord channel, repeat a rapid two-channel switch
   and verify every reply stays with its source.
5. Confirm native Discord typing appears while the agent is processing.

Do not describe the deployment as complete until all five legs pass.
