# syntax=docker/dockerfile:1

# The api image: one esbuild bundle of TypeScript source on a plain Node runtime.
#
# The workspace packages export TypeScript source (R7 in the plan), so there is no build
# output to copy between stages: the bundle *is* the build. That keeps the runtime image
# free of a compiler, of dev dependencies and of the pnpm store.
#
# Build from the repository root:
#   docker build -f docker/api.Dockerfile -t ashuworld/api .

FROM node:22-slim AS build

ENV CI=true
# Pinned to the version in package.json's `packageManager`, installed rather than
# corepack-enabled so the download is a normal layer that the dependency cache can reuse.
RUN npm install --global pnpm@10.34.9

WORKDIR /repo

# Manifests first: the dependency layer stays cached until a package.json or the lockfile
# changes, which is most of the build time.
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
COPY apps/api apps/api

# `pg` is CommonJS and reaches for Node builtins with a runtime `require()`. In an ESM
# bundle esbuild's shim for that throws "Dynamic require of \"events\" is not supported", so
# a real `require` is installed at the top of the bundle. It resolves relative to the bundle
# itself, which is also what the migrations path depends on.
#
# `pg-native` is the module `pg` tries when it is installed. It is not, and never will be
# here, so esbuild is told not to resolve it; bundling everything else means the runtime
# stage needs no node_modules at all.
RUN pnpm exec esbuild apps/api/src/index.ts \
      --bundle --platform=node --format=esm --target=node22 \
      --external:pg-native \
      --banner:js="import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" \
      --outfile=/out/server.js

# The migrate Job runs this one instead of the server. Both bundles include the ledger, and
# both resolve `../migrations/` from their own location.
RUN pnpm exec esbuild apps/api/src/migrate-cli.ts \
      --bundle --platform=node --format=esm --target=node22 \
      --external:pg-native \
      --banner:js="import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" \
      --outfile=/out/migrate.js

FROM node:22-slim AS runtime

ENV NODE_ENV=production

WORKDIR /app

# A fixed uid with no login shell and no home directory of its own: the chart asserts
# `runAsNonRoot`, and this is the same number in the image so `docker run` behaves like the
# cluster does.
RUN groupadd --system --gid 10001 ashuworld \
 && useradd --system --uid 10001 --gid ashuworld --home-dir /app --shell /usr/sbin/nologin ashuworld

# `{"type":"module"}`: the bundle is ESM, and Node decides that from the nearest
# package.json. Without it, `import.meta.url` in the bundle is a syntax error.
COPY --chown=10001:10001 docker/runtime-package.json /app/package.json

COPY --from=build --chown=10001:10001 /out/server.js /app/dist/server.js
COPY --from=build --chown=10001:10001 /out/migrate.js /app/dist/migrate.js

# `migrationFiles()` reads `new URL('../migrations/', import.meta.url)`, which from
# /app/dist/migrate.js is /app/migrations. A missing directory there makes the Job fail with
# the path it looked for, which is the honest failure; a copied-but-empty one would apply
# nothing and report success.
COPY --from=build --chown=10001:10001 /repo/packages/ledger/migrations /app/migrations

# The api reads game.json through `new URL('../../../packages/gameconfig/config/game.json',
# import.meta.url)`. From /app/dist/server.js that resolves to /packages/gameconfig/config/
# game.json, so the file is placed at the path the source already names rather than adding
# an environment variable the running code does not read.
COPY --from=build --chown=10001:10001 \
     /repo/packages/gameconfig/config/game.json /packages/gameconfig/config/game.json

USER 10001:10001

EXPOSE 3000

CMD ["node", "dist/server.js"]
