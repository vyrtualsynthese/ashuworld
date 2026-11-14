# syntax=docker/dockerfile:1

# The worker image: the outbox loop, bundled the same way as the api image.
#
# It runs no HTTP server. The hook receiver arrives in a later plan, and until then the
# worker has no port to expose and the ingress does not route to it; the chart's worker
# Deployment therefore carries no probes and no Service.
#
# Build from the repository root:
#   docker build -f docker/worker.Dockerfile -t ashuworld/worker .

FROM node:25-slim AS build

ENV CI=true
RUN npm install --global pnpm@10.34.9

WORKDIR /repo

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/gameconfig/package.json packages/gameconfig/package.json
COPY packages/ledger/package.json packages/ledger/package.json
COPY packages/providers/package.json packages/providers/package.json

RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

COPY tsconfig.base.json tsconfig.json ./
COPY packages packages
COPY apps/worker apps/worker

# The same ESM banner as the api image: `pg` reaches for Node builtins with a runtime
# `require()`, which esbuild's ESM shim cannot answer without a real `require` in scope.
RUN pnpm exec esbuild apps/worker/src/index.ts \
      --bundle --platform=node --format=esm --target=node22 \
      --external:pg-native \
      --banner:js="import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" \
      --outfile=/out/worker.js

FROM node:25-slim AS runtime

ENV NODE_ENV=production

WORKDIR /app

RUN groupadd --system --gid 10001 ashuworld \
 && useradd --system --uid 10001 --gid ashuworld --home-dir /app --shell /usr/sbin/nologin ashuworld

COPY --chown=10001:10001 docker/runtime-package.json /app/package.json
COPY --from=build --chown=10001:10001 /out/worker.js /app/dist/worker.js

# The `recompute-levels` subcommand resolves game.json the same way the api does:
# `new URL('../../../packages/gameconfig/config/game.json', import.meta.url)`. From
# /app/dist/worker.js that is /packages/gameconfig/config/game.json. Without this copy the
# Job fails at runtime with "cannot read the game config", after the pod has started.
COPY --from=build --chown=10001:10001 \
     /repo/packages/gameconfig/config/game.json /packages/gameconfig/config/game.json

USER 10001:10001

# No EXPOSE: the process opens no socket.

CMD ["node", "dist/worker.js"]
