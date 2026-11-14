# AshuWorld

Dachis earn XP for what they do for the channel, level up, and can show that level wherever
they appear. This repository is the system behind it: an XP ledger, Dachi accounts that link the
platforms a Dachi already uses, a public ladder, and the deployment that runs it.

The design is written down before the code, in
[`docs/superpowers/specs/2026-11-14-ashuworld-fan-xp-design.md`](docs/superpowers/specs/2026-11-14-ashuworld-fan-xp-design.md),
and the build order in
[`docs/superpowers/plans/2026-11-14-ashuworld-foundation.md`](docs/superpowers/plans/2026-11-14-ashuworld-foundation.md).

**Status: alpha.** Data will be wiped before launch. Onboarding is open to early Dachis so the
numbers can be tuned against real behaviour.

## The rules the code enforces

- **A level is never lost.** `peak_xp` is a high-water mark and the level derives from it, so a
  punishment or a detach lowers the balance but never the badge.
- **No maximum level.** The table is a prefix; past its last row the curve keeps going, each
  level costing more than the one before.
- **One action, one credit.** A one-time action pays once per provider account, enforced by a
  partial unique index. Unfollowing, refollowing and re-linking cannot pay twice.
- **Detaching is a forfeit, not a pause.** The earns are marked `forfeited_at`, never deleted, so
  the action cannot pay a second time and the XP does not come back if the account is attached again.
- **A linked account never returns to the ladder.** Once an identity has belonged to a Dachi
  account it has no public life of its own, even after a detach.
- **One Dachi, many doors, no impersonation.** A Dachi holds at most one account per platform,
  always keeps at least one way in, and can never read or act on another Dachi's data.

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

The `/xp` page lists every action with its one-time bonus and its monthly amount, read from
`packages/gameconfig/config/game.json`; changing an amount there changes the page without a
code change.

## Run it locally

Two stacks, both in containers, both building from this working tree. Pick the one that matches
what you are doing.

Requires Docker with Compose. No Node installation is needed.

### Like production (one command, no reload)

```bash
docker compose up --build
```

Then open <http://localhost:8080>.

- **Sign in:** the account page offers a dev sign-in (the `dev` provider). Type a handle and you
  get a Dachi with no platform involved. It exists so the flow is testable before the real
  Twitch, Discord and YouTube applications exist, and `ALLOW_DEV_LOGIN` is off everywhere else.
- **Ladder:** <http://localhost:8080/ladder> starts empty and fills in as Dachis earn.
- **Database:** Postgres is on `localhost:5432`, user, password and database all `ashu`.
- **Stop:** `docker compose down`. Add `-v` to throw the database away and start clean.

The web container proxies `/api` and `/auth` to the API, which is why the session cookie stays
first-party: one origin, no CORS.

### Development stack (live reload, debuggers, debug logs)

```bash
pnpm install                          # once, on the host: the containers mount this tree
docker compose -f compose.dev.yaml up --build
```

Then open <http://localhost:5173>.

- **No restarts.** The repository is mounted into every container. `tsx watch` reloads the API
  and the worker on save; Vite reloads the browser. A change to a React page, a route or the
  ledger is visible immediately.
- **The watchers poll the mounted tree** (`CHOKIDAR_USEPOLLING`, `VITE_USE_POLLING`). `git pull`
  and `git rebase` replace watched files rather than editing them, and a native file watcher can
  miss that replacement and keep serving the previous build. Polling costs a little CPU and
  removes that class of "it did not pick up my change". If a change still does not appear,
  `docker compose -f compose.dev.yaml restart api worker` is the fast way back.
- **Debug logging.** `LOG_LEVEL=debug` is set for the API, so request and error detail appears in
  `docker compose -f compose.dev.yaml logs -f api`.
- **Debuggers.** The API listens on `localhost:9229` and the worker on `localhost:9230`
  (`NODE_OPTIONS=--inspect`). Attach with your editor's Node debugger.
- **Same shape as production.** Postgres, a migration run, then the API, the worker and Vite.
  The browser still sees one origin because Vite proxies `/api` and `/auth`.
- **If HMR does not reconnect** on a bind-mounted filesystem (some Docker Desktop setups), set
  `CHOKIDAR_USEPOLLING=1` in your shell before `up`.

`pnpm install` on the host is a prerequisite, not a duplicate: the containers use that dependency
tree through the mount, which is what keeps the editor and the container looking at the same
files.

#### Fill the ladder without keys

The worker can run a stub source that invents Dachis, so the ladder can be tried before any
platform application exists. Write the switches the stub needs (this overwrites `.env`) and start
the stack:

```bash
printf 'PLATFORM_CONNECTORS=stub\nALLOW_STUB_CONNECTORS=true\nSTUB_PEOPLE=500\n' > .env
docker compose -f compose.dev.yaml up --build
```

The worker invents 500 people, they appear as unattached rows on `/ladder`, and they can be wiped
with `docker compose -f compose.dev.yaml down -v`, which drops all local dev data — the whole
database, not only the invented rows.

The api and worker read `.env` when it is there and ignore it when it is not; `.env.example` lists
every name they understand, and `.env` is git-ignored.

### Validate before pushing

```bash
bash scripts/check.sh        # or: pnpm check:docker
```

This runs the same checks the branch protection requires, in containers: typecheck, lint, the
suite with coverage against a throwaway Postgres, then `helm lint` and the chart render
assertions. It tears the stack down afterwards. If it is green here, `verify` and `helm` should
be green on the pull request.

### Running the Node processes without containers

For a shell you fully control, start the database through Compose and run the processes on the
host:

```bash
docker compose up -d db
docker compose run --rm migrate

pnpm install
export DATABASE_URL=postgres://ashu:ashu@localhost:5432/ashu
export PUBLIC_BASE_URL=http://localhost:5173
export ALLOW_DEV_LOGIN=true
export COOKIE_SECURE=false

pnpm --filter @ashuworld/api dev       # :3000, tsx watch
pnpm --filter @ashuworld/web dev       # :5173, proxies /api and /auth to :3000
pnpm --filter @ashuworld/worker dev    # :9230 inspector, watches too
```

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
adapters (Twitch EventSub, Discord membership, YouTube subscription through each Dachi's own
grant), the operator tools (punishments, the audited account repair), and the bot and overlay
surfaces that read the public profile API.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Security reports: [SECURITY.md](SECURITY.md).

## Licence

[MIT](LICENSE).
