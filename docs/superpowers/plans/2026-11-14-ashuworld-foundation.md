# AshuWorld Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the part of AshuWorld that everything else attaches to: the ledger, the fan account with link/detach, sessions, and the public ladder — deployable to Kubernetes before any platform adapter exists.

**Architecture:** A pnpm monorepo of three deployables (`api`, `web`, `worker`) over shared packages. `packages/ledger` holds every XP rule as plain SQL functions against one Postgres, so the rules are testable without HTTP or a platform. Platform integrations arrive in later plans; this plan proves the pipeline with a fake provider and the outbox.

**Tech Stack:** Node.js 22, TypeScript (strict, ESM), pnpm workspaces, Fastify 5, `pg` with hand-written SQL, Vitest 3, React 19 + Vite 7 + React Router 7, Docker, Helm 3, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-11-14-ashuworld-fan-xp-design.md`

## Global Constraints

- TypeScript only, `strict: true`, ESM (`"type": "module"`), Node 22.
- Postgres is the only source of truth. No message broker: `inbound_events` plus `FOR UPDATE SKIP LOCKED`.
- A level is never lost. `peak_xp` only moves forward; `level` is derived from `peak_xp`, never from the balance.
- A one-time action credits once per provider identity, enforced by a unique index, not by application logic.
- A detach forfeits that identity's earns by setting `forfeited_at`; rows are never deleted, so spent one-time keys stay spent.
- An identity with `first_linked_at` set never appears on the free-standing ladder again.
- One fan holds at most one identity per provider; one provider identity belongs to at most one fan.
- Every secret comes from the environment or a Kubernetes Secret. Nothing secret in the repo or in an image.
- One hostname, path-routed: `/` → `web`, `/api` and `/auth` → `api`, `/hooks/*` → `worker`.
- Images are built per app and tagged with the commit SHA; migrations run as a Kubernetes `Job`.
- Configuration comes from the environment, with these names: `DATABASE_URL`, `PORT` (default 3000), `SESSION_COOKIE_NAME`, `COOKIE_SECURE`, `PUBLIC_BASE_URL`, `ALLOW_DEV_LOGIN`, `GAME_CONFIG_VERSION`, `ALPHA_RESET_CONFIRM`.
- Integration tests need a real Postgres in `TEST_DATABASE_URL`; CI provides it as a service container. No test may point at a real deployment.
- **Coverage floor: 80% lines, branches, functions and statements**, enforced by `vitest --coverage` in CI. A change that drops the workspace below the floor fails the build; there is no per-file exception.
- **Every workspace package declares `test`, `typecheck` and `build` scripts.** `pnpm -r` silently skips a package that lacks them, so a missing script is a gate that never runs rather than an error. The `test` script is exactly `vitest run --root ../.. --project @ashuworld/<name>`: a bare `vitest run` inside a package resolves the root workspace globs against the package directory, finds no projects, and exits having run nothing.
- **Every exploit path gets a test, not a comment.** Authorisation mistakes, cross-fan access, replayed events, reused handshakes, guessed session ids, leaked identifiers in public payloads and a reset that fires without confirmation each have a named negative test in the task that owns the code, and a task is not done until its negative tests fail for the right reason before the guard exists.

## Review Focus

Five failure modes this system will actually meet, each pinned by a test in the task that owns the code:

1. A replayed or duplicated platform event paying out twice → Task 4.
2. A detach or a punishment silently lowering a level → Task 5.
3. An identity showing up on the free-standing ladder after it was once linked → Task 6.
4. Two concurrent link/detach calls producing a double balance or two owners of one identity → Task 6.
5. An unverified or reused login handshake tying a fan to someone else's provider account → Task 10.
6. One fan acting on another fan's identity by changing an id in a URL → Task 11.
7. A public payload leaking provider account ids or a session cookie readable by script → Tasks 9 and 12.

The rest of the spec — Twitch, Discord, YouTube adapters, punishment UI — becomes follow-up plans (see "Follow-up plans" at the end). This plan must ship working software on its own.

## File Structure

```
package.json                  pnpm workspace root, scripts
pnpm-workspace.yaml
tsconfig.base.json
eslint.config.js
.gitignore
apps/api/                     Fastify HTTP service
  src/server.ts               buildServer(): FastifyInstance
  src/index.ts                process entry: listen
  src/config.ts               env parsing
  src/auth/session.ts         create/read/destroy session, cookie
  src/auth/handshake.ts       OAuth handshake rows, start/callback
  src/auth/providers.ts       provider registry; dev provider here
  src/routes/health.ts
  src/routes/me.ts            GET /api/me, identities list
  src/routes/link.ts          link/detach endpoints
  src/routes/public.ts        profile, ladder
  test/*.test.ts
apps/web/                     React SPA
  src/main.tsx, src/App.tsx, src/api.ts
  src/pages/{Home,Ladder,Profile,Account}.tsx
  test/*.test.tsx
apps/worker/                  event pipeline
  src/index.ts, src/loop.ts, src/processors.ts
  test/*.test.ts
packages/ledger/              the rules, plain SQL
  src/migrate.ts              migration runner
  src/db.ts                   pool, withTransaction, Queryable
  src/award.ts                awardOnce, ingestEvent
  src/standing.ts             balance, peak, level, recompute
  src/identities.ts           link, detach, first_linked_at
  src/penalty.ts              addPenalty
  src/ladder.ts               listLadder, getFan
  migrations/0001_init.sql
  test/*
packages/gameconfig/          action values and level table
  src/index.ts, src/actions.ts, src/levels.ts
  config/game.json
  test/*
packages/providers/           provider types shared by api and worker
  src/index.ts                ProviderName, IdentityProfile
deploy/helm/ashuworld/        chart: deployments, jobs, ingress
docker/{api,web,worker}.Dockerfile
.github/workflows/ci.yml
```

---

### Task 1: Monorepo skeleton

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `tsconfig.json`, `eslint.config.js`, `.gitignore`, `vitest.workspace.ts`, `vitest.config.ts`
- Create: `packages/providers/package.json`, `packages/providers/tsconfig.json`, `packages/providers/src/index.ts`
- Create: `packages/providers/test/providers.test.ts`
- Create: `.github/workflows/ci.yml`
- Note: every other package and app is created by the task that fills it (Task 2 gameconfig, 3 ledger, 8 api, 13 web, 14 worker). An empty stub cannot meet the 80% coverage floor, and the floor is not negotiable.

**Interfaces:**
- Produces: workspace package names `@ashuworld/api`, `@ashuworld/web`, `@ashuworld/worker`, `@ashuworld/ledger`, `@ashuworld/gameconfig`, `@ashuworld/providers`; root scripts `typecheck`, `lint`, `test`, `build`.
- Produces: `packages/providers` exports `type ProviderName = 'twitch' | 'youtube' | 'discord' | 'dev'` and `interface IdentityProfile { provider: ProviderName; externalId: string; displayHandle: string; displayName: string }`.

- [ ] **Step 1: Write the failing test**

`packages/providers/test/providers.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { isProviderName, type IdentityProfile } from '../src/index.js'

describe('provider types', () => {
  it('accepts the four alpha providers and rejects others', () => {
    expect(isProviderName('twitch')).toBe(true)
    expect(isProviderName('dev')).toBe(true)
    expect(isProviderName('myspace')).toBe(false)
  })

  it('keeps the identity profile shape', () => {
    const p: IdentityProfile = { provider: 'twitch', externalId: '1', displayHandle: 'ashu', displayName: 'Ashu' }
    expect(p.provider).toBe('twitch')
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter @ashuworld/providers test`
Expected: FAIL — cannot resolve `../src/index.js`.

- [ ] **Step 3: Create the workspace and the providers package**

Root `pnpm-workspace.yaml`:

```yaml
packages:
  - apps/*
  - packages/*
```

Root `package.json` scripts: `"typecheck": "pnpm -r typecheck"`, `"lint": "eslint ."`, `"test": "vitest run"`, `"test:coverage": "vitest run --coverage"`, `"build": "pnpm -r build"`. Dev deps: `typescript`, `vitest`, `@vitest/coverage-v8`, `eslint`, `typescript-eslint`, `@types/node`. Each workspace package gets `"test": "vitest run --root ../.. --project @ashuworld/<name>"`, `"typecheck": "tsc --noEmit -p tsconfig.json"` and `"build": "tsc -b"`. The `--root ../..` is not decorative: a bare `vitest run` run from inside a package resolves the root workspace globs against that package's directory, matches nothing, and exits green without testing anything.

Typechecking is per package, not one root program: the web app needs `jsx` and `DOM`, the worker needs neither, and a single program cannot serve both without every package inheriting the union of their settings. The root `tsconfig.json` carries `"files": []` and the `paths` map; it exists for editors and for the base settings, and it includes no sources.

Root `vitest.config.ts` sets `test.coverage.provider = 'v8'`, reporters `['text', 'lcov']`, and `thresholds: { lines: 80, branches: 80, functions: 80, statements: 80 }`. Exclude only `**/dist/**`, `**/test/**`, `**/*.d.ts` and `**/*.config.ts`: generated glue is excluded, behaviour is not.

Workspace dependencies: `@ashuworld/ledger` → `@ashuworld/providers`, `@ashuworld/gameconfig`, `pg`; `@ashuworld/api` → `@ashuworld/ledger`, `@ashuworld/gameconfig`, `@ashuworld/providers`, `fastify`, `@fastify/cookie`, `@fastify/static`; `@ashuworld/worker` → `@ashuworld/ledger`, `@ashuworld/providers`; `@ashuworld/web` → `react`, `react-dom`, `react-router`.

`packages/providers/src/index.ts`:

```ts
export type ProviderName = 'twitch' | 'youtube' | 'discord' | 'dev'

export interface IdentityProfile {
  provider: ProviderName
  externalId: string
  displayHandle: string
  displayName: string
}

const PROVIDERS: readonly ProviderName[] = ['twitch', 'youtube', 'discord', 'dev']

export function isProviderName(value: string): value is ProviderName {
  return (PROVIDERS as readonly string[]).includes(value)
}
```

`tsconfig.base.json`: `"target": "ES2023"`, `"module": "NodeNext"`, `"moduleResolution": "NodeNext"`, `"strict": true`, `"exactOptionalPropertyTypes": true`, `"noUncheckedIndexedAccess": true`, `"skipLibCheck": true`. `.gitignore`: `node_modules`, `dist`, `.env`, `*.tsbuildinfo`.

`.github/workflows/ci.yml`: jobs `verify` (pnpm install, `pnpm typecheck`, `pnpm lint`, `pnpm test:coverage`) on push to `develop` and on pull requests. The Postgres service container is wired in this file from the start so Task 3's tests can run there.

- [ ] **Step 4: Run the tests and the gate**

Run: `pnpm install && pnpm test && pnpm typecheck && pnpm lint`
Expected: PASS, no type errors, no lint errors.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "🔧 chore: pnpm workspace skeleton with providers package"
```

---

### Task 2: Game config — actions and level table

**Files:**
- Create: `packages/gameconfig/package.json`, `packages/gameconfig/tsconfig.json`, `packages/gameconfig/src/index.ts`, `src/actions.ts`, `src/levels.ts`, `config/game.json`
- Test: `packages/gameconfig/test/gameconfig.test.ts`

**Interfaces:**
- Produces: `interface GameConfig { version: string; actions: Record<ActionKey, ActionDef>; levels: LevelRow[] }`, `type ActionKey = string`, `interface ActionDef { amount: number; provider: ProviderName }`, `interface LevelRow { level: number; minXp: number }`.
- Produces: `loadGameConfig(raw: unknown): GameConfig` (throws `ConfigError` on invalid input), `levelForXp(cfg: GameConfig, xp: number): { level: number; nextLevelAt: number | null }`, `actionAmount(cfg: GameConfig, key: ActionKey): number`.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from 'vitest'
import { loadGameConfig, levelForXp, actionAmount, ConfigError } from '../src/index.js'

const valid = () => ({
  version: '2026-11-14.1',
  actions: { 'twitch.follow': { amount: 50, provider: 'twitch' }, 'discord.member': { amount: 75, provider: 'discord' } },
  levels: [ { level: 0, minXp: 0 }, { level: 1, minXp: 100 }, { level: 2, minXp: 300 } ],
})

describe('game config', () => {
  it('reads action amounts', () => {
    expect(actionAmount(loadGameConfig(valid()), 'twitch.follow')).toBe(50)
  })

  it('maps xp to the highest level reached', () => {
    const cfg = loadGameConfig(valid())
    expect(levelForXp(cfg, 0)).toEqual({ level: 0, nextLevelAt: 100 })
    expect(levelForXp(cfg, 100)).toEqual({ level: 1, nextLevelAt: 300 })
    expect(levelForXp(cfg, 9999)).toEqual({ level: 2, nextLevelAt: null })
  })

  it('rejects duplicate or out-of-order level rows', () => {
    expect(() => loadGameConfig({ ...valid(), levels: [ { level: 0, minXp: 0 }, { level: 1, minXp: 0 } ] })).toThrow(ConfigError)
  })

  it('rejects an unknown action key instead of paying zero', () => {
    expect(() => actionAmount(loadGameConfig(valid()), 'twitch.nope')).toThrow(ConfigError)
  })

  it('rejects a non-positive amount', () => {
    expect(() => loadGameConfig({ ...valid(), actions: { 'twitch.follow': { amount: 0, provider: 'twitch' } } })).toThrow(ConfigError)
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter @ashuworld/gameconfig test`
Expected: FAIL — `src/index.ts` does not exist.

- [ ] **Step 3: Implement**

`config/game.json` holds version `2026-11-14.1`, the two alpha actions (`twitch.follow` 50, `discord.member` 75, `youtube.subscribe` 50 — the spec's values are a gameplay pass; these are the placeholders the tests pin), and a five-row level table starting at 0/100/300/700/1500.

`loadGameConfig` validates: unique action keys, `amount` integer > 0, `provider` a known provider, `levels` non-empty, level numbers strictly increasing from 0, `minXp` strictly increasing, first row `minXp === 0`. On any violation throw `new ConfigError(message)`.

`levelForXp` picks the last row whose `minXp <= xp` and reports the next row's `minXp` or `null`.

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @ashuworld/gameconfig test && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/gameconfig && git commit -m "✨ feat: versioned game config with level table"
```

---

### Task 3: Ledger schema, migration runner, test database

**Files:**
- Create: `packages/ledger/package.json`, `packages/ledger/tsconfig.json`, `packages/ledger/migrations/0001_init.sql`, `src/migrate.ts`, `src/db.ts`, `src/index.ts`
- Test: `packages/ledger/test/schema.test.ts`, `test/helpers/db.ts`
- Create: `packages/ledger/vitest.config.ts` (reads `TEST_DATABASE_URL`)

**Interfaces:**
- Produces: `interface Queryable { query<R extends object = Record<string, unknown>>(text: string, values?: unknown[]): Promise<{ rows: R[] }> }`.
- Produces: `createPool(url: string): Pool`, `withTransaction<T>(pool: Pool, fn: (tx: Queryable) => Promise<T>): Promise<T>`.
- Produces: `migrate(pool: Pool): Promise<void>` — idempotent, takes `pg_advisory_xact_lock(hashtext('ashuworld_migrations'))`, applies `migrations/*.sql` in filename order, records names in `_migrations`.
- Produces: test helper `createTestDb(): Promise<{ pool: Pool; reset(): Promise<void> }>` that creates a throwaway schema, sets `search_path`, migrates it, and drops it.

- [ ] **Step 1: Write the failing test**

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestDb } from './helpers/db.js'
import { migrate } from '../src/migrate.js'

describe('schema', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>
  beforeAll(async () => { db = await createTestDb() })
  afterAll(async () => { await db.pool.end() })

  it('creates the tables', async () => {
    const { rows } = await db.pool.query<{ table_name: string }>(
      `select table_name from information_schema.tables where table_schema = current_schema() order by 1`,
    )
    expect(rows.map((r) => r.table_name)).toEqual(
      expect.arrayContaining(['fans', 'provider_identities', 'xp_entries', 'inbound_events', 'sessions', 'audit_log']),
    )
  })

  it('is idempotent', async () => {
    await expect(migrate(db.pool)).resolves.toBeUndefined()
    const { rows } = await db.pool.query<{ n: string }>('select count(*)::text as n from _migrations')
    expect(rows[0]?.n).toBe('1')
  })

  it('refuses an entry owned by both an identity and a fan', async () => {
    await expect(
      db.pool.query(
        `insert into xp_entries (identity_id, fan_id, provider, action_key, amount, kind, idempotency_key)
         values (gen_random_uuid(), gen_random_uuid(), 'twitch', 'twitch.follow', 50, 'earn', 'k1')`,
      ),
    ).rejects.toThrow()
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `TEST_DATABASE_URL=postgres://... pnpm --filter @ashuworld/ledger test`
Expected: FAIL — no such file `src/migrate.ts`.

- [ ] **Step 3: Write the migration and runner**

`0001_init.sql` (exact DDL, all of it):

```sql
create extension if not exists pgcrypto;

create table fans (
  id uuid primary key default gen_random_uuid(),
  handle text not null unique check (handle ~ '^[a-z0-9_]{3,24}$'),
  display_name text not null,
  peak_xp integer not null default 0 check (peak_xp >= 0),
  level integer not null default 0 check (level >= 0),
  created_at timestamptz not null default now()
);

create table provider_identities (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  external_id text not null,
  display_handle text not null,
  fan_id uuid references fans(id),
  linked_at timestamptz,
  first_linked_at timestamptz,
  created_at timestamptz not null default now(),
  unique (provider, external_id),
  unique (fan_id, provider)
);

create table xp_entries (
  id uuid primary key default gen_random_uuid(),
  identity_id uuid references provider_identities(id),
  fan_id uuid references fans(id),
  provider text not null,
  action_key text not null,
  amount integer not null,
  kind text not null check (kind in ('earn', 'penalty')),
  reason text,
  actor_fan_id uuid references fans(id),
  idempotency_key text not null unique,
  created_at timestamptz not null default now(),
  forfeited_at timestamptz,
  constraint xp_entries_one_owner check ((identity_id is null) <> (fan_id is null)),
  constraint xp_entries_penalty_has_reason check (kind <> 'penalty' or reason is not null)
);

create unique index xp_entries_one_time on xp_entries (identity_id, action_key) where kind = 'earn';
create index xp_entries_identity on xp_entries (identity_id) where forfeited_at is null;

create table inbound_events (
  id bigserial primary key,
  provider text not null,
  event_id text not null,
  payload jsonb not null,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  attempts integer not null default 0,
  unique (provider, event_id)
);

create table sessions (
  id text primary key,
  fan_id uuid not null references fans(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create table audit_log (
  id bigserial primary key,
  kind text not null,
  fan_id uuid references fans(id),
  identity_id uuid references provider_identities(id),
  actor_fan_id uuid references fans(id),
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
```

`migrate.ts` reads the directory with `readdirSync`, filters `.sql`, sorts, and for each name not in `_migrations` runs it inside `withTransaction`, then inserts the name. `_migrations` is created by the runner itself before the lock.

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @ashuworld/ledger test && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/ledger && git commit -m "✨ feat: ledger schema and migration runner"
```

---

### Task 4: Award once, ingest idempotently

**Files:**
- Create: `packages/ledger/src/award.ts`, `src/identity.ts`
- Test: `packages/ledger/test/award.test.ts`

**Interfaces:**
- Consumes: `Queryable`, `withTransaction`, `actionAmount`, `GameConfig`.
- Produces: `ensureIdentity(tx: Queryable, p: IdentityProfile): Promise<{ id: string }>` — inserts or finds by `(provider, external_id)`.
- Produces: `awardOnce(tx: Queryable, input: { identityId: string; provider: ProviderName; actionKey: string; amount: number; idempotencyKey: string; cfg: GameConfig }): Promise<{ awarded: boolean; entryId: string | null; reason: 'awarded' | 'action_spent' | 'key_seen' }>` — `reason` names why a refusal happened, because "already earned this action" and "this key was used by a different identity" are different bugs. When neither read-back finds the conflicting row, throw `AwardConflictError` rather than reporting a refusal: an unmodelled unique conflict means the schema grew a constraint the code does not know, and a silent `awarded: false` would stop paying fans with no log. On a successful award, **`awardOnce` recomputes the owning fan's standing in the same transaction** when the identity is attached; a linked fan's level must rise the moment they earn, not only when they next link, detach or are punished. An unlinked identity has no fan row yet, so there is nothing to recompute.
- Produces: `ingestEvent(pool: Pool, input: { provider: ProviderName; eventId: string; payload: unknown; handler: (tx: Queryable, payload: unknown) => Promise<void> }): Promise<'processed' | 'duplicate'>`.

- [ ] **Step 1: Write the failing tests**

```ts
it('awards a one-time action once, then refuses a second award', async () => {
  const db = await createTestDb()
  const { id: identityId } = await withTransaction(db.pool, (tx) =>
    ensureIdentity(tx, { provider: 'twitch', externalId: 't-1', displayHandle: 'ashu', displayName: 'Ashu' }),
  )
  const earn = (key: string, idem: string) => ({ identityId, provider: 'twitch' as const, actionKey: key, amount: 50, idempotencyKey: idem })
  const first = await withTransaction(db.pool, (tx) => awardOnce(tx, earn('twitch.follow', 'evt-1')))
  const second = await withTransaction(db.pool, (tx) => awardOnce(tx, earn('twitch.follow', 'evt-2')))
  expect(first.awarded).toBe(true)
  expect(second.awarded).toBe(false)
})

it('treats a replayed event id as processed once', async () => {
  const calls: string[] = []
  const handler = async () => { calls.push('ran') }
  await ingestEvent(db.pool, { provider: 'twitch', eventId: 'e1', payload: {}, handler })
  const again = await ingestEvent(db.pool, { provider: 'twitch', eventId: 'e1', payload: {}, handler })
  expect(again).toBe('duplicate')
  expect(calls).toHaveLength(1)
})

it('lets two different identities earn the same action', async () => {
  // two identities, same action key, both awarded
})

it('rolls back the award when the handler throws', async () => {
  // ingestEvent with a throwing handler leaves no xp_entries row and leaves processed_at null
})
```

- [ ] **Step 2: Run and watch it fail**

Run: `pnpm --filter @ashuworld/ledger test test/award.test.ts`
Expected: FAIL — `awardOnce` is not exported.

- [ ] **Step 3: Implement**

`awardOnce` inserts with `on conflict do nothing` against the partial index and the idempotency key, using `returning id`; an empty result means it was already there, so it selects the existing row by `(identity_id, action_key)` for earns and returns `awarded: false`. One function, one transaction, no read-then-write race.

`ingestEvent` inserts the event with `on conflict (provider, event_id) do nothing returning id`. If nothing was inserted it returns `'duplicate'`. Otherwise it calls `handler(tx, payload)` and sets `processed_at = now()` in the same transaction, so a throwing handler rolls back both the award and the processed mark.

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @ashuworld/ledger test`
Expected: PASS, including the rollback test.

- [ ] **Step 5: Commit**

```bash
git add packages/ledger && git commit -m "✨ feat: idempotent award and event ingestion"
```

---

### Task 5: Standing — balance, peak, level

**Files:**
- Create: `packages/ledger/src/standing.ts`
- Test: `packages/ledger/test/standing.test.ts`

**Interfaces:**
- Consumes: `Queryable`, `GameConfig`, `levelForXp`.
- Produces: `computeBalance(tx: Queryable, fanId: string): Promise<number>` — penalties for the fan plus non-forfeited earns of its currently attached identities.
- Produces: `recomputeStanding(tx: Queryable, fanId: string, cfg: GameConfig): Promise<{ balance: number; peakXp: number; level: number }>` — raises `peak_xp` to `max(peak_xp, balance)`, writes `level = levelForXp(peakXp).level`, and never lowers either.
- Produces: `getStanding(tx: Queryable, fanId: string): Promise<{ balance: number; peakXp: number; level: number }>`.

- [ ] **Step 1: Write the failing tests**

```ts
it('raises peak and level as xp arrives', async () => {
  // fan + identity + award 50 -> { balance: 50, peakXp: 50, level: 0 }
  // award 100 more -> balance 150, peak 150, level 1
})

it('keeps the level when a penalty lowers the balance', async () => {
  // balance 150 (peak 150, level 1), penalty -100 -> balance 50, peakXp 150, level 1
})

it('never lowers peak_xp even when called with a smaller balance', async () => {
  // force peak 500, recompute with balance 50 -> peakXp stays 500
})

it('counts only attached identities and ignores forfeited earns', async () => {
  // two identities: one attached with 50, one detached with 200 forfeited -> balance 50
})
```

- [ ] **Step 2: Run and watch it fail**

Run: `pnpm --filter @ashuworld/ledger test test/standing.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Balance, as one statement:

```sql
select coalesce(sum(e.amount), 0)::int as balance
from xp_entries e
left join provider_identities i on i.id = e.identity_id
where e.forfeited_at is null
  and (
    (e.kind = 'penalty' and e.fan_id = $1)
    or (e.kind = 'earn' and i.fan_id = $1 and i.linked_at is not null)
  )
```

`recomputeStanding` runs that, then:

```sql
update fans
set peak_xp = greatest(peak_xp, $2),
    level = $3
where id = $1
returning peak_xp, level
```

with `$3 = levelForXp(cfg, greatest(previousPeak, balance)).level`. It must read `peak_xp` inside the same transaction and use the greater of the two values for the level, so a concurrent lower balance cannot demote.

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @ashuworld/ledger test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/ledger && git commit -m "✨ feat: balance, peak and level never decrease"
```

---

### Task 6: Link, detach (forfeit), never free-standing

**Files:**
- Create: `packages/ledger/src/identities.ts`, `src/fans.ts`
- Test: `packages/ledger/test/identities.test.ts`

**Interfaces:**
- Consumes: `recomputeStanding`, `ensureIdentity`.
- Produces: `createFan(tx: Queryable, input: { handle: string; displayName: string }): Promise<{ id: string }>`.
- Produces: `linkIdentity(tx: Queryable, input: { fanId: string; identityId: string; cfg: GameConfig }): Promise<LinkResult>` where `type LinkResult = { ok: true } | { ok: false; reason: 'already_owned' | 'same_provider' }`.
- Produces: `detachIdentity(tx: Queryable, input: { fanId: string; identityId: string; cfg: GameConfig }): Promise<DetachResult>` where `type DetachResult = { ok: true; forfeitedEntries: number } | { ok: false; reason: 'not_attached' | 'last_identity' }`.
- Both functions require a transaction, and the requirement is enforced, not documented: each begins with `savepoint ledger_tx_required` / `release savepoint ledger_tx_required`. On a bare pool that pair fails immediately with "SAVEPOINT can only be used in transaction blocks"; without it, `detachIdentity` would take and release its fan lock inside one statement and two concurrent detaches could leave a fan with zero identities, which is the one state the rule forbids.

- [ ] **Step 1: Write the failing tests**

```ts
it('stamps first_linked_at and moves the identity to the fan', async () => {
  // fan A links identity -> identity.fan_id = A, linked_at set, first_linked_at set
})

it('refuses an identity already owned by another fan', async () => {
  // fan B links A's identity -> { ok: false, reason: 'already_owned' }
})

it('refuses a second identity of the same provider', async () => {
  // fan A already has twitch #1, links twitch #2 -> { ok: false, reason: 'same_provider' }
})

it('forfeits earns on detach and keeps the level', async () => {
  // identity with 150 xp, fan at level 1; detach -> balance 0, peakXp 150, level 1,
  // entries have forfeited_at set, none deleted
})

it('never puts a once-linked identity back on the free-standing ladder', async () => {
  // after detach, listLadder(...).freeStanding excludes it
})

it('refuses to detach the last identity', async () => {
  // sole identity -> { ok: false, reason: 'last_identity' }
})

it('does not pay out again when the same identity is re-linked', async () => {
  // detach then re-link -> balance stays 0; the follow key is still spent
})

it('is safe when two links of the same identity race', async () => {
  // Promise.all of two linkIdentity calls for different fans -> exactly one ok: true
})

it('records link and detach in the audit log with the acting fan', async () => {
  // two audit_log rows, kinds 'link' and 'detach', both naming actor_fan_id
})
```

- [ ] **Step 2: Run and watch it fail**

Run: `pnpm --filter @ashuworld/ledger test test/identities.test.ts`
Expected: FAIL — `linkIdentity` is not exported.

- [ ] **Step 3: Implement**

`linkIdentity` is one transaction: `select ... for update` the identity row; if `fan_id` is set and differs, return `already_owned`; if the fan already holds that provider, return `same_provider` (the unique index is the backstop, so map its violation to the same result); then `update provider_identities set fan_id = $1, linked_at = now(), first_linked_at = coalesce(first_linked_at, now())`; write an `audit_log` row (`kind = 'link'`, `fan_id`, `identity_id`, `actor_fan_id`); then `recomputeStanding`.

`detachIdentity` is one transaction: count attached identities for the fan under `for update`; if one, return `last_identity`; then `update xp_entries set forfeited_at = now() where identity_id = $1 and forfeited_at is null and kind = 'earn'`, then `update provider_identities set fan_id = null, linked_at = null where id = $1` (leaving `first_linked_at` alone); write an `audit_log` row (`kind = 'detach'`, `detail` carrying the forfeited entry count); then `recomputeStanding`.

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @ashuworld/ledger test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/ledger && git commit -m "✨ feat: link, detach with forfeit, never free-standing"
```

---

### Task 7: Penalties

**Files:**
- Create: `packages/ledger/src/penalty.ts`
- Test: `packages/ledger/test/penalty.test.ts`

**Interfaces:**
- Consumes: `recomputeStanding`.
- Produces: `addPenalty(tx: Queryable, input: { fanId: string; amount: number; reason: string; actorFanId: string; cfg: GameConfig }): Promise<{ entryId: string }>` — `amount` must be negative, `reason` non-empty, or throws `PenaltyError`.

- [ ] **Step 1: Write the failing tests**

```ts
it('lowers the balance and keeps the level', async () => {})
it('survives a detach of every identity', async () => {})
it('rejects a positive amount', async () => {})
it('rejects an empty reason', async () => {})
```

- [ ] **Step 2: Run and watch it fail**

Run: `pnpm --filter @ashuworld/ledger test test/penalty.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

Insert with `identity_id = null`, `fan_id`, `kind = 'penalty'`, `action_key = 'penalty'`, `idempotency_key = 'penalty:' + randomUUID()`, `actor_fan_id`. Then `recomputeStanding`. Validation happens before the insert with a typed error, because the DB check is the backstop and the error must be readable.

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @ashuworld/ledger test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/ledger && git commit -m "✨ feat: penalties that never cost a level"
```

---

### Task 8: API skeleton

**Files:**
- Create: `apps/api/package.json`, `apps/api/tsconfig.json`, `apps/api/src/server.ts`, `src/index.ts`, `src/config.ts`, `src/routes/health.ts`
- Test: `apps/api/test/server.test.ts`

**Interfaces:**
- Produces: `buildServer(deps: { pool: Pool; cfg: GameConfig; env: Env }): FastifyInstance`, `loadEnv(raw?: NodeJS.ProcessEnv): Env` where `interface Env { DATABASE_URL: string; SESSION_COOKIE_NAME: string; COOKIE_SECURE: boolean; ALLOW_DEV_LOGIN: boolean; PUBLIC_BASE_URL: string }`.
- Produces: error body shape `{ error: { code: string; message: string } }` for every non-2xx.

- [ ] **Step 1: Write the failing test**

```ts
it('serves health', async () => {
  const app = buildServer({ pool: db.pool, cfg, env: testEnv() })
  const res = await app.inject({ method: 'GET', url: '/api/health' })
  expect(res.statusCode).toBe(200)
  expect(res.json()).toEqual({ ok: true })
})

it('refuses to start without DATABASE_URL', () => {
  expect(() => loadEnv({})).toThrow(/DATABASE_URL/)
})

it('maps a ledger validation error to 400 and hides an unknown error', async () => {
  // a route that throws PenaltyError -> 400 with its code
  // a route that throws Error('secret detail') -> 500 { code: 'internal' }, no 'secret detail'
})
```

- [ ] **Step 2: Run and watch it fail**

Run: `pnpm --filter @ashuworld/api test`
Expected: FAIL.

- [ ] **Step 3: Implement**

Fastify 5 with `@fastify/cookie`; a `setErrorHandler` that maps `PenaltyError` and `ConfigError` to 400 with their `code`, unknown errors to 500 with `code: 'internal'` and the message withheld; `GET /api/health` returns `{ ok: true }`. `src/index.ts` builds the server and listens on `PORT` (default 3000).

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @ashuworld/api test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api && git commit -m "✨ feat: api skeleton with health and error shape"
```

---

### Task 9: Sessions and the current fan

**Files:**
- Create: `apps/api/src/auth/session.ts`, `src/routes/me.ts`
- Test: `apps/api/test/session.test.ts`

**Interfaces:**
- Produces: `createSession(tx: Queryable, fanId: string): Promise<string>` (32 random bytes, base64url, 30-day expiry), `readSession(tx: Queryable, id: string): Promise<{ fanId: string } | null>` (expired sessions read as `null`), `destroySession(tx: Queryable, id: string): Promise<void>`.
- Produces: `requireFan(request, reply): Promise<string>` — Fastify preHandler returning the fan id from the cookie or replying 401 `{ error: { code: 'unauthenticated' } }`.
- Produces: `GET /api/me` → `{ id, handle, displayName, balance, peakXp, level, identities: Array<{ id, provider, displayHandle, linked: boolean }> }`; `POST /auth/logout` → 204 and clears the cookie.

- [ ] **Step 1: Write the failing tests**

```ts
it('logs in with a session cookie and returns the fan', async () => {
  // seed fan, create session, inject with cookie -> 200, body.handle matches
})

it('rejects a request without a cookie', async () => { /* 401 unauthenticated */ })

it('treats an expired session as signed out', async () => { /* backdate expires_at -> 401 */ })

it('clears the cookie on logout', async () => { /* 204 and set-cookie with Max-Age=0 */ })

it('marks the cookie HttpOnly and SameSite=Lax so a script cannot read it', async () => {
  // inspect set-cookie: contains HttpOnly and SameSite=Lax, and no Secure when COOKIE_SECURE=false
})

it('rejects a session id that was never issued', async () => {
  // cookie with 32 random bytes -> 401
})
```

- [ ] **Step 2: Run and watch it fail**

Run: `pnpm --filter @ashuworld/api test test/session.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

Cookie: HttpOnly, `SameSite=Lax`, `Path=/`, `Secure` when `COOKIE_SECURE`, 30 days. Session id is random, stored as-is (opaque, not guessable), compared by exact match. `requireFan` reads the cookie name from `env.SESSION_COOKIE_NAME`.

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @ashuworld/api test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api && git commit -m "✨ feat: server sessions and current fan endpoint"
```

---

### Task 10: Login handshakes and the dev provider

**Files:**
- Create: `packages/ledger/migrations/0002_oauth_handshakes.sql`
- Create: `apps/api/src/auth/handshake.ts`, `src/auth/providers.ts`, `src/auth/handles.ts`, `src/routes/auth.ts`
- Test: `apps/api/test/auth.test.ts`

**Interfaces:**
- Produces: `interface OAuthProvider { name: ProviderName; authorizeUrl(input: { state: string; redirectUri: string }): string; exchange(input: { code: string; redirectUri: string }): Promise<IdentityProfile> }`.
- Produces: `startHandshake(tx, input: { provider: ProviderName; purpose: 'login' | 'link'; fanId: string | null }): Promise<{ state: string; authorizeUrl: string }>` and `consumeHandshake(tx, input: { state: string }): Promise<{ provider: ProviderName; purpose: 'login' | 'link'; fanId: string | null }>` — single use, 10-minute expiry, deleted on consume.
- Produces: `GET /auth/:provider/start?purpose=login|link` → 302 to the provider; `GET /auth/:provider/callback?code&state` → on `login`, creates or resolves the fan and sets the session cookie, then 302 to `/account`; on `link`, attaches within the same transaction, then 302 to `/account`. **Re-attach is always this `link` path**: it is the only way to prove control of a detached account, so a bare identity id must never attach anything.
- Produces: dev provider that `ALLOW_DEV_LOGIN=true` registers as `dev`; its `authorizeUrl` points straight back to the callback with `code=<handle>`.

- [ ] **Step 1: Write the failing tests**

```ts
it('rejects an unknown provider', async () => { /* /auth/myspace/start -> 400 */ })

it('logs in through the dev provider and sets a session', async () => {
  // start -> state; callback with code=ashu -> 302 /account, set-cookie present
})

it('refuses to reuse a handshake state', async () => {
  // same state twice -> second is 400 handshake_invalid
})

it('expires a handshake after ten minutes', async () => {})

it('refuses a link handshake started by another fan', async () => {})

it('creates a new fan for a never-linked identity and reuses the existing one next time', async () => {
  // callback twice with code=ashu -> one fans row, one provider_identities row
})

it('generates a state value an attacker cannot predict or reuse across providers', async () => {
  // two handshakes differ, are >= 32 chars, and a state from provider A is rejected by B's callback
})

it('asks for confirmation instead of silently re-attaching a detached identity', async () => {
  // detached identity, login again -> 302 to /account?reattach=<identityId>, no attach
})
```

- [ ] **Step 2: Run and watch it fail**

Run: `pnpm --filter @ashuworld/api test test/auth.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`0002_oauth_handshakes.sql`:

```sql
create table oauth_handshakes (
  state text primary key,
  provider text not null,
  purpose text not null check (purpose in ('login', 'link')),
  fan_id uuid references fans(id),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  constraint link_handshake_has_fan check (purpose <> 'link' or fan_id is not null)
);
```

`consumeHandshake` deletes the row with `returning`, which makes reuse impossible even under a race.

Login resolution, in order: identity attached to a fan → that fan; identity exists but detached (`first_linked_at` set) → 302 to `/account?reattach=<provider>` and stop; identity unknown → create fan (handle from `displayHandle`, lowercased, deduped with `_2`, `_3` — underscore, because `fans.handle` only allows `[a-z0-9_]`) and attach the identity, stamping `first_linked_at`.

The `link` purpose attaches whatever identity the provider returns, including one that was previously detached: the forfeit stays, because the earns are still marked. That is the re-attach path, and it is the only one — a request naming an identity id proves nothing about who controls that provider account.

Handle generation lives in `apps/api/src/auth/handles.ts` with a test for collision suffixing.

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @ashuworld/api test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api packages/ledger && git commit -m "✨ feat: single-use login handshakes and dev provider"
```

---

### Task 11: Detach and identity listing

**Files:**
- Create: `apps/api/src/routes/identities.ts`
- Test: `apps/api/test/identities.test.ts`

**Interfaces:**
- Consumes: `detachIdentity`, `getStanding`.
- Produces: `POST /api/me/identities/:identityId/detach` → 200 `{ forfeitedEntries, balance, peakXp, level }` or 409 `{ error: { code: 'last_identity' } }` or 404; `GET /api/me/identities` → `Array<{ id, provider, displayHandle, linked }>` for the caller only.
- Does **not** produce an attach endpoint: attaching and re-attaching happen only inside the provider callback (Task 10), because only the provider can prove who controls the account.

- [ ] **Step 1: Write the failing tests**

```ts
it('detaches and reports the forfeit while keeping the level', async () => {})

it('refuses to detach the only identity with 409 last_identity', async () => {})

it('rejects an unauthenticated detach', async () => { /* 401 */ })

it('returns 404 when the identity id belongs to another fan', async () => {
  // guessed uuid -> 404, and the victim's identity is still attached afterwards
})

it('lists only the caller identities, with linked state', async () => {})

it('offers no endpoint that attaches an identity by id', async () => {
  // POST /api/me/identities/:id/reattach -> 404 route not found
})
```

- [ ] **Step 2: Run and watch it fail**

Run: `pnpm --filter @ashuworld/api test test/identities.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

Both handlers run inside `withTransaction`. The detach handler scopes the selection by `fan_id = caller` so a foreign id is indistinguishable from a missing one (404, never 403 — no existence oracle). Map `last_identity` and `not_attached` to 409 with their code.

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @ashuworld/api test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api && git commit -m "✨ feat: detach and identity listing endpoints"
```

---

### Task 12: Public profile and ladder

**Files:**
- Create: `packages/ledger/src/ladder.ts`, `apps/api/src/routes/public.ts`
- Test: `packages/ledger/test/ladder.test.ts`, `apps/api/test/public.test.ts`

**Interfaces:**
- Produces: `listLadder(tx): Promise<{ linked: LadderRow[]; freeStanding: FreeStandingRow[] }>` where `interface LadderRow { fanId: string; handle: string; level: number; balance: number }` and `interface FreeStandingRow { identityId: string; provider: ProviderName; displayHandle: string; xp: number }`; `getFanByHandle(tx, handle): Promise<{ id, handle, displayName, level, balance, peakXp, identities: Array<{ provider, displayHandle }> } | null>`.
- Produces: `GET /api/public/ladder` and `GET /api/public/fans/:handle` (404 `{ error: { code: 'not_found' } }`). Both are public: no cookie, no session, and the ladder omits any identity with `first_linked_at` set.

- [ ] **Step 1: Write the failing tests**

```ts
it('ranks linked fans by current balance, not peak', async () => {})

it('lists only never-linked identities as free-standing', async () => {
  // one never-linked, one detached -> only the first appears
})

it('hides a fan who forfeited everything into the same ranking', async () => { /* balance 0, still ranked last */ })

it('serves a public profile without a session', async () => {})

it('404s an unknown handle', async () => {})

it('never exposes provider external ids, session ids or audit data publicly', async () => {
  // deep-scan both public payloads for the external id string, the session id and 'external_id'
})
```

- [ ] **Step 2: Run and watch it fail**

Run: `TEST_DATABASE_URL=... pnpm test`
Expected: FAIL.

- [ ] **Step 3: Implement**

Two queries, both with `order by ... desc, handle asc`. The free-standing one filters `i.fan_id is null and i.first_linked_at is null` and sums non-forfeited earns per identity. The profile query returns `null` for an unknown handle so the route can 404 without a special error type.

- [ ] **Step 4: Run tests**

Run: `pnpm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/ledger apps/api && git commit -m "✨ feat: public profile and ladder"
```

---

### Task 13: Web app

**Files:**
- Create: `apps/web/package.json`, `apps/web/tsconfig.json`, `apps/web/index.html`, `vite.config.ts`, `src/main.tsx`, `src/App.tsx`, `src/api.ts`, `src/pages/Home.tsx`, `src/pages/Ladder.tsx`, `src/pages/Profile.tsx`, `src/pages/Account.tsx`
- Note: the base tsconfig has `lib: ["ES2023"]` and no `jsx`. This app's own `tsconfig.json` must add `"lib": ["ES2023", "DOM", "DOM.Iterable"]`, `"jsx": "react-jsx"` and `"moduleResolution": "Bundler"`, and include its `src` and `test` (`.tsx` included). Because typechecking is per package, this file is the one that governs `apps/web`; the root program never sees it.
- Test: `apps/web/test/pages.test.tsx`

**Interfaces:**
- Consumes: the `api` routes from Tasks 9, 11 and 12.
- Produces: routes `/`, `/ladder`, `/f/:handle`, `/account`; `src/api.ts` exports `getJson<T>(path: string): Promise<T>` that throws `ApiError` with `status` and `code` from the error body.

- [ ] **Step 1: Write the failing tests**

```tsx
it('renders ladder rows from the api and splits linked from free-standing', async () => {
  vi.stubGlobal('fetch', jsonResponse({ linked: [{ fanId: '1', handle: 'ashu', level: 2, balance: 320 }], freeStanding: [] }))
  render(<Ladder />)
  expect(await screen.findByText('ashu')).toBeInTheDocument()
  expect(screen.getByText('320')).toBeInTheDocument()
})

it('shows the level badge on a profile', async () => {})

it('shows the re-attach warning when the api returns a reattach query', async () => {})

it('renders a 404 profile as not found instead of crashing', async () => {})
```

- [ ] **Step 2: Run and watch it fail**

Run: `pnpm --filter @ashuworld/web test`
Expected: FAIL.

- [ ] **Step 3: Implement**

React Router with `createBrowserRouter`; `Account` lists identities with a detach button that calls the endpoint and shows the forfeit returned; copy states plainly that detaching deletes that account's XP for good and that the level stays. Re-attaching is a fresh sign-in with that provider, so the panel links to `/auth/<provider>/start?purpose=link` and explains why. Vite dev proxy: `/api` and `/auth` to `http://localhost:3000`.

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @ashuworld/web test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web && git commit -m "✨ feat: web app with ladder, profile and account pages"
```

---

### Task 14: Worker and the outbox loop

**Files:**
- Create: `apps/worker/package.json`, `apps/worker/tsconfig.json`, `apps/worker/src/index.ts`, `src/loop.ts`, `src/processors.ts`
- Test: `apps/worker/test/loop.test.ts`

**Interfaces:**
- Consumes: `awardOnce`, `ensureIdentity`, `withTransaction`, `Queryable`.
- Produces: `type Processor = (tx: Queryable, payload: unknown) => Promise<void>`; `processOne(pool: Pool, processors: Map<ProviderName, Processor>): Promise<'processed' | 'duplicate' | 'empty'>` — claims the oldest unprocessed `inbound_events` row with `for update skip locked`, runs the processor inside the same transaction, increments `attempts` and leaves `processed_at` null when the processor throws, and sets `processed_at` when it succeeds. It must **not** go through `ingestEvent`: that function treats an existing `(provider, event_id)` as a duplicate and would skip the handler, which is exactly the retry this function exists for. `'duplicate'` is returned only when the claimed row was already processed by a concurrent worker.

- [ ] **Step 1: Write the failing tests**

```ts
it('processes an event and marks it processed', async () => {})

it('returns empty when there is nothing to do', async () => {})

it('leaves the row unprocessed when the processor throws, and retries it', async () => {
  // first call throws -> attempts = 1, processed_at null; second call with a good processor succeeds
})

it('does not process the same row twice with two concurrent workers', async () => {
  // Promise.all of two processOne calls -> one 'processed', one 'empty', one entry
})
```

- [ ] **Step 2: Run and watch it fail**

Run: `pnpm --filter @ashuworld/worker test`
Expected: FAIL.

- [ ] **Step 3: Implement**

The claim is `select * from inbound_events where processed_at is null order by id for update skip locked limit 1` inside `withTransaction`. The processor runs on the claimed row's payload in that same transaction: on success set `processed_at = now()` and commit; on throw roll back the processor's writes, then run a second small transaction that only does `update inbound_events set attempts = attempts + 1 where id = $1`, and return `'empty'` so the loop can pick the next row. After 5 attempts the row still stays unprocessed but is logged once per attempt with its id; there is no dead-letter table at alpha, and the operator sees it in the log.

`ingestEvent` is deliberately not involved here: it exists for first arrival, and it treats an existing `(provider, event_id)` as a duplicate without calling the handler.

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @ashuworld/worker test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/worker && git commit -m "✨ feat: worker outbox loop with skip-locked claiming"
```

---

### Task 15: Images and the Helm chart

**Files:**
- Create: `docker/api.Dockerfile`, `docker/web.Dockerfile`, `docker/worker.Dockerfile`
- Create: `deploy/helm/ashuworld/Chart.yaml`, `values.yaml`, `templates/{api,web,worker}.yaml`, `templates/ingress.yaml`, `templates/migrate-job.yaml`, `templates/reset-job.yaml`, `templates/secret.yaml`(reference only), `templates/_helpers.tpl`
- Modify: `.github/workflows/ci.yml` (build and push images on `develop`, `helm lint`, `helm template`)
- Test: `deploy/helm/ashuworld/test/render.sh`

**Interfaces:**
- Produces: values `image.repository`/`image.tag` per component, `ingress.host`, `ingress.className`, `postgres.secretName`, `postgres.urlKey`, `game.configVersion`, `alphaReset.enabled`.
- Produces: `helm template` rendering three Deployments, one Ingress with the three paths, a migrate `Job` with `helm.sh/hook: pre-install,pre-upgrade`, and a reset `Job` disabled unless `alphaReset.enabled=true`.

- [ ] **Step 1: Write the failing check**

`deploy/helm/ashuworld/test/render.sh`:

```bash
set -euo pipefail
out="$(helm template ashuworld . --set ingress.host=ashuworld.test)"
echo "$out" | grep -q 'kind: Deployment' || { echo "no Deployment"; exit 1; }
echo "$out" | grep -q '/hooks' || { echo "worker not routed"; exit 1; }
echo "$out" | grep -q 'helm.sh/hook: pre-install,pre-upgrade' || { echo "no migrate job"; exit 1; }
test "$(echo "$out" | grep -c 'kind: Deployment')" -eq 3 || { echo "expected 3 deployments"; exit 1; }
test "$(echo "$out" | grep -c 'runAsNonRoot: true')" -ge 3 || { echo "containers run as root"; exit 1; }
echo "$out" | grep -qi 'postgres://[^" ]*:[^" ]*@' && { echo "connection string rendered into the chart"; exit 1; }
echo ok
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bash deploy/helm/ashuworld/test/render.sh`
Expected: FAIL — no chart.

- [ ] **Step 3: Implement**

Multi-stage Dockerfiles: an `esbuild` bundle per Node app (workspace packages export TypeScript source, so the bundle is the build step — no runtime TypeScript), then a `node:22-slim` image running the bundle as uid 10001, non-root, `NODE_ENV=production`, `node dist/server.js`. The web image is a `vite build` served by `nginx:alpine`: SPA fallback (`try_files $uri /index.html`) for `/`, `/ladder`, `/f/*`, `/account`, and a proxy for `/api` and `/auth` to the api Service, so the single-origin constraint holds in-cluster and the `HttpOnly` session cookie keeps working. The SPA fallback must not shadow `/api`, `/auth` or `/hooks`. `VITE_DEV_LOGIN` is baked in at build time, so flipping it means rebuilding that image — say so in the chart's values comment. Ingress paths: `/` → web, `/api` and `/auth` → api, `/hooks` → worker. Every container gets `readOnlyRootFilesystem`, a writable `emptyDir` only where required, and resource requests.

- [ ] **Step 4: Run the checks**

Run: `bash deploy/helm/ashuworld/test/render.sh && pnpm test && pnpm typecheck`
Expected: `ok`, then all tests pass.

- [ ] **Step 5: Commit**

```bash
git add docker deploy .github && git commit -m "🔧 chore: container images and helm chart"
```

---

### Task 16: Alpha reset

**Files:**
- Create: `packages/ledger/src/reset.ts`
- Modify: `apps/worker/src/index.ts` (subcommand `reset`), `deploy/helm/ashuworld/templates/reset-job.yaml`
- Test: `packages/ledger/test/reset.test.ts`

**Interfaces:**
- Produces: `resetAlpha(pool: Pool, input: { configVersion: string }): Promise<{ deletedEntries: number; deletedIdentities: number; deletedSessions: number }>` — truncates `xp_entries`, `inbound_events`, `oauth_handshakes`, `provider_identities`, `sessions`, `audit_log`; zeroes `fans.peak_xp` and `fans.level`; keeps `fans`; refuses to run unless `ALPHA_RESET_CONFIRM` equals `reset-ashuworld`.

- [ ] **Step 1: Write the failing tests**

```ts
it('wipes xp, identities and sessions but keeps fans', async () => {})

it('zeroes peak_xp and level', async () => {})

it('refuses without the confirm environment value', async () => {
  // expect resetAlpha to throw /confirm/
})
```

- [ ] **Step 2: Run and watch it fail**

Run: `pnpm --filter @ashuworld/ledger test test/reset.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

One transaction, `truncate ... restart identity cascade` for the five tables, then the `fans` update, then a log line with the config version. The Helm template renders the Job only when `alphaReset.enabled` is true and injects the confirm value from a Secret, so the destructive step cannot be triggered by a typo.

- [ ] **Step 4: Run tests**

Run: `pnpm test && pnpm typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "✨ feat: alpha reset job"
```

---

## Follow-up plans

Each is its own plan, written after this one ships, and each leaves working software:

1. **Twitch** — EventSub receiver at `/hooks/twitch` with signature verification, follower poll fallback, `twitch.follow` processor, the real OAuth provider replacing the dev login as the primary door.
2. **Discord and YouTube** — bot membership sync, Discord OAuth; Google OAuth with the YouTube read scope, subscription check at link and on a daily poll, "cannot verify" state.
3. **Operator tools** — punishment UI, audit read view, the audited identity-move repair, Twitch EventSub subscription management.
