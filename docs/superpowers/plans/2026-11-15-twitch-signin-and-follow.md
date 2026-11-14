# Twitch sign-in and follower discovery — Plan 2

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A fan signs in with Twitch, claims the identity they already have, and the channel's followers are discovered and paid without anyone signing in.

**Architecture:** The api gains a real Twitch OAuth provider and a capability route; after a verified sign-in it enqueues a discovery event rather than awarding. The worker gains a Twitch connector that refreshes the channel owner's stored grant, pages the follower list, and enqueues the same payload. Plan 1's queue, processor and ladder do the rest.

**Tech Stack:** TypeScript, Node 22, Fastify, Postgres, pnpm workspaces, Vitest, esbuild, Helm.

**Spec:** `docs/superpowers/specs/2026-11-14-platform-keys-and-stub-design.md` (plan 2 of the five at its end). Plan 1 is `docs/superpowers/plans/2026-11-14-ladder-stub-and-env.md`; its code is already on this branch's base.

## Global Constraints

- Node `>=22`, pnpm `10.34.9`; no new dependency (global `fetch` and `node:crypto` only).
- No credential value in the repository, a log line, or a rendered manifest. `.env` is git-ignored; the chart reads an operator-created Secret.
- A credential pair is all-or-nothing: one half set is a startup error naming the missing half. A configured provider also requires its target (`TWITCH_CHANNEL_LOGIN`); missing is a startup error.
- The api enqueues, the worker awards. No award call in the api.
- Every new exported function has an explicit return type. Tests that touch Postgres need `TEST_DATABASE_URL=postgres://ashu:ashu@localhost:55432/ashu`.
- Coverage at or above 80% on lines, branches, functions and statements (repo-wide gate).
- French copy in the web; English comments and logs.
- Commit messages use a Gitmoji prefix; one logical change per commit.

## Review Focus

- A fan who does not follow the channel signs in successfully with zero XP, not an error.
- A refusal or network failure mid-pagination leaves the sign-in intact and pays nothing.
- A rotated refresh token is persisted and used next time; a stale one is never resurrected.
- Half a credential pair, or a pair without `TWITCH_CHANNEL_LOGIN`, stops startup with a named variable.
- The web never renders a button for a provider the api has not configured.

---

### Task 1: The Twitch provider

**Files:**
- Modify: `apps/api/src/auth/providers.ts`
- Create: `apps/api/src/auth/providers/twitch.ts`
- Test: `apps/api/test/auth/twitchProvider.test.ts`

**Interfaces:**
- Consumes: `IdentityProfile` (`@ashuworld/providers`).
- Produces: `ExchangeResult { profile; verifiedActions: string[]; refreshToken?: string }`; `OAuthProvider.exchange(): Promise<ExchangeResult>`; `createTwitchProvider(options): OAuthProvider` with `{ clientId; clientSecret; channelLogin; fetchImpl?: typeof fetch }`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it, vi } from 'vitest'
import { createTwitchProvider } from '../../src/auth/providers/twitch.js'
import { ProviderExchangeError } from '../../src/auth/providers.js'

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function provider(fetchImpl: typeof fetch) {
  return createTwitchProvider({
    clientId: 'cid', clientSecret: 'secret', channelLogin: 'ashuworld', fetchImpl,
  })
}

describe('twitch provider', () => {
  it('builds an authorize URL with the follow scope and the state', () => {
    const url = new URL(provider(vi.fn()).authorizeUrl({
      state: 's1', redirectUri: 'https://example.test/auth/twitch/callback',
    }))
    expect(url.origin + url.pathname).toBe('https://id.twitch.tv/oauth2/authorize')
    expect(url.searchParams.get('client_id')).toBe('cid')
    expect(url.searchParams.get('scope')).toBe('user:read:follows')
    expect(url.searchParams.get('state')).toBe('s1')
    expect(url.searchParams.get('redirect_uri')).toBe('https://example.test/auth/twitch/callback')
  })

  it('exchanges the code, reads the identity and proves the follow', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === 'https://id.twitch.tv/oauth2/token') {
        return json({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 })
      }
      if (url.startsWith('https://api.twitch.tv/helix/users')) {
        return json({ data: [{ id: '42', login: 'ashu', display_name: 'Ashu' }] })
      }
      if (url.startsWith('https://api.twitch.tv/helix/channels/followed')) {
        return json({ data: [{ broadcaster_id: '9', broadcaster_login: 'ashuworld' }], pagination: {} })
      }
      throw new Error(`unexpected ${url}`)
    }) as unknown as typeof fetch

    const result = await provider(fetchImpl).exchange({
      code: 'c1', redirectUri: 'https://example.test/auth/twitch/callback',
    })
    expect(result.profile).toEqual({ provider: 'twitch', externalId: '42', displayHandle: 'ashu', displayName: 'Ashu' })
    expect(result.verifiedActions).toEqual(['twitch.follow'])
    expect(result.refreshToken).toBeUndefined()
  })

  it('signs in with no verified action when the channel is not followed', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === 'https://id.twitch.tv/oauth2/token') return json({ access_token: 'at' })
      if (url.includes('/helix/users')) return json({ data: [{ id: '42', login: 'ashu', display_name: 'Ashu' }] })
      return json({ data: [], pagination: {} })
    }) as unknown as typeof fetch

    const result = await provider(fetchImpl).exchange({ code: 'c1', redirectUri: 'https://example.test/cb' })
    expect(result.verifiedActions).toEqual([])
  })

  it('pages until it finds the channel', async () => {
    let pages = 0
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === 'https://id.twitch.tv/oauth2/token') return json({ access_token: 'at' })
      if (url.includes('/helix/users')) return json({ data: [{ id: '42', login: 'ashu', display_name: 'Ashu' }] })
      pages += 1
      if (pages === 1) {
        return json({ data: [{ broadcaster_id: '1', broadcaster_login: 'other' }], pagination: { cursor: 'next' } })
      }
      return json({ data: [{ broadcaster_id: '9', broadcaster_login: 'AshuWorld' }], pagination: {} })
    }) as unknown as typeof fetch

    const result = await provider(fetchImpl).exchange({ code: 'c1', redirectUri: 'https://example.test/cb' })
    expect(pages).toBe(2)
    expect(result.verifiedActions).toEqual(['twitch.follow'])
  })

  it('fails as a 4xx when Twitch refuses the code', async () => {
    const fetchImpl = vi.fn(async () => json({ message: 'Invalid authorization code' }, 400)) as unknown as typeof fetch
    await expect(provider(fetchImpl).exchange({ code: 'bad', redirectUri: 'https://example.test/cb' }))
      .rejects.toBeInstanceOf(ProviderExchangeError)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm exec vitest run --project @ashuworld/api apps/api/test/auth/twitchProvider.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Change the interface in `apps/api/src/auth/providers.ts`**

```ts
export interface ExchangeResult {
  profile: IdentityProfile
  /** One-time actions this grant verified, e.g. ['twitch.follow']. */
  verifiedActions: string[]
  /** A grant to keep for later re-checks. Twitch's fan grant is not kept in this plan. */
  refreshToken?: string
}

export interface OAuthProvider {
  name: ProviderName
  authorizeUrl(input: AuthorizeInput): string
  exchange(input: ExchangeInput): Promise<ExchangeResult>
}
```

The dev provider returns `{ profile: {...}, verifiedActions: [] }`.

- [ ] **Step 4: Implement `apps/api/src/auth/providers/twitch.ts`**

Constants: `AUTHORIZE_URL = 'https://id.twitch.tv/oauth2/authorize'`, `TOKEN_URL = 'https://id.twitch.tv/oauth2/token'`, `HELIX = 'https://api.twitch.tv/helix'`, `SCOPE = 'user:read:follows'`.

- `authorizeUrl`: `URL`, set `client_id`, `redirect_uri`, `response_type=code`, `scope`, `state`.
- `exchange`:
  1. `POST TOKEN_URL` with `URLSearchParams { client_id, client_secret, code, grant_type: 'authorization_code', redirect_uri }`, header `content-type: application/x-www-form-urlencoded`. Parse JSON; a non-2xx or no `access_token` throws `ProviderExchangeError('twitch refused the sign-in', 400)`.
  2. `GET HELIX/users` with headers `client-id` and `authorization: Bearer <token>`; no `data[0]` throws `ProviderExchangeError('twitch returned no account', 502)`.
  3. `GET HELIX/channels/followed?user_id=<id>&first=100` (page with `pagination.cursor` → `after`), stop when a row's `broadcaster_login.toLowerCase() === channelLogin.toLowerCase()`; a non-2xx on this read logs nothing and returns no action (the sign-in still works).
  4. Return the profile, `verifiedActions` (`['twitch.follow']` or `[]`) and no `refreshToken` (the fan grant is not kept; plan 4 teaches the same shape to keep Google's).

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm exec vitest run --project @ashuworld/api apps/api/test/auth/twitchProvider.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/auth/providers.ts apps/api/src/auth/providers/twitch.ts apps/api/test/auth/twitchProvider.test.ts
git commit -m "✨ feat(api): add the Twitch sign-in provider"
```

---

### Task 2: API credentials and registry

**Files:**
- Modify: `apps/api/src/config.ts`
- Modify: `apps/api/src/auth/providers.ts` (registry only)
- Test: `apps/api/test/config.test.ts` (create if absent), `apps/api/test/auth/registry.test.ts`

**Interfaces:**
- Produces: `Env.TWITCH_CLIENT_ID?: string`, `Env.TWITCH_CLIENT_SECRET?: string`, `Env.TWITCH_CHANNEL_LOGIN?: string`; `createProviderRegistry(env)` registers `twitch` only when all three are present.

- [ ] **Step 1: Write the failing tests**

Config:

```ts
it('leaves Twitch off when nothing is configured', () => {
  expect(loadEnv({ ...base }).TWITCH_CLIENT_ID).toBeUndefined()
})
it('refuses half a Twitch pair', () => {
  expect(() => loadEnv({ ...base, TWITCH_CLIENT_ID: 'cid' })).toThrow(/TWITCH_CLIENT_SECRET/)
})
it('refuses a Twitch pair without the channel', () => {
  expect(() => loadEnv({ ...base, TWITCH_CLIENT_ID: 'cid', TWITCH_CLIENT_SECRET: 's' }))
    .toThrow(/TWITCH_CHANNEL_LOGIN/)
})
```

Registry:

```ts
it('registers Twitch only when its credentials and channel are present', () => {
  expect(createProviderRegistry({ ALLOW_DEV_LOGIN: false }).get('twitch')).toBeUndefined()
  const registry = createProviderRegistry({
    ALLOW_DEV_LOGIN: false, TWITCH_CLIENT_ID: 'cid', TWITCH_CLIENT_SECRET: 's', TWITCH_CHANNEL_LOGIN: 'ashuworld',
  })
  expect(registry.get('twitch')?.name).toBe('twitch')
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `TEST_DATABASE_URL=postgres://ashu:ashu@localhost:55432/ashu pnpm exec vitest run --project @ashuworld/api apps/api/test/config.test.ts apps/api/test/auth/registry.test.ts`
Expected: FAIL.

- [ ] **Step 3: Extend `apps/api/src/config.ts`**

Add the three optional fields to `Env`. Read a `pairOrOff(raw, idName, secretName)` helper: neither present → both `undefined`; one present → throw naming the other. Then, if the pair is set, `required(raw, 'TWITCH_CHANNEL_LOGIN')`. The api does not read the worker's refresh token or the sealing key.

- [ ] **Step 4: Extend the registry**

`createProviderRegistry(env: Pick<Env, 'ALLOW_DEV_LOGIN' | 'TWITCH_CLIENT_ID' | 'TWITCH_CLIENT_SECRET' | 'TWITCH_CHANNEL_LOGIN'>)`. Register `twitch` via `createTwitchProvider` when all three are defined. `dev` unchanged.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `TEST_DATABASE_URL=… pnpm exec vitest run --project @ashuworld/api apps/api/test/config.test.ts apps/api/test/auth/registry.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/config.ts apps/api/src/auth/providers.ts apps/api/test/config.test.ts apps/api/test/auth/registry.test.ts
git commit -m "✨ feat(api): read and validate the Twitch credentials"
```

---

### Task 3: The callback enqueues what the grant proved

**Files:**
- Modify: `apps/api/src/routes/auth.ts`
- Test: `apps/api/test/auth.test.ts`

**Interfaces:**
- Consumes: `ExchangeResult`; `enqueueEvent`, `monthKey` (`@ashuworld/ledger`); `discoveryEventId` (`@ashuworld/providers`).
- Produces: `enqueueVerifiedActions(pool, result, now): Promise<void>` exported from `routes/auth.ts` for its tests.

- [ ] **Step 1: Write the failing test**

Use an injected provider registry whose `exchange` returns
`{ profile: { provider: 'twitch', externalId: 't-1', displayHandle: 'ashu', displayName: 'Ashu' }, verifiedActions: ['twitch.follow'] }`, then complete a login and assert:

```ts
const { rows } = await db.pool.query(`select event_id, payload from inbound_events`)
expect(rows).toHaveLength(1)
expect(rows[0].event_id).toBe('signin:twitch:t-1:twitch.follow:2026-11')
expect(rows[0].payload).toMatchObject({ kind: 'discovery', provider: 'twitch', externalId: 't-1' })
```

Second test: `verifiedActions: []` → zero rows, and the session is still set (302 to `/account`).
Third test: `enqueueVerifiedActions` is called after the transaction, so a failing `enqueueEvent` (a pool stub that throws) logs once and the callback still redirects with a session.

Compute the expected month in the test with `monthKey(new Date())` rather than hard-coding `2026-11`; the route uses the real clock.

- [ ] **Step 2: Run it to verify it fails**

Run: `TEST_DATABASE_URL=… pnpm exec vitest run --project @ashuworld/api apps/api/test/auth.test.ts -t "verified"`
Expected: FAIL.

- [ ] **Step 3: Adapt the routes**

- `resolveLogin` and `resolveLink` take `result: ExchangeResult` and use `result.profile`.
- In the callback, after the login transaction returns a session (or the link returns `linked`), call:

```ts
export async function enqueueVerifiedActions(
  pool: Pool,
  result: ExchangeResult,
  now: Date = new Date(),
): Promise<void> {
  if (result.verifiedActions.length === 0) return
  const person = {
    provider: result.profile.provider as 'twitch' | 'discord' | 'youtube',
    externalId: result.profile.externalId,
    displayHandle: result.profile.displayHandle,
    displayName: result.profile.displayName,
    actions: result.verifiedActions,
  }
  await enqueueEvent(pool, {
    provider: person.provider,
    eventId: discoveryEventId('signin', person, monthKey(now)),
    payload: { kind: 'discovery', ...person },
  })
}
```

- Wrap the call in `try/catch`; on failure `console.error('[api] the sign-in event was not queued', error)` and continue. The next sign-in re-enqueues with the same id, so nothing is lost.
- Call it for a login only when a session was created, and for a link only on `linked`. A `reattach` answer enqueues nothing.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `TEST_DATABASE_URL=… pnpm exec vitest run --project @ashuworld/api apps/api/test/auth.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/auth.ts apps/api/test/auth.test.ts
git commit -m "✨ feat(api): queue the actions a Twitch grant proved"
```

---

### Task 4: The capability route

**Files:**
- Modify: `apps/api/src/routes/public.ts`
- Modify: `apps/api/src/auth/providers.ts` (a `names()` accessor)
- Test: `apps/api/test/public.test.ts`, `apps/api/test/identities.test.ts` (route table)

**Interfaces:**
- Produces: `GET /api/public/providers` → `{ providers: string[] }` in the fixed order `twitch`, `discord`, `youtube`, `dev` (dev only when enabled).

- [ ] **Step 1: Write the failing tests**

```ts
it('lists exactly the configured providers in order', async () => {
  const app = buildServer({ ...deps, env: { ...env, ALLOW_DEV_LOGIN: true, TWITCH_CLIENT_ID: 'c', TWITCH_CLIENT_SECRET: 's', TWITCH_CHANNEL_LOGIN: 'ashuworld' } })
  const res = await app.inject('/api/public/providers')
  expect(res.statusCode).toBe(200)
  expect(res.json()).toEqual({ providers: ['twitch', 'dev'] })
})
it('answers an empty list when nothing is configured', async () => { /* providers: [] */ })
```

Add `/api/public/providers` to the pinned route table in `apps/api/test/identities.test.ts`.

- [ ] **Step 2: Run them to verify they fail**

Run: `TEST_DATABASE_URL=… pnpm exec vitest run --project @ashuworld/api apps/api/test/public.test.ts apps/api/test/identities.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`ProviderRegistry` gains `names(): ProviderName[]`. `createProviderRegistry` returns them in the fixed order. `registerPublicRoutes` takes `providers: ProviderRegistry` (or a `configured: () => string[]`) and serves the route with `Cache-Control: public, max-age=15`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `TEST_DATABASE_URL=… pnpm exec vitest run --project @ashuworld/api apps/api/test/public.test.ts apps/api/test/identities.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/public.ts apps/api/src/auth/providers.ts apps/api/test/public.test.ts apps/api/test/identities.test.ts
git commit -m "✨ feat(api): answer which sign-in providers are configured"
```

---

### Task 5: Real sign-in buttons in the web

**Files:**
- Modify: `apps/web/src/api.ts`, `apps/web/src/pages/Account.tsx`
- Test: `apps/web/test/pages.test.tsx`

**Interfaces:**
- Consumes: `GET /api/public/providers`; `devLoginAvailable`.
- Produces: `fetchProviders(): Promise<{ providers: string[] }>`; the signed-out panel renders one `<a>` per configured provider.

- [ ] **Step 1: Write the failing test**

```tsx
it('offers a sign-in button for each configured provider', async () => {
  mockFetch({ '/api/public/providers': { providers: ['twitch', 'dev'] }, '/api/me': { status: 401 } })
  renderAccount()
  expect(await screen.findByRole('link', { name: /Twitch/i })).toHaveAttribute('href', '/auth/twitch/start?purpose=login')
  expect(screen.getByRole('link', { name: /dev/i })).toBeInTheDocument()
  expect(screen.queryByRole('link', { name: /Discord/i })).toBeNull()
})
it('shows the not-activated sentence only when the list is empty', async () => {
  mockFetch({ '/api/public/providers': { providers: [] }, '/api/me': { status: 401 } })
  renderAccount()
  expect(await screen.findByText(/n’est pas activée/)).toBeInTheDocument()
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm exec vitest run --project @ashuworld/web apps/web/test/pages.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement**

- `api.ts`: `fetchProviders()` using the existing `request` helper.
- `SignInPanel`: `useResource(fetchProviders, [])`; render a link per name (label from `providerLabel`), keep the dev sentence only when `dev` is listed, and show "La connexion n’est pas activée…" only for an empty list. Order the buttons as the api returns them.
- `AttachPanel`: filter `LINKABLE_PROVIDERS` by the configured list, passed down from the loaded resource (one fetch per page).
- An api failure on the capability route falls back to the dev door if the build allows it, and otherwise to the not-activated sentence; do not render a button on a guess.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run --project @ashuworld/web`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/api.ts apps/web/src/pages/Account.tsx apps/web/test/pages.test.tsx
git commit -m "✨ feat(web): offer the configured sign-in providers"
```

---

### Task 6: Sealed platform tokens

**Files:**
- Create: `packages/providers/src/grants.ts` (crypto)
- Modify: `packages/providers/src/index.ts`
- Create: `packages/ledger/migrations/0005_platform_tokens.sql`
- Create: `packages/ledger/src/platformTokens.ts`
- Modify: `packages/ledger/src/index.ts`
- Test: `packages/providers/test/grants.test.ts`, `packages/ledger/test/platformTokens.test.ts`

**Interfaces:**
- Produces: `sealToken(plaintext: string, keyBase64: string): string`, `openToken(sealed: string, keyBase64: string): string`; `readPlatformToken(db, provider): Promise<string | null>` (sealed), `writePlatformToken(db, provider, sealed): Promise<void>`.

- [ ] **Step 1: Write the failing tests**

```ts
it('round-trips a token and produces different ciphertext each time', () => {
  const key = randomBytes(32).toString('base64')
  const a = sealToken('secret', key)
  const b = sealToken('secret', key)
  expect(a).not.toBe(b)
  expect(openToken(a, key)).toBe('secret')
  expect(a).not.toContain('secret')
})
it('refuses a key that is not 32 bytes', () => {
  expect(() => sealToken('x', Buffer.from('short').toString('base64'))).toThrow(/32 bytes/)
})
it('fails closed when the key changed', () => {
  const sealed = sealToken('secret', randomBytes(32).toString('base64'))
  expect(() => openToken(sealed, randomBytes(32).toString('base64'))).toThrow()
})
```

Ledger: a table test asserting `readPlatformToken` returns what `writePlatformToken` stored, and a second write replaces it (`updated_at` moves).

- [ ] **Step 2: Run them to verify they fail**

Run: `TEST_DATABASE_URL=… pnpm exec vitest run --project @ashuworld/providers packages/providers/test/grants.test.ts` and `… --project @ashuworld/ledger packages/ledger/test/platformTokens.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

- `grants.ts`: `createCipheriv('aes-256-gcm', key, iv)` with a random 12-byte IV; store `v1:<iv b64url>:<tag b64url>:<ciphertext b64url>`. `openToken` parses the prefix, rejects an unknown version, and lets GCM's auth failure throw (the caller decides what a bad key means).
- Migration: `create table platform_tokens (provider text primary key, refresh_token text not null, updated_at timestamptz not null default now());`
- SQL: read one row; write with `on conflict (provider) do update set refresh_token = excluded.refresh_token, updated_at = now()`.

- [ ] **Step 4: Run the tests to verify they pass**

Run both commands again. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/providers/src/grants.ts packages/providers/src/index.ts packages/ledger/migrations/0005_platform_tokens.sql packages/ledger/src/platformTokens.ts packages/ledger/src/index.ts packages/providers/test/grants.test.ts packages/ledger/test/platformTokens.test.ts
git commit -m "✨ feat(ledger): keep the channel grant sealed at rest"
```

---

### Task 7: The one-time channel authorization command

**Files:**
- Create: `apps/worker/src/twitchAuthorize.ts`
- Modify: `apps/worker/package.json` (a `twitch-authorize` script)
- Test: `apps/worker/test/twitchAuthorize.test.ts`

**Interfaces:**
- Produces: `twitchAuthorizeUrl(env): string`, `exchangeTwitchCode(env, code, fetchImpl): Promise<{ refreshToken: string }>`, and a `main` that reads the code from stdin.

- [ ] **Step 1: Write the failing test**

Assert the URL carries `client_id`, `response_type=code`, the `moderator:read:followers` scope, the redirect `http://localhost:17563/twitch/callback` and a random `state`; and that `exchangeTwitchCode` posts the code and returns the refresh token. A response without a refresh token throws a message telling the operator to revoke the app and retry.

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm exec vitest run --project @ashuworld/worker apps/worker/test/twitchAuthorize.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

The command prints the URL and says which account must click it (the channel owner). It starts a one-shot `node:http` server on `127.0.0.1:17563` for the callback, reads `code` and `state`, verifies the state, exchanges the code, prints the refresh token with a one-line instruction to paste it into `.env` as `TWITCH_CHANNEL_REFRESH_TOKEN`, and exits. It never writes a file or the database. `process.env` supplies `TWITCH_CLIENT_ID` and `TWITCH_CLIENT_SECRET`; a missing one exits non-zero naming it.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm exec vitest run --project @ashuworld/worker apps/worker/test/twitchAuthorize.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/twitchAuthorize.ts apps/worker/package.json apps/worker/test/twitchAuthorize.test.ts
git commit -m "✨ feat(worker): authorize the channel owner once"
```

---

### Task 8: Worker Twitch configuration

**Files:**
- Modify: `apps/worker/src/config.ts`
- Test: `apps/worker/test/config.test.ts`

**Interfaces:**
- Produces: `ConnectorName = 'stub' | 'twitch'`; `WorkerEnv.TWITCH_CLIENT_ID?`, `TWITCH_CLIENT_SECRET?`, `TWITCH_CHANNEL_LOGIN?`, `TWITCH_CHANNEL_REFRESH_TOKEN?`, `PLATFORM_TOKEN_KEY?`.

- [ ] **Step 1: Write the failing tests**

```ts
it('accepts twitch when all five values are present', () => {
  const env = loadWorkerEnv({ ...base, PLATFORM_CONNECTORS: 'twitch', TWITCH_CLIENT_ID: 'c', TWITCH_CLIENT_SECRET: 's', TWITCH_CHANNEL_LOGIN: 'ashuworld', TWITCH_CHANNEL_REFRESH_TOKEN: 'rt', PLATFORM_TOKEN_KEY: randomBytes(32).toString('base64') })
  expect(env.PLATFORM_CONNECTORS).toEqual(['twitch'])
})
it.each(['TWITCH_CLIENT_SECRET', 'TWITCH_CHANNEL_LOGIN', 'TWITCH_CHANNEL_REFRESH_TOKEN', 'PLATFORM_TOKEN_KEY'])(
  'refuses twitch without %s', (missing) => { /* omit it, expect a throw naming it */ },
)
it('refuses the Twitch pair half-set even when twitch is not listed', () => {
  expect(() => loadWorkerEnv({ ...base, TWITCH_CLIENT_ID: 'c' })).toThrow(/TWITCH_CLIENT_SECRET/)
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm exec vitest run --project @ashuworld/worker apps/worker/test/config.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

Extend `ConnectorName` and the env fields. Validate in this order: the client pair (both or neither, always) → when `'twitch'` is listed, all five required. A complete set without `'twitch'` in `PLATFORM_CONNECTORS` is allowed and simply unused: an operator may hold the credentials for a later rollout. `PLATFORM_TOKEN_KEY` must decode to 32 bytes when present.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run --project @ashuworld/worker apps/worker/test/config.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/config.ts apps/worker/test/config.test.ts
git commit -m "✨ feat(worker): require the Twitch settings it needs"
```

---

### Task 9: The Twitch follower connector

**Files:**
- Create: `apps/worker/src/connectors/twitchToken.ts`
- Create: `apps/worker/src/connectors/twitch.ts`
- Modify: `apps/worker/src/connectors/index.ts`
- Test: `apps/worker/test/twitchConnector.test.ts`

**Interfaces:**
- Consumes: `readPlatformToken`, `writePlatformToken`; `sealToken`, `openToken`; `WorkerEnv`.
- Produces: `getTwitchAccessToken(deps): Promise<string>`; `createTwitchConnector({ pool, env, fetchImpl? }): Connector`.

- [ ] **Step 1: Write the failing tests**

```ts
it('seeds the token table from the environment on first use', async () => {
  // empty table, env token 'rt-env' -> getTwitchAccessToken returns 'at' and the row is sealed
})
it('persists a rotated refresh token and uses it next time', async () => {
  // first refresh returns refresh_token 'rt-2', second call posts 'rt-2', not 'rt-env'
})
it('pages the follower list into people', async () => {
  // two pages, 3 people total, actions ['twitch.follow'], external ids from user_id
})
it('reports a failed follower page without yielding partial garbage', async () => {
  // second page 500 -> the async iteration throws; runDiscovery catches it per connector
})
it('fails loudly when the stored token cannot be unsealed', async () => {
  // write a token sealed with another key -> getTwitchAccessToken throws naming PLATFORM_TOKEN_KEY
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `TEST_DATABASE_URL=… pnpm exec vitest run --project @ashuworld/worker apps/worker/test/twitchConnector.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`twitchToken.ts`:

```ts
export interface TwitchTokenDeps {
  pool: Pool
  clientId: string
  clientSecret: string
  envToken?: string
  key: string
  fetchImpl?: typeof fetch
  now?: () => number
}
export async function getTwitchAccessToken(deps: TwitchTokenDeps): Promise<string>
```

- Read the sealed row; absent → seal `envToken` (required by config) and write it.
- Unseal; on failure throw `new Error('the stored Twitch grant cannot be opened; set a matching PLATFORM_TOKEN_KEY or run twitch-authorize again')`.
- Refresh with `grant_type=refresh_token`; if the response carries a `refresh_token`, seal and write it.
- Cache the access token in a module-level `Map` keyed by the client id until `expires_at - 60s`. A test passes `now` to avoid waiting; do not export the cache for clearing — key the map by `clientId:refreshToken`, which changes when rotated.

`twitch.ts`:

- Resolve the broadcaster id once per call: `GET /helix/users?login=<TWITCH_CHANNEL_LOGIN>`.
- Page `GET /helix/channels/followers?broadcaster_id=<id>&first=100` (and `after` while a cursor exists); yield `{ provider: 'twitch', externalId: user_id, displayHandle: user_login, displayName: user_name, actions: ['twitch.follow'] }`.
- A non-2xx throws an `Error` naming the status; the runner logs and retries next tick.

`connectors/index.ts`: build the Twitch connector when `'twitch'` is listed.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `TEST_DATABASE_URL=… pnpm exec vitest run --project @ashuworld/worker apps/worker/test/twitchConnector.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/connectors apps/worker/test/twitchConnector.test.ts
git commit -m "✨ feat(worker): discover Twitch followers from the channel grant"
```

---

### Task 10: The chart's providers block

**Files:**
- Modify: `deploy/helm/ashuworld/values.yaml`
- Modify: `deploy/helm/ashuworld/templates/api.yaml`, `worker.yaml`
- Modify: `deploy/helm/ashuworld/test/render.sh`
- Test: `deploy/helm/ashuworld/test/render.sh`

**Interfaces:**
- Values: `providers.secretName`, `providers.twitch.channelLogin`.

- [ ] **Step 1: Add the values and env references**

`providers.secretName: ""` (the operator's Secret; the chart creates none), `providers.twitch.channelLogin: ""`. Map the Secret keys with `optional: true`:

| key | api | worker |
|---|---|---|
| `twitch-client-id` → `TWITCH_CLIENT_ID` | yes | yes |
| `twitch-client-secret` → `TWITCH_CLIENT_SECRET` | yes | yes |
| `twitch-channel-token` → `TWITCH_CHANNEL_REFRESH_TOKEN` | no | yes |
| `platform-token-key` → `PLATFORM_TOKEN_KEY` | no (until plan 4) | yes |

`TWITCH_CHANNEL_LOGIN` comes from `providers.twitch.channelLogin` as plain env on both, rendered only when non-empty.

- [ ] **Step 2: Add render assertions**

In `test/render.sh`: with `--set providers.secretName=ashuworld-providers --set providers.twitch.channelLogin=ashuworld`, both Deployments reference `secretKeyRef` with `optional: true`; the channel login appears as a plain env; the rendered manifests contain no literal secret; with `providers.secretName` empty, no provider `secretKeyRef` appears.

- [ ] **Step 3: Run the chart checks**

Run: `bash deploy/helm/ashuworld/test/render.sh && helm lint deploy/helm/ashuworld`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add deploy/helm/ashuworld
git commit -m "🔧 chore(chart): mount the Twitch credentials from a Secret"
```

---

### Task 11: Local keys and documentation

**Files:**
- Modify: `.env.example`
- Modify: `README.md`

- [ ] **Step 1: Extend `.env.example`**

Add, each with a comment: `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET`, `TWITCH_CHANNEL_LOGIN`, `TWITCH_CHANNEL_REFRESH_TOKEN`, `PLATFORM_TOKEN_KEY` (and say `openssl rand -base64 32`). Keep `PLATFORM_CONNECTORS` accepting `stub` or `twitch`.

- [ ] **Step 2: Add the README "Platform keys" subsection**

Under the development stack: create a Twitch application at <https://dev.twitch.tv/console/apps>, register two OAuth redirect URLs — `<PUBLIC_BASE_URL>/auth/twitch/callback` and `http://localhost:17563/twitch/callback` (the one-time channel authorization uses the second) — put the client id and secret in `.env`, run `pnpm --filter @ashuworld/worker twitch-authorize` as the channel owner, paste the printed refresh token, set `PLATFORM_CONNECTORS=twitch`, restart the worker. State that the follower poll runs every `SYNC_INTERVAL_SECONDS` and that a fan who does not follow still signs in with no XP.

- [ ] **Step 3: Commit**

```bash
git add .env.example README.md
git commit -m "📝 docs: configure and run the Twitch integration"
```

---

### Task 12: Verification gate

- [ ] **Step 1: Run the gate**

```bash
TEST_DATABASE_URL=postgres://ashu:ashu@localhost:55432/ashu pnpm typecheck && pnpm lint && pnpm test:coverage
bash deploy/helm/ashuworld/test/render.sh && helm lint deploy/helm/ashuworld
```

Expected: zero failures, every metric at or above 80%, both chart checks green.

- [ ] **Step 2: Fix any gap in its owning task's files**

Add the missing test; never lower a threshold. Commit as `✅ test(…): cover the Twitch path`.

---

## Plan self-review

- Spec coverage for plan 2: sign-in provider (Tasks 1–2), follow verification (Task 1), enqueue after commit (Task 3), capability route and web buttons (Tasks 4–5), token table and sealing (Task 6), channel command (Task 7), worker config and connector (Tasks 8–9), chart (Task 10), docs and gate (Tasks 11–12). Discord and Google/YouTube belong to plans 3–5.
- Names and types are consistent across tasks: `ExchangeResult`, `createTwitchProvider`, `createProviderRegistry`, `enqueueVerifiedActions`, `fetchProviders`, `sealToken`/`openToken`, `readPlatformToken`/`writePlatformToken`, `getTwitchAccessToken`, `createTwitchConnector`.
- Review Focus has a test in each owning task: not-following (Task 1), mid-pagination failure (Task 1 and Task 9), rotated token and stale-key failure (Task 9), startup validation (Tasks 2 and 8), capability rendering (Tasks 4 and 5).
