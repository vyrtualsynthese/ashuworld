# Local platform keys and the stub ladder — Plan 1

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A local stack fills the ladder with hundreds of fake Dachis, through the real queue and award path, with no platform keys.

**Architecture:** A `Connector` yields people; a runner turns each person into an `inbound_events` row; the worker's processor awards the one-time and monthly XP. The stub is one implementation of `Connector`. Nothing awards outside the worker.

**Tech Stack:** TypeScript, Node 22, Postgres, Fastify (untouched in this plan), pnpm workspaces, Vitest, esbuild.

**Spec:** `docs/superpowers/specs/2026-11-14-platform-keys-and-stub-design.md` (plan 1 of the five at its end).

## Global Constraints

- Node `>=22`, pnpm `10.34.9`; no new runtime or dev dependency.
- TypeScript strict; every exported function has an explicit return type where the spec gives one.
- Coverage stays at or above 80% on lines, branches, functions and statements.
- Tests that touch Postgres need `TEST_DATABASE_URL=postgres://ashu:ashu@localhost:55432/ashu` (a running `db` from `compose.dev.yaml`).
- No credential, token or key is written to the repository; `.env` stays git-ignored.
- The api and web are not modified in this plan.
- Commit messages use a Gitmoji prefix; one logical change per commit.

## Review Focus

- The same person discovered twice in one month must not be paid twice.
- A person who detached must not earn again, but their handle must still refresh.
- `STUB_PEOPLE` at 1, 5000, 0, 5001 and `"abc"` must behave exactly as specified, not silently become 0.
- A connector that throws mid-run must not stop the other connectors or the worker.
- An `inbound_events` row whose payload is not a discovery payload must fail the attempt and award nothing.

---

### Task 1: `enqueueEvent` in the ledger

**Files:**
- Modify: `packages/ledger/src/award.ts`
- Modify: `packages/ledger/src/index.ts`
- Test: `packages/ledger/test/award.test.ts`

**Interfaces:**
- Consumes: `ProviderName` from `@ashuworld/providers`, `Pool` from `pg`.
- Produces: `enqueueEvent(pool, input): Promise<'queued' | 'duplicate'>`, with `EnqueueEventInput { provider; eventId; payload }`, exported from `@ashuworld/ledger`.

- [ ] **Step 1: Write the failing test**

Append to `packages/ledger/test/award.test.ts`:

```ts
describe('enqueueEvent', () => {
  it('queues an event and leaves it unprocessed', async () => {
    expect(
      await enqueueEvent(db.pool, {
        provider: 'twitch',
        eventId: 'sync:twitch:t-1:twitch.follow:2026-11',
        payload: { kind: 'discovery', provider: 'twitch' },
      }),
    ).toBe('queued')

    const { rows } = await db.pool.query(
      `select payload, processed_at, attempts from inbound_events where event_id = $1`,
      ['sync:twitch:t-1:twitch.follow:2026-11'],
    )
    expect(rows[0]?.processed_at).toBeNull()
    expect(rows[0]?.attempts).toBe(0)
    expect(rows[0]?.payload).toEqual({ kind: 'discovery', provider: 'twitch' })
  })

  it('reports a duplicate without touching the stored row', async () => {
    const input = { provider: 'twitch' as const, eventId: 'e-dupe', payload: { n: 1 } }
    expect(await enqueueEvent(db.pool, input)).toBe('queued')
    expect(await enqueueEvent(db.pool, { ...input, payload: { n: 2 } })).toBe('duplicate')

    const { rows } = await db.pool.query(`select payload from inbound_events where event_id = 'e-dupe'`)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.payload).toEqual({ n: 1 })
  })
})
```

Add `enqueueEvent` to the existing import list at the top of the file.

- [ ] **Step 2: Run the test to verify it fails**

Run: `TEST_DATABASE_URL=postgres://ashu:ashu@localhost:55432/ashu pnpm exec vitest run --project @ashuworld/ledger packages/ledger/test/award.test.ts`
Expected: FAIL — `enqueueEvent` is not exported.

- [ ] **Step 3: Implement it in `packages/ledger/src/award.ts`**

```ts
export interface EnqueueEventInput {
  provider: ProviderName
  eventId: string
  payload: unknown
}

/** `queued` only for the call that inserted the row; `duplicate` for a redelivered event. */
export type EnqueueOutcome = 'queued' | 'duplicate'

/**
 * Writes one connector event for the worker to pick up.
 *
 * Insert only: it must not run a handler, because the api and the connectors have no
 * business opening the award transaction. `on conflict do nothing ... returning` is what
 * distinguishes a first delivery from a redelivery in one statement, without a read that
 * a concurrent writer could invalidate.
 */
export async function enqueueEvent(pool: Pool, input: EnqueueEventInput): Promise<EnqueueOutcome> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into inbound_events (provider, event_id, payload)
     values ($1, $2, $3)
     on conflict (provider, event_id) do nothing
     returning id`,
    [input.provider, input.eventId, JSON.stringify(input.payload ?? null)],
  )
  return rows[0] === undefined ? 'duplicate' : 'queued'
}
```

- [ ] **Step 4: Export it from `packages/ledger/src/index.ts`**

Add `enqueueEvent`, `type EnqueueEventInput`, `type EnqueueOutcome` to the existing `./award.js` export block.

- [ ] **Step 5: Run the test to verify it passes**

Run: `TEST_DATABASE_URL=postgres://ashu:ashu@localhost:55432/ashu pnpm exec vitest run --project @ashuworld/ledger packages/ledger/test/award.test.ts`
Expected: PASS, including the two new tests.

- [ ] **Step 6: Commit**

```bash
git add packages/ledger/src/award.ts packages/ledger/src/index.ts packages/ledger/test/award.test.ts
git commit -m "✨ feat(ledger): queue connector events without awarding them"
```

---

### Task 2: The discovery payload, shared by api and worker

**Files:**
- Create: `packages/providers/src/names.ts`
- Modify: `packages/providers/src/index.ts`
- Create: `packages/providers/src/discovery.ts`
- Test: `packages/providers/test/discovery.test.ts`

**Interfaces:**
- Consumes: `ProviderName`, `isProviderName` from `./index.js`.
- Produces: `DiscoveredPerson`, `DiscoveryPayload`, `parseDiscoveryPayload(value): DiscoveryPayload`, `discoveryEventId(source, person, month): string`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest'
import {
  discoveryEventId,
  parseDiscoveryPayload,
  type DiscoveryPayload,
} from '../src/discovery.js'

const person = {
  provider: 'twitch' as const,
  externalId: 't-1',
  displayHandle: 'ashu',
  displayName: 'Ashu',
  actions: ['twitch.follow'],
}

describe('parseDiscoveryPayload', () => {
  it('accepts a well-formed discovery payload', () => {
    expect(parseDiscoveryPayload({ kind: 'discovery', ...person })).toEqual({
      kind: 'discovery',
      ...person,
    })
  })

  it.each([
    ['not an object', 'nope'],
    ['wrong kind', { ...person, kind: 'follow' }],
    ['unknown provider', { kind: 'discovery', ...person, provider: 'myspace' }],
    ['empty handle', { kind: 'discovery', ...person, displayHandle: '' }],
    ['no actions', { kind: 'discovery', ...person, actions: [] }],
    ['non-string action', { kind: 'discovery', ...person, actions: [1] }],
  ])('refuses %s', (_label, value) => {
    expect(() => parseDiscoveryPayload(value)).toThrow()
  })
})

describe('discoveryEventId', () => {
  it('is stable for one person, source and month', () => {
    const id = discoveryEventId('sync', person, '2026-11')
    expect(id).toBe('sync:twitch:t-1:twitch.follow:2026-11')
    expect(discoveryEventId('sync', person, '2026-11')).toBe(id)
  })

  it('separates sign-in from discovery and one month from the next', () => {
    expect(discoveryEventId('signin', person, '2026-11')).not.toBe(
      discoveryEventId('sync', person, '2026-11'),
    )
    expect(discoveryEventId('sync', person, '2026-12')).not.toBe(
      discoveryEventId('sync', person, '2026-11'),
    )
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm exec vitest run --project @ashuworld/providers packages/providers/test/discovery.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `packages/providers/src/discovery.ts`**

```ts
import { isProviderName, type ProviderName } from './names.js'

export interface DiscoveredPerson {
  provider: ProviderName
  externalId: string
  displayHandle: string
  displayName: string
  actions: string[]
}

export interface DiscoveryPayload extends DiscoveredPerson {
  kind: 'discovery'
}

export type DiscoverySource = 'sync' | 'signin'

function field(value: Record<string, unknown>, key: string): string {
  const raw = value[key]
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new Error(`discovery payload: "${key}" must be a non-empty string`)
  }
  return raw
}

/** Parses the queue payload, so a malformed event fails the attempt instead of awarding. */
export function parseDiscoveryPayload(value: unknown): DiscoveryPayload {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('discovery payload: expected an object')
  }
  const record = value as Record<string, unknown>
  if (record['kind'] !== 'discovery') {
    throw new Error('discovery payload: "kind" must be "discovery"')
  }
  const provider = field(record, 'provider')
  if (!isProviderName(provider)) {
    throw new Error(`discovery payload: unknown provider ${JSON.stringify(provider)}`)
  }
  const actions = record['actions']
  if (!Array.isArray(actions) || actions.length === 0) {
    throw new Error('discovery payload: "actions" must be a non-empty array')
  }
  return {
    kind: 'discovery',
    provider,
    externalId: field(record, 'externalId'),
    displayHandle: field(record, 'displayHandle'),
    displayName: field(record, 'displayName'),
    actions: actions.map((action) => {
      if (typeof action !== 'string' || action === '') {
        throw new Error('discovery payload: every action must be a non-empty string')
      }
      return action
    }),
  }
}

/**
 * The queue key for one fact about one person in one month. The month is part of it
 * because the fact is re-affirmed every month; `+` joins several actions so one event
 * still pays them together.
 */
export function discoveryEventId(
  source: DiscoverySource,
  person: Pick<DiscoveredPerson, 'provider' | 'externalId' | 'actions'>,
  month: string,
): string {
  return `${source}:${person.provider}:${person.externalId}:${person.actions.join('+')}:${month}`
}
```

- [ ] **Step 4: Split the names and export the new module**

Move `ProviderName`, `PROVIDERS`, `isProviderName` and `IdentityProfile` into `packages/providers/src/names.ts` unchanged, and make `index.ts` re-export them (`export * from './names.js'`) plus `export * from './discovery.js'`. `discovery.ts` imports from `./names.js`, so there is no cycle and the public API of the package is unchanged.

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm exec vitest run --project @ashuworld/providers`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/providers/src packages/providers/test/discovery.test.ts
git commit -m "✨ feat(providers): share the discovery payload and its event id"
```

---

### Task 3: The worker's environment

**Files:**
- Create: `apps/worker/src/config.ts`
- Test: `apps/worker/test/config.test.ts`

**Interfaces:**
- Produces: `WorkerEnv { DATABASE_URL; PLATFORM_CONNECTORS: ConnectorName[]; ALLOW_STUB_CONNECTORS; STUB_PEOPLE; SYNC_INTERVAL_SECONDS }`, `ConnectorName = 'stub'`, `loadWorkerEnv(raw?): WorkerEnv`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest'
import { loadWorkerEnv } from '../src/config.js'

const base = { DATABASE_URL: 'postgres://x' }

describe('loadWorkerEnv', () => {
  it('defaults to no discovery and 250 people if ever enabled', () => {
    expect(loadWorkerEnv(base)).toEqual({
      DATABASE_URL: 'postgres://x',
      PLATFORM_CONNECTORS: [],
      ALLOW_STUB_CONNECTORS: false,
      STUB_PEOPLE: 250,
      SYNC_INTERVAL_SECONDS: 900,
    })
  })

  it('enables the stub only with both switches', () => {
    expect(
      loadWorkerEnv({ ...base, PLATFORM_CONNECTORS: 'stub', ALLOW_STUB_CONNECTORS: 'true' })
        .PLATFORM_CONNECTORS,
    ).toEqual(['stub'])
  })

  it('refuses the stub connector without its allow switch', () => {
    expect(() => loadWorkerEnv({ ...base, PLATFORM_CONNECTORS: 'stub' })).toThrow(
      /ALLOW_STUB_CONNECTORS/,
    )
  })

  it('refuses the allow switch without the stub connector', () => {
    expect(() => loadWorkerEnv({ ...base, ALLOW_STUB_CONNECTORS: 'true' })).toThrow(
      /PLATFORM_CONNECTORS/,
    )
  })

  it.each(['0', '5001', 'abc', '2.5'])('refuses STUB_PEOPLE=%s', (value) => {
    expect(() =>
      loadWorkerEnv({
        ...base,
        PLATFORM_CONNECTORS: 'stub',
        ALLOW_STUB_CONNECTORS: 'true',
        STUB_PEOPLE: value,
      }),
    ).toThrow(/STUB_PEOPLE/)
  })

  it('accepts the boundaries', () => {
    const load = (people: string) =>
      loadWorkerEnv({
        ...base,
        PLATFORM_CONNECTORS: 'stub',
        ALLOW_STUB_CONNECTORS: 'true',
        STUB_PEOPLE: people,
      }).STUB_PEOPLE
    expect(load('1')).toBe(1)
    expect(load('5000')).toBe(5000)
  })

  it('refuses an unknown connector, a bad interval and a missing database url', () => {
    expect(() => loadWorkerEnv({ ...base, PLATFORM_CONNECTORS: 'twitch' })).toThrow(
      /PLATFORM_CONNECTORS/,
    )
    expect(() => loadWorkerEnv({ ...base, SYNC_INTERVAL_SECONDS: '0' })).toThrow(
      /SYNC_INTERVAL_SECONDS/,
    )
    expect(() => loadWorkerEnv({})).toThrow(/DATABASE_URL/)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm exec vitest run --project @ashuworld/worker apps/worker/test/config.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `apps/worker/src/config.ts`**

```ts
export type ConnectorName = 'stub'

export interface WorkerEnv {
  DATABASE_URL: string
  PLATFORM_CONNECTORS: ConnectorName[]
  ALLOW_STUB_CONNECTORS: boolean
  STUB_PEOPLE: number
  SYNC_INTERVAL_SECONDS: number
}

const CONNECTOR_NAMES: readonly ConnectorName[] = ['stub']
const DEFAULT_STUB_PEOPLE = 250
const MAX_STUB_PEOPLE = 5000
const DEFAULT_SYNC_INTERVAL_SECONDS = 900

function required(raw: NodeJS.ProcessEnv, name: string): string { /* trim or throw naming it */ }
function flag(raw: NodeJS.ProcessEnv, name: string): boolean { /* "true"|"false"|absent=false, else throw */ }
function integer(raw, name, fallback, min, max): number { /* integer in range or throw */ }
function connectors(raw): ConnectorName[] { /* split ",", trim, drop empties, dedupe, validate */ }

export function loadWorkerEnv(raw: NodeJS.ProcessEnv = process.env): WorkerEnv {
  const connectors = connectors(raw)
  const allowStub = flag(raw, 'ALLOW_STUB_CONNECTORS')
  const hasStub = connectors.includes('stub')
  if (hasStub && !allowStub) throw new Error('PLATFORM_CONNECTORS names "stub" but ALLOW_STUB_CONNECTORS is not "true"')
  if (allowStub && !hasStub) throw new Error('ALLOW_STUB_CONNECTORS is "true" but PLATFORM_CONNECTORS does not name "stub"')
  return {
    DATABASE_URL: required(raw, 'DATABASE_URL'),
    PLATFORM_CONNECTORS: connectors,
    ALLOW_STUB_CONNECTORS: allowStub,
    STUB_PEOPLE: integer(raw, 'STUB_PEOPLE', DEFAULT_STUB_PEOPLE, 1, MAX_STUB_PEOPLE),
    SYNC_INTERVAL_SECONDS: integer(raw, 'SYNC_INTERVAL_SECONDS', DEFAULT_SYNC_INTERVAL_SECONDS, 1, 31_536_000),
  }
}
```

Use the api's `config.ts` error wording style: the message names the variable and the value.

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm exec vitest run --project @ashuworld/worker apps/worker/test/config.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/config.ts apps/worker/test/config.test.ts
git commit -m "✨ feat(worker): read and validate the discovery environment"
```

---

### Task 4: The connector seam and the stub

**Files:**
- Create: `apps/worker/src/connectors/types.ts`
- Create: `apps/worker/src/connectors/stub.ts`
- Create: `apps/worker/test/connectors.test.ts`
- Modify: `apps/worker/src/config.ts` only if the type import needs it (no)

**Interfaces:**
- Consumes: `ConnectorName` from `../config.js`, `DiscoveredPerson` from `@ashuworld/providers`.
- Produces: `Connector { name: ConnectorName; discover(): AsyncIterable<DiscoveredPerson> }`, `createStubConnector(people: number): Connector`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest'
import { createStubConnector } from '../src/connectors/stub.js'

async function collect(people: number) {
  const out = []
  for await (const person of createStubConnector(people).discover()) out.push(person)
  return out
}

describe('createStubConnector', () => {
  it('yields exactly the requested number of people', async () => {
    expect(await collect(7)).toHaveLength(7)
    expect(await collect(1)).toHaveLength(1)
  })

  it('is deterministic', async () => {
    expect(await collect(10)).toEqual(await collect(10))
  })

  it('splits 60% Twitch and 40% Discord rounds down', async () => {
    const people = await collect(10)
    expect(people.filter((p) => p.provider === 'twitch')).toHaveLength(6)
    expect(people.filter((p) => p.provider === 'discord')).toHaveLength(4)
    expect(people[0]?.actions).toEqual(['twitch.follow'])
    expect(people[9]?.actions).toEqual(['discord.member'])
  })

  it('keeps external ids unique and prefixed', async () => {
    const people = await collect(50)
    expect(new Set(people.map((p) => p.externalId)).size).toBe(50)
    expect(people.every((p) => p.externalId.startsWith('stub-'))).toBe(true)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm exec vitest run --project @ashuworld/worker apps/worker/test/connectors.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the two files**

`types.ts`:

```ts
import type { DiscoveredPerson } from '@ashuworld/providers'
import type { ConnectorName } from '../config.js'

/** A source the operator can enumerate. The stub is the first; Twitch and Discord follow. */
export interface Connector {
  name: ConnectorName
  discover(): AsyncIterable<DiscoveredPerson>
}
```

`stub.ts`:

```ts
import type { DiscoveredPerson } from '@ashuworld/providers'
import type { Connector } from './types.js'

const TWITCH_EVERY_FIVE = 3  // 3 of every 5 people are Twitch: 60%

export function createStubConnector(people: number): Connector {
  return {
    name: 'stub',
    async *discover() {
      for (let index = 0; index < people; index += 1) {
        const number = String(index + 1).padStart(4, '0')
        const provider = index % 5 < TWITCH_EVERY_FIVE ? 'twitch' : 'discord'
        const suffix = provider === 'twitch' ? 'tv' : 'dc'
        yield {
          provider,
          externalId: `stub-${number}-${suffix}`,
          displayHandle: `stub${number}`,
          displayName: `Stub Dachi ${number}`,
          actions: [provider === 'twitch' ? 'twitch.follow' : 'discord.member'],
        } satisfies DiscoveredPerson
      }
    },
  }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm exec vitest run --project @ashuworld/worker apps/worker/test/connectors.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/connectors apps/worker/test/connectors.test.ts
git commit -m "✨ feat(worker): add the connector seam and the stub source"
```

---

### Task 5: The discovery processor

**Files:**
- Modify: `apps/worker/src/processors.ts`
- Test: `apps/worker/test/processors.test.ts`

**Interfaces:**
- Consumes: `parseDiscoveryPayload`, `DiscoveryPayload` from `@ashuworld/providers`; `ensureIdentity`, `awardOnce`, `awardMonthly`, `monthKey` from `@ashuworld/ledger`; `GameConfig` from `@ashuworld/gameconfig`; `Processor`, `ProcessorMap` from `./processors.js`.
- Produces: `createDiscoveryProcessor(cfg, now?): Processor`, `createProcessors(cfg): ProcessorMap` (Twitch and Discord).

- [ ] **Step 1: Write the failing test**

Use the `createTestDb` pattern from `apps/worker/test/loop.test.ts`. Load the real config with `loadGameConfigFile` from the repository path. The tests:

```ts
it('awards the one-time action and the current month for a new identity', async () => {
  const processor = createDiscoveryProcessor(cfg, () => new Date('2026-11-14T12:00:00Z'))
  await withTransaction(pool, (tx) => processor(tx, payload))

  const entries = await entriesFor('twitch', 't-1')
  expect(entries.map((e) => [e.action_key, e.amount])).toEqual([
    ['twitch.follow', 50],
    ['twitch.follow@2026-11', 5],
  ])
  const identity = await identityRow('twitch', 't-1')
  expect(identity.fan_id).toBeNull()
  expect(identity.first_linked_at).toBeNull()
  expect(identity.display_handle).toBe('ashu')
})

it('does not pay twice when the same event is processed again', async () => {
  const processor = createDiscoveryProcessor(cfg, () => new Date('2026-11-14T12:00:00Z'))
  await withTransaction(pool, (tx) => processor(tx, payload))
  await withTransaction(pool, (tx) => processor(tx, { ...payload, displayHandle: 'renamed' }))
  expect(await entriesFor('twitch', 't-1')).toHaveLength(2)
  expect((await identityRow('twitch', 't-1')).display_handle).toBe('renamed')
})

it('pays nothing to a detached identity', async () => {
  await pool.query(
    `insert into provider_identities (provider, external_id, display_handle, first_linked_at)
     values ('twitch', 't-detached', 'old', now())`,
  )
  const processor = createDiscoveryProcessor(cfg, () => new Date('2026-11-14T12:00:00Z'))
  await withTransaction(pool, (tx) => processor(tx, { ...payload, externalId: 't-detached', displayHandle: 'new' }))

  expect(await entriesFor('twitch', 't-detached')).toHaveLength(0)
  expect((await identityRow('twitch', 't-detached')).display_handle).toBe('new')
})

it('fails loudly on an action the game config does not define', async () => {
  const processor = createDiscoveryProcessor(cfg)
  await expect(
    withTransaction(pool, (tx) => processor(tx, { ...payload, actions: ['twitch.nope'] })),
  ).rejects.toThrow(/twitch\.nope/)
})
```

Helpers `entriesFor(provider, externalId)` (join `xp_entries` through `provider_identities`, ordered by `xp_entries.id`) and `identityRow(provider, externalId)` are small local queries; write them in the test file.

- [ ] **Step 2: Run it to verify it fails**

Run: `TEST_DATABASE_URL=postgres://ashu:ashu@localhost:55432/ashu pnpm exec vitest run --project @ashuworld/worker apps/worker/test/processors.test.ts`
Expected: FAIL — `createDiscoveryProcessor` is not exported.

- [ ] **Step 3: Implement in `apps/worker/src/processors.ts`**

```ts
export function createDiscoveryProcessor(
  cfg: GameConfig,
  now: () => Date = () => new Date(),
): Processor {
  return async (tx, raw) => {
    const payload = parseDiscoveryPayload(raw)
    const { id: identityId } = await ensureIdentity(tx, {
      provider: payload.provider,
      externalId: payload.externalId,
      displayHandle: payload.displayHandle,
      displayName: payload.displayName,
    })

    const { rows } = await tx.query<{ fan_id: string | null; first_linked_at: Date | null }>(
      `select fan_id, first_linked_at from provider_identities where id = $1`,
      [identityId],
    )
    const identity = rows[0]
    if (identity === undefined) throw new Error(`discovery: identity ${identityId} vanished`)
    if (identity.fan_id === null && identity.first_linked_at !== null) return

    for (const actionKey of payload.actions) {
      const action = cfg.actions[actionKey]
      if (action === undefined) {
        throw new Error(`discovery: game config has no action "${actionKey}"`)
      }
      await awardOnce(tx, {
        identityId,
        provider: payload.provider,
        actionKey,
        amount: action.amount,
        idempotencyKey: `discovery:${payload.provider}:${payload.externalId}:${actionKey}`,
        cfg,
      })
      await awardMonthly(tx, {
        identityId,
        provider: payload.provider,
        baseActionKey: actionKey,
        month: monthKey(now()),
        cfg,
      })
    }
  }
}

export function createProcessors(cfg: GameConfig): ProcessorMap {
  const discovery = createDiscoveryProcessor(cfg)
  return new Map<ProviderName, Processor>([
    ['twitch', discovery],
    ['discord', discovery],
  ])
}
```

`ensureIdentity` takes an `IdentityProfile`; the payload has the four fields plus `actions` and `kind`, so pass an object with only the four fields (extra fields are fine structurally in TS, but `kind`/`actions` would be accepted too — pass the explicit four to keep the contract clear).

- [ ] **Step 4: Run it to verify it passes**

Run: `TEST_DATABASE_URL=postgres://ashu:ashu@localhost:55432/ashu pnpm exec vitest run --project @ashuworld/worker apps/worker/test/processors.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/processors.ts apps/worker/test/processors.test.ts
git commit -m "✨ feat(worker): award discovered people through the queue"
```

---

### Task 6: The discovery runner

**Files:**
- Create: `apps/worker/src/discovery.ts`
- Test: `apps/worker/test/discovery.test.ts`

**Interfaces:**
- Consumes: `Connector` from `./connectors/types.js`, `DiscoveredPerson` from `@ashuworld/providers`.
- Produces: `runDiscovery(options): Promise<void>` with `{ connectors; enqueue; intervalMs; signal?; wait? }`.

- [ ] **Step 1: Write the failing test**

```ts
it('enqueues every person from every connector, then waits and runs again', async () => {
  const seen: string[] = []
  let rounds = 0
  const controller = new AbortController()
  await runDiscovery({
    connectors: [connector('a', ['x', 'y']), connector('b', ['z'])],
    enqueue: async (person) => seen.push(person.externalId),
    intervalMs: 5,
    signal: controller.signal,
    wait: async (_ms, signal) => {
      rounds += 1
      if (rounds === 2) signal?.abort()
    },
  })
  expect(seen).toEqual(['x', 'y', 'z', 'x', 'y', 'z'])
})

it('keeps the other connectors running when one throws', async () => {
  const seen: string[] = []
  const controller = new AbortController()
  await runDiscovery({
    connectors: [brokenConnector(), connector('b', ['z'])],
    enqueue: async (person) => seen.push(person.externalId),
    intervalMs: 5,
    signal: controller.signal,
    wait: async () => controller.abort(),
  })
  expect(seen).toEqual(['z'])
})

it('stops without enqueuing when the signal is already aborted', async () => {
  const seen: string[] = []
  await runDiscovery({ connectors: [connector('a', ['x'])], enqueue: async (p) => seen.push(p.externalId), intervalMs: 5, signal: AbortSignal.abort() })
  expect(seen).toEqual([])
})
```

`connector(name, ids)` and `brokenConnector()` are local helpers returning the `Connector` shape.

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm exec vitest run --project @ashuworld/worker apps/worker/test/discovery.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `apps/worker/src/discovery.ts`**

```ts
export interface DiscoveryRunnerOptions {
  connectors: Connector[]
  enqueue: (person: DiscoveredPerson) => Promise<void>
  intervalMs: number
  signal?: AbortSignal
  wait?: (ms: number, signal?: AbortSignal) => Promise<void>
}

export async function runDiscovery(options: DiscoveryRunnerOptions): Promise<void> { /* see below */ }
```

Behaviour: return immediately when `connectors.length === 0`; loop while not aborted, running each connector in order and awaiting `enqueue` for each person; catch a connector's error, `console.error` it with the connector name, and continue with the next; wait `intervalMs` between rounds. Default `wait` is the same promise-with-signal helper the drain loop uses (write a small local one; do not export it from `loop.ts`).

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm exec vitest run --project @ashuworld/worker apps/worker/test/discovery.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/discovery.ts apps/worker/test/discovery.test.ts
git commit -m "✨ feat(worker): run discovery connectors on an interval"
```

---

### Task 7: Wire the worker

**Files:**
- Create: `apps/worker/src/gameConfig.ts`
- Create: `apps/worker/src/connectors/index.ts`
- Modify: `apps/worker/src/cli.ts`
- Modify: `apps/worker/src/index.ts`
- Test: `apps/worker/test/cli.test.ts` (existing suite must stay green)

**Interfaces:**
- Consumes: `loadWorkerEnv`, `WorkerEnv` from `./config.js`; `createStubConnector`; `createProcessors`; `enqueueEvent`; `discoveryEventId`, `monthKey`.
- Produces: `GAME_CONFIG_PATH`, `loadWorkerGameConfig()`, `createConnectors(env): Connector[]`, `CliDeps.connectors?: Connector[]`.

- [ ] **Step 1: Move the game-config path into `apps/worker/src/gameConfig.ts`**

`GAME_CONFIG_PATH` (same `fileURLToPath` five-line comment) and `loadWorkerGameConfig(): GameConfig`. `cli.ts` imports them and deletes its local constants.

- [ ] **Step 2: Add `createConnectors`**

```ts
export function createConnectors(env: WorkerEnv): Connector[] {
  return env.PLATFORM_CONNECTORS.includes('stub') ? [createStubConnector(env.STUB_PEOPLE)] : []
}
```

- [ ] **Step 3: Run discovery alongside the drain loop in `cli.ts`**

`CliDeps` gains `connectors?: Connector[]` (default `[]`) and `syncIntervalMs?: number` (default `900_000`). In the no-argument branch, when the list is non-empty, build the enqueue function and run both loops under one signal:

```ts
const signalOptions = deps.signal === undefined ? {} : { signal: deps.signal }
const enqueue = async (person: DiscoveredPerson): Promise<void> => {
  const month = monthKey(new Date())
  await enqueueEvent(deps.pool, {
    provider: person.provider,
    eventId: discoveryEventId('sync', person, month),
    payload: { kind: 'discovery', ...person },
  })
}

await Promise.all([
  runLoop(deps.pool, deps.processors, signalOptions),
  runDiscovery({
    connectors,
    enqueue,
    intervalMs: deps.syncIntervalMs ?? 900_000,
    signal: deps.signal,
  }),
])
```

An empty connector list keeps today's behaviour exactly: `runCli` awaits `runLoop` alone.

- [ ] **Step 4: Rewire `apps/worker/src/index.ts`**

```ts
const env = loadWorkerEnv()
const cfg = loadWorkerGameConfig()
const pool = createPool(env.DATABASE_URL)
const processors = createProcessors(cfg)
const connectors = createConnectors(env)
// log which connectors are on, and the stub warning when it is
code = await runCli(argv, { pool, processors, connectors, signal: controller.signal })
```

Delete `loadDatabaseUrl`; the config module owns it. Keep the signal/pool shutdown exactly as it is.

- [ ] **Step 5: Run the worker suite**

Run: `TEST_DATABASE_URL=postgres://ashu:ashu@localhost:55432/ashu pnpm exec vitest run --project @ashuworld/worker`
Expected: PASS, including the existing CLI tests.

- [ ] **Step 6: Commit**

```bash
git add apps/worker/src
git commit -m "✨ feat(worker): run the stub discovery source in the worker"
```

---

### Task 8: Local plumbing and the zero-key demo

**Files:**
- Create: `.env.example`
- Modify: `compose.dev.yaml`
- Modify: `README.md`

- [ ] **Step 1: Write `.env.example`**

Plan 1's names only, values empty, one comment line each: `DATABASE_URL`, `PLATFORM_CONNECTORS`, `ALLOW_STUB_CONNECTORS`, `STUB_PEOPLE`, `SYNC_INTERVAL_SECONDS`. Add a closing comment saying plans 2–5 add the platform credentials to this file.

- [ ] **Step 2: Mount it into the dev stack**

Add to both `api` and `worker` in `compose.dev.yaml`:

```yaml
    env_file:
      - path: .env
        required: false
```

- [ ] **Step 3: Document the zero-key demo in `README.md`**

Under the development stack section, a short "Fill the ladder without keys" block:

```bash
printf 'PLATFORM_CONNECTORS=stub\nALLOW_STUB_CONNECTORS=true\nSTUB_PEOPLE=500\n' > .env
docker compose -f compose.dev.yaml up --build
```

and one sentence: the worker invents 500 people, they appear as unattached rows on `/ladder`, and they can be wiped with `docker compose -f compose.dev.yaml down -v`.

- [ ] **Step 4: Verify the stack config parses**

Run: `docker compose -f compose.dev.yaml config --quiet`
Expected: exit 0 (a missing `.env` must not fail it).

- [ ] **Step 5: Commit**

```bash
git add .env.example compose.dev.yaml README.md
git commit -m "📝 docs: run the local ladder on the stub source"
```

---

### Task 9: Verification gate

- [ ] **Step 1: Typecheck and lint**

Run: `pnpm typecheck && pnpm lint`
Expected: zero errors.

- [ ] **Step 2: Run the full suite with the coverage gate**

Run: `TEST_DATABASE_URL=postgres://ashu:ashu@localhost:55432/ashu pnpm test:coverage`
Expected: every project green; lines, branches, functions and statements each at or above 80%.

- [ ] **Step 3: Fix any gap the gate exposes**

Add the missing test in the owning task's file and rerun the gate. Do not lower a threshold.

- [ ] **Step 4: Commit any test added in Step 3**

```bash
git add -A
git commit -m "✅ test: cover the discovery path to the coverage gate"
```

---

## Plan self-review

- Spec coverage for plan 1: env parsing (Task 3), `enqueueEvent` (Task 1), processors and the detached guard (Task 5), connector seam and stub (Tasks 4 and 6), local `.env` and compose (Task 8), tests and coverage (Tasks 1–9). Credentials, sign-in, the web buttons and the YouTube grant belong to plans 2–5 and are deliberately absent.
- Names and types match across tasks: `ConnectorName`, `DiscoveredPerson`, `DiscoveryPayload`, `discoveryEventId`, `createDiscoveryProcessor`, `createProcessors`, `createConnectors`, `runDiscovery`.
- Every Review Focus line has a test: double payment (Task 5), detached (Task 5), stub boundaries (Task 3), throwing connector (Task 6), malformed payload (Tasks 2 and 5).
