# syntax=docker/dockerfile:1

# The web image: a static Vite build served by nginx.
#
# One origin is a hard requirement, not a preference. The session cookie is `HttpOnly` and
# every call the pages make is an absolute `/api` or `/auth` path, so the browser must see
# the pages and the api on the same scheme, host and port. nginx therefore proxies `/api`
# and `/auth` to the api Service, and the SPA fallback deliberately does not get a chance
# to answer either prefix.
#
# VITE_DEV_LOGIN is compiled into the bundle (Vite replaces `import.meta.env` at build
# time), so flipping it is a rebuild of this image, never a value change in the chart.
#
# Build from the repository root:
#   docker build -f docker/web.Dockerfile -t ashuworld/web .
#   docker build -f docker/web.Dockerfile --build-arg VITE_DEV_LOGIN=true -t ashuworld/web:dev .

FROM node:22-slim AS build

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
COPY apps/web apps/web
COPY packages/providers packages/providers

# A production build has `import.meta.env.DEV === false`, so the dev door is off unless this
# says otherwise. `false` is written out rather than left unset so the build is explicit.
ARG VITE_DEV_LOGIN=false
ENV VITE_DEV_LOGIN=${VITE_DEV_LOGIN}

# `build` is `tsc --noEmit && vite build`: a type error fails the image, not the first
# request in production.
RUN pnpm --filter @ashuworld/web build

FROM nginx:1.29-alpine AS runtime

# The server block is a template: the api Service name is a release-time fact, so nginx's
# entrypoint renders it into /tmp at container start. /tmp is an `emptyDir` in the chart,
# which is also what makes the read-only root filesystem work.
COPY docker/nginx/nginx.conf /etc/nginx/nginx.conf
COPY docker/nginx/default.conf.template /etc/nginx/templates/default.conf.template
# The header set the SPA locations include. It is a separate file because a location that
# sets its own `add_header` does not inherit the server level ones.
COPY docker/nginx/security-headers.conf /etc/nginx/security-headers.conf
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html

# The entrypoint's envsubst step reads the template directory and writes here. /tmp is the
# only path the image needs to write.
ENV NGINX_ENVSUBST_OUTPUT_DIR=/tmp \
    API_UPSTREAM=http://127.0.0.1:3000

# The `nginx` user in the official alpine image. The chart runs the container as the same
# uid and gives the pod this fsGroup, so the /tmp emptyDir is writable.
USER 101:101

EXPOSE 8080

CMD ["nginx", "-g", "daemon off;"]
