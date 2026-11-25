# Build native modules with the same Node binary that runs in production.
ARG NODE_IMAGE=node:24.22.3-bookworm-slim@sha256:873f586f3794f52281bd039bf02c048a0be08fde619338f9941bad1eb6b34530
FROM gcr.io/distroless/cc-debian13:nonroot@sha256:532c7a94f9e96ba9db75eb9388f4227751131c7cb0a411d1a8521af4096135de AS cpp-runtime

FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY index.html tsconfig*.json vite.config.ts postcss.config.js tailwind.config.js ./
COPY src ./src
COPY public ./public
COPY server ./server
COPY shared ./shared
ARG VITE_BUILD_COMMIT=local
RUN npm run build

FROM ${NODE_IMAGE} AS production-deps
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY server/package*.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
    && npm rebuild better-sqlite3 --ignore-scripts=false

# Node and SQLite need the GCC runtime. Copy its libraries, licensing and package
# records from the matching Debian 13 image so scanners can inventory them.
RUN --mount=type=bind,from=cpp-runtime,target=/cc \
    mkdir -p /app/data /runtime-libs && cd /cc && cp -a --parents \
      usr/lib/*-linux-gnu/libstdc++.so.6* usr/lib/*-linux-gnu/libgcc_s.so.1 \
      usr/share/doc/gcc-14-base usr/share/doc/libgcc-s1 usr/share/doc/libstdc++6 \
      var/lib/dpkg/status.d/gcc-14-base* var/lib/dpkg/status.d/libgcc-s1* \
      var/lib/dpkg/status.d/libstdc++6* /runtime-libs/

FROM gcr.io/distroless/base-nossl-debian13:nonroot@sha256:4006ac92504be607b70de01d1f64f38288c69fcd8faa820f6d3aed266ea32ac5 AS runtime
COPY --from=production-deps /runtime-libs/ /
WORKDIR /app
COPY --from=production-deps /usr/local/bin/node /usr/local/bin/node
COPY --from=production-deps --chown=1000:1000 /app/data /app/data

COPY --from=production-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/server ./server
COPY --from=build /app/shared ./shared
COPY package.json ./

ENV DATA_DIR=/app/data
ENV NODE_ENV=production
ENV PORT=1610
ENV LOG_PRETTY_PRINT=false

USER 1000:1000
EXPOSE 1610
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 CMD ["node", "server/healthcheck.js"]
ENTRYPOINT []
CMD ["node", "server/index.js"]
