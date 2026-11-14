# AshuWorld

Fans earn XP for what they do for the channel, level up, and can show that level wherever
they appear. This repository is the system behind it: an XP ledger, fan accounts that link the
platforms a fan already uses, a public ladder, and the deployment that runs it.

The design is written down before the code, in
[`docs/superpowers/specs/2026-11-14-ashuworld-fan-xp-design.md`](docs/superpowers/specs/2026-11-14-ashuworld-fan-xp-design.md),
and the build order in
[`docs/superpowers/plans/2026-11-14-ashuworld-foundation.md`](docs/superpowers/plans/2026-11-14-ashuworld-foundation.md).

**Status: alpha.** Data will be wiped before launch. Onboarding is open to early fans so the
numbers can be tuned against real behaviour.

## The rules the code enforces

- **A level is never lost.** `peak_xp` is a high-water mark and the level derives from it, so a
  punishment or a detach lowers the balance but never the badge.
- **One action, one credit.** A one-time action pays once per provider account, enforced by a
  partial unique index. Unfollowing, refollowing and re-linking cannot pay twice.
- **Detaching is a forfeit, not a pause.** The earns are marked `forfeited_at`, never deleted, so
  the action stays spent and the XP does not come back if the account is attached again.
- **A linked account never returns to the ladder.** Once an identity has belonged to a fan
  account it has no public life of its own, even after a detach.
- **One fan, many doors, no impersonation.** A fan holds at most one account per platform,
  always keeps at least one way in, and can never read or act on another fan's data.

## What is in here

| Path | What it does |
|---|---|
| `packages/ledger` | The rules and the SQL. Awards, balances, link/detach, penalties, the ladder, the alpha reset. |
| `packages/gameconfig` | Action values and the level table, versioned, loaded from `config/game.json`. |
| `packages/providers` | Provider names and the identity shape shared by the API and the worker. |
| `apps/api` | HTTP: sign-in, sessions, accounts, public ladder and profile. |
| `apps/web` | React app: ladder, profile, account page. |
| `apps/worker` | Queue loop: claims platform events, awards them, retries a bounded number of times. |
| `deploy/helm/ashuworld` | The chart: deployments, ingress, migration and reset jobs. |
| `docker/` | Three images: esbuild bundles, non-root, read-only root filesystem. |

## Run it locally

Requires Docker with Compose. No Node installation is needed.

```bash
docker compose up --build
```

Then open <http://localhost:8080>.

- **Sign in:** the account page offers a dev sign-in (the `dev` provider). Type a handle and you
  get a fan with no platform involved. It exists so the flow is testable before the real
  Twitch, Discord and YouTube applications exist, and `ALLOW_DEV_LOGIN` is off everywhere else.
- **Ladder:** <http://localhost:8080/ladder> starts empty and fills in as fans earn.
- **Database:** Postgres is on `localhost:5432`, user, password and database all `ashu`.
- **Stop:** `docker compose down`. Add `-v` to throw the database away and start clean.

The web container proxies `/api` and `/auth` to the API, which is why the session cookie stays
first-party: one origin, no CORS.

### Developing without containers

For fast iteration on the code, let Compose own the database and the migrations, and run the
Node processes locally:

```bash
docker compose up -d db
docker compose run --rm migrate

pnpm install
export DATABASE_URL=postgres://ashu:ashu@localhost:5432/ashu
export PUBLIC_BASE_URL=http://localhost:5173
export ALLOW_DEV_LOGIN=true
export COOKIE_SECURE=false

pnpm --filter @ashuworld/api dev      # :3000
pnpm --filter @ashuworld/web dev      # :5173, proxies /api and /auth to :3000
pnpm --filter @ashuworld/worker build  # the worker has no watch mode yet
```

Vite proxies `/api` and `/auth` to `http://localhost:3000` in dev, so the browser still sees one
origin and the session cookie stays first-party.

## Tests

```bash
export TEST_DATABASE_URL=postgres://ashu:ashu@localhost:55432/ashu
pnpm typecheck
pnpm lint
pnpm test:coverage
```

The tests run against a real Postgres; each test file gets its own throwaway schema. Coverage
must stay at or above 80% on lines, branches, functions and statements, and each game rule is
pinned by a test that fails when its guard is removed.

The chart has its own checks:

```bash
bash deploy/helm/ashuworld/test/render.sh
helm lint deploy/helm/ashuworld
```

## Deploying

The chart expects an existing Postgres and a Secret holding its URL:

```bash
helm upgrade --install ashuworld deploy/helm/ashuworld \
  --set ingress.host=ashu.example.com \
  --set postgres.secretName=ashuworld-db
```

Three settings matter and are documented in `values.yaml`:

- `TRUST_PROXY` must be `true` in the cluster, or the API logs the ingress address as the client.
- `ALLOW_DEV_LOGIN` must stay `false`.
- `hooks.enabled` routes `/hooks` to the worker and stays `false` until a real platform adapter
  can verify signatures.

Migrations run as a `pre-install,pre-upgrade` Job from the API image, which carries the SQL files
next to the bundle.

## Where we are going

The foundation is in: ledger, accounts, ladder, worker, images and chart. Next are the platform
adapters (Twitch EventSub, Discord membership, YouTube subscription through each fan's own
grant), the operator tools (punishments, the audited account repair), and the bot and overlay
surfaces that read the public profile API.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Security reports: [SECURITY.md](SECURITY.md).

## Licence

[MIT](LICENSE).
