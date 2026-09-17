FROM node:22.19.0-bookworm-slim@sha256:4a4884e8a44826194dff92ba316264f392056cbe243dcc9fd3551e71cea02b90

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    build-essential \
    ca-certificates \
    curl \
    ffmpeg \
    git \
    python3 \
  && rm -rf /var/lib/apt/lists/*

RUN npm install --global @letta-ai/letta-code@0.32.12

WORKDIR /app

COPY deploy/continuity-listener/entrypoint.mjs /app/entrypoint.mjs
COPY deploy/continuity-listener/channel-reply-route-guard.ts /app/channel-reply-route-guard.ts
COPY letta-channel/continuity-discord/plugin.mjs /app/continuity-discord/plugin.mjs

ENV NODE_ENV=production \
    LETTA_BASE_URL=https://api.letta.com \
    LETTA_CHANNEL_CREDENTIALS_STORE=file \
    LETTA_RESTORE_ENABLED_CHANNELS=1 \
    LETTA_LOCAL_BACKEND_EXPERIMENTAL=0

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "/app/entrypoint.mjs"]
