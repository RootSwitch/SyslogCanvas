# build stage: install production deps; compiles better-sqlite3 from source
# if no musl prebuild exists for this Node version
FROM node:22-alpine AS build
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# runtime
FROM node:22-alpine
ENV NODE_ENV=production \
    PORT=9514 \
    SYSLOG_PORT=5514 \
    TRAP_PORT=5162 \
    SYSLOGCANVAS_DATA=/data
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY package.json ./
COPY server ./server
COPY public ./public
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
# 9514 web UI; syslog/traps listen on unprivileged in-container ports so the
# process can stay USER node - compose maps host 514/162 onto them.
EXPOSE 9514 5514/udp 5162/udp
# The server speaks HTTP, or HTTPS when a cert exists in /data/certs - try both.
HEALTHCHECK --interval=60s --timeout=5s --start-period=10s \
    CMD wget -qO- "http://127.0.0.1:$PORT/api/health" || \
        wget -qO- --no-check-certificate "https://127.0.0.1:$PORT/api/health" || exit 1
CMD ["node", "server/server.js"]
