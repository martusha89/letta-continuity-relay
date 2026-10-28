FROM node:22.23.4-bookworm-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22.23.4-bookworm-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d AS runtime

ENV NODE_ENV=production \
    PORT=3001 \
    MCP_TRANSPORT=http \
    MCP_HOST=0.0.0.0 \
    DISCORD_BRIDGE_ENABLED=true \
    DISCORD_BRIDGE_ALLOW_EVERYONE=false \
    DISCORD_BRIDGE_BOT_COOLDOWN_MS=30000
WORKDIR /app
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/build ./build

USER node
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.MCP_PORT||process.env.PORT||3001)+'/ready').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "build/index.js"]
