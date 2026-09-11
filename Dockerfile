# ============================================================
# ttdownload-web 镜像（多阶段构建：前端 -> 后端 -> 运行）
# ============================================================
FROM node:20-bookworm-slim AS web-builder
WORKDIR /app/web
COPY web/package*.json ./
RUN npm ci --no-audit --no-fund || npm install --no-audit --no-fund
COPY web/ ./
RUN npm run build

FROM node:20-bookworm-slim AS api-builder
WORKDIR /app
COPY package*.json ./
RUN npm ci --no-audit --no-fund || npm install --no-audit --no-fund
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

FROM node:20-bookworm-slim AS runtime
ENV NODE_ENV=production \
    PORT=8080 \
    DOWNLOAD_ROOT=/ttdownload
WORKDIR /app

# 运行期外部工具：aria2 / transmission / yt-dlp / ffmpeg / openssl / zip
RUN apt-get update && apt-get install -y --no-install-recommends \
      aria2 transmission-daemon transmission-cli ffmpeg openssl zip unzip python3-pip ca-certificates curl \
    && pip3 install --no-cache-dir --break-system-packages yt-dlp \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund || npm install --omit=dev --no-audit --no-fund
COPY --from=api-builder /app/dist ./dist
COPY --from=web-builder /app/public ./public
COPY docs/ ./docs/
COPY .env.example ./.env.example

VOLUME ["/ttdownload"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${PORT}/api/health" || exit 1

CMD ["node", "dist/server.js"]
