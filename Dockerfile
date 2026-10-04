# syntax=docker/dockerfile:1

# ── 1. Build the React app ───────────────────────────────────────────────────
FROM node:22-bookworm-slim AS frontend
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
RUN npm run build

# ── 2. Install the API's production dependencies ─────────────────────────────
# The SQLite driver is a native module. It normally downloads a prebuilt binary;
# the compiler is here only as a fallback and never reaches the final image.
FROM node:22-bookworm-slim AS backend
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app/backend
COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# ── 3. Runtime image ─────────────────────────────────────────────────────────
FROM node:22-bookworm-slim
# TRUST_PROXY=1: the container runs behind one reverse proxy (Dokploy's Traefik),
# which supplies the real client address and whether the request came over HTTPS.
ENV NODE_ENV=production \
    PORT=3001 \
    DATA_DIR=/data \
    APP_TIMEZONE=Asia/Colombo \
    TRUST_PROXY=1
WORKDIR /app

COPY --from=backend /app/backend/node_modules ./backend/node_modules
COPY backend/package.json ./backend/package.json
COPY backend/src ./backend/src
COPY --from=frontend /app/frontend/dist ./frontend/dist

# Everything that must survive a redeploy lives in /data:
# the database, uploaded receipts and logo, and the automatic backups.
RUN mkdir -p /data && chown -R node:node /data
VOLUME ["/data"]

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Starts as root only long enough to make /data writable, then runs the server
# as the unprivileged "node" user (see container-start.js).
CMD ["node", "backend/src/scripts/container-start.js"]
