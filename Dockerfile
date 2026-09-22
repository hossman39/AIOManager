# Same pinned Node/Debian image for build, native dependencies, and runtime.
ARG NODE_IMAGE=node:24.21.0-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6
FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY . .
ARG VITE_BUILD_COMMIT=local
RUN npm run build

FROM ${NODE_IMAGE} AS production-deps
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
    && npm rebuild better-sqlite3 --ignore-scripts=false

FROM ${NODE_IMAGE} AS runtime
WORKDIR /app
RUN mkdir -p /app/data && chown node:node /app/data

COPY --from=production-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/server ./server
COPY --from=build /app/shared ./shared
COPY package.json ./

ENV DATA_DIR=/app/data
ENV NODE_ENV=production
ENV PORT=1610
ENV LOG_PRETTY_PRINT=false

USER node
EXPOSE 1610
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 CMD ["node", "server/healthcheck.js"]
CMD ["node", "server/index.js"]
