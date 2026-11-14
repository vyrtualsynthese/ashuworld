# Hardening and Compliance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make AshuWorld lawful to publish in France and harden its HTTP edge, without changing a game rule.

**Architecture:** Four short branches, one pull request each, cut from `develop` in this order: security, legal, documentation, refactor. Each branch is independently shippable. The legal branch adds one migration, two small ledger modules and three web routes; nothing in it touches the award, penalty or detach rules.

**Tech Stack:** TypeScript, Fastify 5, `@fastify/helmet` 13, `@fastify/rate-limit` 11, React 19, Postgres 17, Helm 4, nginx 1.29.

**Spec:** [`docs/superpowers/specs/2026-11-14-hardening-and-compliance-design.md`](../specs/2026-11-14-hardening-and-compliance-design.md)

## Global Constraints

- Four branches, one PR each, each rebased on `develop`; merge by rebase, never a merge commit.
- Gitmoji commit prefixes; one logical change per commit.
- Coverage stays at or above 80% on lines, branches, functions and statements.
- Every guard added here gets a test that fails when the guard is removed.
- Code, comments and this plan are English. User-facing text and legal documents are French.
- The product word is **Dachi**; the code and schema keep `fan` / `fans`.
- Company facts, exact: `ASHU DEV`, `SARL`, capital `1 000 €`, `14 rue Bausset, 75015 Paris`, `RCS Paris 898 442 538`, `SIRET 898 442 538 00010`, `TVA FR 72 898 442 538`, `info@ashudev.com`, publication director `Valentin Ronteix`, hébergeur `ASHU DEV (auto-hébergement)`.
- No new runtime dependency beyond `@fastify/helmet` and `@fastify/rate-limit`.
- The test database is `postgres://ashu:ashu@localhost:5432/ashu`; every doc string says `5432`.

## Review Focus

- **Sign-in with no age/terms acceptance** must answer `400 consent_required` and create nothing, never a session.
- **An erased provider account signing in again** must get a fresh fan at 0 XP, with every one-time key still spent.
- **A crowd behind one carrier NAT address** must still read the ladder; only sign-in is strict.
- **The Vite bundle under the new CSP** must boot; no inline script or style is allowed to slip in.
- **`purge --dry-run`** must write nothing, and a second real run must leave the same end state.

---

## Branch 1 — `security/hardening`

### Task 1: API security headers

**Files:**
- Create: `apps/api/src/security/headers.ts`
- Modify: `apps/api/src/server.ts` (register the plugin after `cookie`)
- Test: `apps/api/test/headers.test.ts`

**Interfaces:**
- Produces: `helmetOptions(): FastifyHelmetOptions`
- Consumes: nothing.

- [ ] **Step 1: Add the dependency**

```bash
pnpm --filter @ashuworld/api add @fastify/helmet@^13.2.0
```

- [ ] **Step 2: Write the failing test**

```ts
// apps/api/test/headers.test.ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import type { Pool } from 'pg'
import type { GameConfig } from '@ashuworld/gameconfig'
import { createPool } from '@ashuworld/ledger'
import { buildServer } from '../src/server.js'
import type { Env } from '../src/config.js'

const cfg: GameConfig = {
  version: 'test',
  actions: { 'twitch.follow': { amount: 50, provider: 'twitch' } },
  levels: [{ level: 0, minXp: 0 }],
  beyond: { step: 1600, factor: 2 },
}

function testDatabaseUrl(): string {
  const url = process.env['TEST_DATABASE_URL']
  if (url === undefined || url.trim() === '') {
    throw new Error('TEST_DATABASE_URL is not set')
  }
  return url
}

function testEnv(): Env {
  return {
    DATABASE_URL: testDatabaseUrl(),
    SESSION_COOKIE_NAME: 'ashuworld_session',
    COOKIE_SECURE: false,
    ALLOW_DEV_LOGIN: false,
    TRUST_PROXY: false,
    PUBLIC_BASE_URL: 'http://localhost:3000',
    PORT: 3000,
  }
}

let pool: Pool
beforeAll(() => { pool = createPool(testDatabaseUrl()) })
afterAll(async () => { await pool.end() })

async function withApp(run: (app: FastifyInstance) => Promise<void>): Promise<void> {
  const app = buildServer({ pool, cfg, env: testEnv() })
  app.log.level = 'silent'
  try { await run(app) } finally { await app.close() }
}

describe('security headers', () => {
  it('sets a deny-all CSP and the fixed headers on every route', async () => {
    await withApp(async (app) => {
      for (const url of ['/api/health', '/api/public/game']) {
        const res = await app.inject({ method: 'GET', url })
        expect(res.headers['content-security-policy']).toContain("default-src 'none'")
        expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'")
        expect(res.headers['x-content-type-options']).toBe('nosniff')
        expect(res.headers['referrer-policy']).toBe('no-referrer')
        expect(res.headers['cross-origin-opener-policy']).toBe('same-origin')
        expect(res.headers['x-powered-by']).toBeUndefined()
      }
    })
  })
})
```

- [ ] **Step 3: Run it and watch it fail**

```bash
docker compose up -d db
TEST_DATABASE_URL=postgres://ashu:ashu@localhost:5432/ashu \
  pnpm exec vitest run --project @ashuworld/api apps/api/test/headers.test.ts
```

Expected: FAIL — `content-security-policy` is undefined.

- [ ] **Step 4: Implement `helmetOptions`**

```ts
// apps/api/src/security/headers.ts
import type { FastifyHelmetOptions } from '@fastify/helmet'

/**
 * The API answers JSON only. The policy is therefore deny-all, which also blocks a
 * browser from rendering an error body as a document if a proxy ever serves one.
 */
export function helmetOptions(): FastifyHelmetOptions {
  return {
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        'default-src': ["'none'"],
        'frame-ancestors': ["'none'"],
        'base-uri': ["'none'"],
        'form-action': ["'none'"],
      },
    },
    referrerPolicy: { policy: 'no-referrer' },
    crossOriginOpenerPolicy: { policy: 'same-origin' },
    crossOriginResourcePolicy: { policy: 'same-origin' },
    hsts: { maxAge: 31_536_000, includeSubDomains: true },
  }
}
```

Register it in `buildServer`, immediately after `app.register(cookie)`:

```ts
app.register(helmet, helmetOptions())
```

- [ ] **Step 5: Run the test and the api suite**

```bash
TEST_DATABASE_URL=postgres://ashu:ashu@localhost:5432/ashu \
  pnpm exec vitest run --project @ashuworld/api
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/package.json pnpm-lock.yaml apps/api/src/security/headers.ts apps/api/src/server.ts apps/api/test/headers.test.ts
git commit -m "🔒 feat(api): deny-all security headers on every response"
```

---

### Task 2: Web security headers and the image assertion

**Files:**
- Create: `docker/nginx/security-headers.conf`
- Modify: `docker/nginx/default.conf.template` (server level and the three SPA locations)
- Modify: `docker/web.Dockerfile` (copy the snippet)
- Modify: `.github/workflows/ci.yml` (extend the `smoke` job)

**Interfaces:**
- Produces: the header set on every SPA response.
- Consumes: nothing.

- [ ] **Step 1: Write the failing assertion first**

Add these steps to the `smoke` job, after the api health step:

```yaml
      - name: The web image sends the security headers
        run: |
          docker run -d --name web -p 8080:8080 "$IMAGE_PREFIX/web:$GITHUB_SHA"
          for _ in $(seq 1 30); do
            if curl -fsS -I http://127.0.0.1:8080/ > /tmp/web-headers.txt; then break; fi
            sleep 1
          done
          cat /tmp/web-headers.txt
          grep -qi 'content-security-policy:.*default-src' /tmp/web-headers.txt
          grep -qi 'strict-transport-security:' /tmp/web-headers.txt
          grep -qi 'x-content-type-options: nosniff' /tmp/web-headers.txt
          grep -qi 'referrer-policy:' /tmp/web-headers.txt
          docker rm -f web
```

- [ ] **Step 2: Run it and watch it fail**

Build and run the image locally; the CI `smoke` job only runs on `push`, so the local run is the one that closes the loop on a feature branch:

```bash
docker build -f docker/web.Dockerfile -t ashuworld/web:test \
  --build-arg VITE_DEV_LOGIN=false .
docker run -d --rm -p 8081:8080 -e API_UPSTREAM=http://127.0.0.1:3000 ashuworld/web:test
curl -sI http://127.0.0.1:8081/ | grep -i 'content-security-policy'
```

Expected: FAIL — no CSP header. (The api does not need to be running to read the headers.)

- [ ] **Step 3: Add the snippet**

```nginx
# docker/nginx/security-headers.conf
#
# The page needs its own bundle and stylesheet and nothing else. Vite emits no inline
# script or style; if a future plugin starts to, add its hash here rather than
# 'unsafe-inline'.
add_header Content-Security-Policy "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'" always;
add_header X-Content-Type-Options "nosniff" always;
add_header Referrer-Policy "strict-origin-when-cross-origin" always;
add_header Permissions-Policy "camera=(), microphone=(), geolocation=()" always;
```

- [ ] **Step 4: Wire it in**

In `default.conf.template`:

- At server level, add `add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;`.
- Add `include /etc/nginx/security-headers.conf;` inside `location = /index.html`, `location /assets/` and `location /`. These three define their own `add_header`, so they do not inherit the snippet from the server block; the include is what keeps the headers present.

In `docker/web.Dockerfile`, next to the `default.conf.template` copy:

```dockerfile
COPY docker/nginx/security-headers.conf /etc/nginx/security-headers.conf
```

- [ ] **Step 5: Prove the bundle has no inline code**

```bash
grep -o '<script[^>]*>' apps/web/dist/index.html
```

Expected: one `<script type="module" src=...>` and no inline body. If an inline script appears, add its SHA-256 to `script-src` instead of weakening the policy.

- [ ] **Step 6: Commit**

```bash
git add docker/nginx/security-headers.conf docker/nginx/default.conf.template docker/web.Dockerfile .github/workflows/ci.yml
git commit -m "🔒 feat(web): CSP, HSTS and the rest of the header set"
```

---

### Task 3: Rate limiting

**Files:**
- Create: `apps/api/src/security/rateLimit.ts`
- Modify: `apps/api/src/config.ts` (five values)
- Modify: `apps/api/src/server.ts` (register and map 429)
- Modify: `apps/api/src/routes/health.ts` (`config: { rateLimit: false }`)
- Modify: `apps/api/src/routes/auth.ts` (auth override on start, callback, logout)
- Modify: `apps/api/src/routes/identities.ts` (write override on detach)
- Test: `apps/api/test/rate-limit.test.ts`

**Interfaces:**
- Produces: `rateLimitOptions(env: RateLimitEnv): FastifyRateLimitOptions`, `AUTH_RATE_LIMIT`, `WRITE_RATE_LIMIT`.
- Consumes: `Env` from Task 1's extended shape.

- [ ] **Step 1: Add the dependency**

```bash
pnpm --filter @ashuworld/api add @fastify/rate-limit@^11.2.2
```

- [ ] **Step 2: Write the failing test**

```ts
// apps/api/test/rate-limit.test.ts
// Build a server with RATE_LIMIT_ENABLED true, RATE_LIMIT_AUTH_MAX 2 and
// ALLOW_DEV_LOGIN true. Send three GET /auth/dev/start?purpose=login&accept=2026-11-14
// from the same injected address.
it('refuses the third sign-in start in the window with the shared envelope', async () => {
  const res = await app.inject({ method: 'GET', url: '/auth/dev/start?purpose=login&accept=2026-11-14' })
  expect(res.statusCode).toBe(429)
  expect(res.json()).toEqual({ error: { code: 'rate_limited', message: expect.any(String) } })
  expect(res.headers['retry-after']).toBeDefined()
})

it('leaves the health probe unlimited so the kubelet is never 429ed', async () => {
  for (let i = 0; i < 10; i += 1) {
    expect((await app.inject({ method: 'GET', url: '/api/health' })).statusCode).toBe(200)
  }
})

it('does nothing when RATE_LIMIT_ENABLED is false', async () => {
  // 50 requests to /api/public/game, all 200
})

it('keeps the ladder readable while sign-in is limited', async () => {
  // Exhaust the auth bucket with three starts, then expect /api/public/ladder to be 200.
})
```

- [ ] **Step 3: Run it and watch it fail**

```bash
TEST_DATABASE_URL=postgres://ashu:ashu@localhost:5432/ashu \
  pnpm exec vitest run --project @ashuworld/api apps/api/test/rate-limit.test.ts
```

Expected: FAIL — the third request is a 302, and `retry-after` is absent.

- [ ] **Step 4: Implement the options**

```ts
// apps/api/src/security/rateLimit.ts
import type { RateLimitPluginOptions } from '@fastify/rate-limit'

export interface RateLimitEnv {
  RATE_LIMIT_ENABLED: boolean
  RATE_LIMIT_WINDOW_MS: number
  RATE_LIMIT_PUBLIC_MAX: number
  RATE_LIMIT_AUTH_MAX: number
  RATE_LIMIT_WRITE_MAX: number
}

export function rateLimitOptions(env: RateLimitEnv): RateLimitPluginOptions {
  return {
    global: true,
    max: env.RATE_LIMIT_PUBLIC_MAX,
    timeWindow: env.RATE_LIMIT_WINDOW_MS,
    errorResponseBuilder: (_request, context) => ({
      statusCode: 429,
      code: 'rate_limited',
      retryAfter: context.ttl,
      message: 'too many requests in a short window; wait a moment and try again',
    }),
  }
}

export const AUTH_RATE_LIMIT_GROUP = 'auth'
export const WRITE_RATE_LIMIT_GROUP = 'write'
```

Per-route configs use the env maxima and the group ids:

```ts
const authLimit = {
  max: env.RATE_LIMIT_AUTH_MAX,
  timeWindow: env.RATE_LIMIT_WINDOW_MS,
  groupId: AUTH_RATE_LIMIT_GROUP,
}
const writeLimit = {
  max: env.RATE_LIMIT_WRITE_MAX,
  timeWindow: env.RATE_LIMIT_WINDOW_MS,
  groupId: WRITE_RATE_LIMIT_GROUP,
}
```

Register only when `env.RATE_LIMIT_ENABLED`, immediately after helmet:

```ts
if (env.RATE_LIMIT_ENABLED) app.register(rateLimit, rateLimitOptions(env))
```

In `buildServer`'s error handler, before the generic 4xx branch:

```ts
if (status === 429) {
  const retryAfter = (error as { retryAfter?: unknown }).retryAfter
  if (typeof retryAfter === 'number') {
    reply.header('Retry-After', String(Math.ceil(retryAfter / 1000)))
  }
  return reply.code(429).send(errorBody('rate_limited', 'too many requests in a short window; wait a moment and try again'))
}
```

Add to `loadEnv`: `RATE_LIMIT_ENABLED` (flag, default true), `RATE_LIMIT_WINDOW_MS` (positive integer, default 60 000), `RATE_LIMIT_PUBLIC_MAX` (default 120), `RATE_LIMIT_AUTH_MAX` (default 20), `RATE_LIMIT_WRITE_MAX` (default 10). Reuse the existing `flag`/integer helpers; a bad value is a startup error.

- [ ] **Step 5: Give every api test helper the new fields**

`Env` gained five required fields, so every helper that builds one must include them:
`apps/api/test/server.test.ts`, `auth.test.ts`, `session.test.ts`, `public.test.ts`,
`identities.test.ts` and `main.test.ts`. Add `RATE_LIMIT_ENABLED: false`,
`RATE_LIMIT_WINDOW_MS: 60_000`, `RATE_LIMIT_PUBLIC_MAX: 120`, `RATE_LIMIT_AUTH_MAX: 20` and
`RATE_LIMIT_WRITE_MAX: 10` to each `testEnv` object, including the one in `headers.test.ts`
from Task 1.

- [ ] **Step 6: Apply the overrides and exempt health**

On `/auth/:provider/start`, `/auth/:provider/callback` and `/auth/logout`, add `config: { rateLimit: authLimit }`. On the detach route, `config: { rateLimit: writeLimit }`. On `/api/health`, `config: { rateLimit: false }`.

- [ ] **Step 7: Run the suite and commit**

```bash
TEST_DATABASE_URL=postgres://ashu:ashu@localhost:5432/ashu pnpm exec vitest run --project @ashuworld/api
git add apps/api/package.json pnpm-lock.yaml apps/api/src apps/api/test/rate-limit.test.ts
git commit -m "🔒 feat(api): rate limit sign-in and destructive writes"
```

---

### Task 4: `no-store` on every personal response

**Files:**
- Modify: `apps/api/src/auth/session.ts` (`requireFan`)
- Modify: `apps/api/src/routes/auth.ts` (start and callback)
- Modify: `apps/api/src/routes/me.ts` (logout)
- Test: `apps/api/test/session.test.ts` (add cases)

**Interfaces:**
- Consumes: `requireFan(deps): preHandlerAsyncHookHandler`.
- Produces: a `Cache-Control: no-store` and `Vary: Cookie` header on every authenticated response.

- [ ] **Step 1: Write the failing tests**

```ts
it('marks a signed-in response no-store for every cache', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } })
  expect(res.statusCode).toBe(200)
  expect(res.headers['cache-control']).toBe('no-store')
  expect(res.headers['vary']).toContain('Cookie')
})

it('marks the sign-in redirect no-store', async () => {
  const res = await app.inject({ method: 'GET', url: '/auth/dev/start?purpose=login&accept=2026-11-14' })
  expect(res.headers['cache-control']).toBe('no-store')
})
```

- [ ] **Step 2: Run them and watch them fail**

Expected: FAIL — headers are undefined.

- [ ] **Step 3: Set the headers**

In `requireFan`, after the session is proven and before returning:

```ts
reply.header('Cache-Control', 'no-store')
reply.header('Vary', 'Cookie')
```

In `/auth/:provider/start`, `/auth/:provider/callback` and `/auth/logout`, call the same two lines at the top of the handler. Put them in one helper `personalResponse(reply)` exported from `session.ts` and use it in all four places, so the pair has one owner.

- [ ] **Step 4: Run the suite and commit**

```bash
TEST_DATABASE_URL=postgres://ashu:ashu@localhost:5432/ashu pnpm exec vitest run --project @ashuworld/api
git add apps/api/src apps/api/test/session.test.ts
git commit -m "🔒 fix(api): never let a shared cache keep a personal response"
```

---

### Task 5: Remove the internal id from the public profile

**Files:**
- Modify: `packages/ledger/src/ladder.ts` (`PublicFanProfile`, `getFanByHandle`)
- Modify: `apps/web/src/api.ts` (`PublicFan`)
- Modify: `apps/api/test/public.test.ts:416`
- Test: `apps/api/test/public.test.ts`

**Interfaces:**
- `PublicFanProfile` becomes `{ handle, displayName, level, balance, peakXp, identities }`.

- [ ] **Step 1: Write the failing assertion**

```ts
it('does not publish the account id', async () => {
  const res = await app.inject({ method: 'GET', url: `/api/public/fans/${handle}` })
  expect(res.statusCode).toBe(200)
  expect(res.json()).not.toHaveProperty('id')
})
```

- [ ] **Step 2: Run it and watch it fail**

Expected: FAIL — `id` is present.

- [ ] **Step 3: Remove it**

Drop `id` from `PublicFanProfile`, from the object `getFanByHandle` returns, and from
`PublicFan` in `apps/web/src/api.ts`. Keep `FanRow.id` and the `select id, handle,
display_name`: the function still needs the id internally to read the standing and the
identity list. Update the full-object assertion at `apps/api/test/public.test.ts:416` to
omit `id`.

- [ ] **Step 4: Run both suites and commit**

```bash
TEST_DATABASE_URL=postgres://ashu:ashu@localhost:5432/ashu pnpm exec vitest run --project @ashuworld/api --project @ashuworld/web --project @ashuworld/ledger
git add packages/ledger/src/ladder.ts apps/web/src/api.ts apps/api/test/public.test.ts
git commit -m "🔒 fix(public): stop publishing the account identifier"
```

---

### Task 6: Immutable CI and images

**Files:**
- Modify: `.github/workflows/ci.yml`
- Modify: `docker/helm-check.Dockerfile`
- Modify: `compose.ci.yaml` (only if the digest form forces it)

- [ ] **Step 1: Pin every action to a commit SHA**

Resolve the current tag commits with `gh api repos/<owner>/<repo>/git/ref/tags/<tag>` and replace each `uses: owner/action@v7` with `uses: owner/action@<sha> # v7`. The actions are `actions/checkout`, `pnpm/action-setup`, `actions/setup-node`, `docker/setup-buildx-action`, `docker/login-action`, `docker/build-push-action`. `.github/dependabot.yml` already updates the `github-actions` ecosystem, so the comments are what keep it readable.

- [ ] **Step 2: Verify the Helm download and pin the check image**

For the Helm step, download `helm-v4.2.4-linux-amd64.tar.gz.sha256sum`, run `sha256sum -c`, then extract. For `docker/helm-check.Dockerfile`, replace `alpine/helm:latest` with `alpine/helm@sha256:<digest>` (get it with `docker buildx imagetools inspect alpine/helm:latest`).

- [ ] **Step 3: Add the audit step**

In the `verify` job, after `pnpm install --frozen-lockfile`:

```yaml
      - run: pnpm audit --prod --audit-level=high
```

Expected: PASS today (confirmed clean).

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/ci.yml docker/helm-check.Dockerfile compose.ci.yaml
git commit -m "🔒 chore(ci): pin actions, verify the Helm tarball and audit production deps"
```

---

## Branch 2 — `legal/compliance`

Cut from `develop` after Branch 1 merges.

### Task 7: Legal pages and the footer

**Files:**
- Create: `apps/web/src/legal/company.ts`
- Create: `apps/web/src/legal/content.ts`
- Create: `apps/web/src/components/Footer.tsx`
- Create: `apps/web/src/pages/Legal.tsx`
- Modify: `apps/web/src/App.tsx` (three routes, `<Footer />` in `Layout`)
- Modify: `apps/web/src/styles.css` (footer and legal prose)
- Test: `apps/web/test/legal.test.tsx`

**Interfaces:**
- Produces: `COMPANY`, `TERMS_VERSION`, `MENTIONS_LEGALES`, `CONFIDENTIALITE`, `CGU`, `LegalPage({ document })`.
- Consumes: nothing.

- [ ] **Step 1: Write the failing test**

```tsx
// apps/web/test/legal.test.tsx
import { screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import { render } from '@testing-library/react'
import { CGU, CONFIDENTIALITE, MENTIONS_LEGALES } from '../src/legal/content'
import { LegalPage } from '../src/pages/Legal'
import { Footer } from '../src/components/Footer'

function renderLegal(document: typeof CGU) {
  return render(
    <MemoryRouter>
      <LegalPage document={document} />
    </MemoryRouter>,
  )
}

describe('legal pages', () => {
  it('names the publisher and the host on the mentions légales', () => {
    renderLegal(MENTIONS_LEGALES)
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Mentions légales')
    expect(screen.getAllByText(/ASHU DEV/).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/898 442 538/).length).toBeGreaterThan(0)
    expect(screen.getByText(/14 rue Bausset/)).toBeInTheDocument()
    expect(screen.getAllByText(/info@ashudev\.com/).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/auto-hébergement/i).length).toBeGreaterThan(0)
  })

  it('states both cookies, their purpose and that there is no tracker', () => {
    renderLegal(CONFIDENTIALITE)
    expect(screen.getByText(/ashuworld_session/)).toBeInTheDocument()
    expect(screen.getByText(/ashu_oauth_state/)).toBeInTheDocument()
    expect(screen.getByText(/aucun traceur/i)).toBeInTheDocument()
  })

  it('says a level is never lost and a detach forfeits XP', () => {
    renderLegal(CGU)
    expect(screen.getByText(/niveau n’est jamais perdu|niveau n'est jamais perdu/i)).toBeInTheDocument()
    expect(screen.getByText(/détachement/i)).toBeInTheDocument()
  })

  it('links the three documents from the footer, on every page', () => {
    render(<MemoryRouter><Footer /></MemoryRouter>)
    expect(screen.getByRole('link', { name: 'Mentions légales' })).toHaveAttribute('href', '/mentions-legales')
    expect(screen.getByRole('link', { name: 'Politique de confidentialité' })).toHaveAttribute('href', '/confidentialite')
    expect(screen.getByRole('link', { name: 'CGU' })).toHaveAttribute('href', '/cgu')
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm exec vitest run --project @ashuworld/web apps/web/test/legal.test.tsx
```

Expected: FAIL — modules do not exist.

- [ ] **Step 3: Write the company module**

```ts
// apps/web/src/legal/company.ts
export const COMPANY = {
  name: 'ASHU DEV',
  legalForm: 'SARL (société à responsabilité limitée)',
  capital: '1 000 €',
  address: '14 rue Bausset, 75015 Paris, France',
  siren: '898 442 538',
  siret: '898 442 538 00010',
  rcs: 'RCS Paris 898 442 538',
  vat: 'FR 72 898 442 538',
  publicationDirector: 'Valentin Ronteix',
  email: 'info@ashudev.com',
  host: 'ASHU DEV (auto-hébergement sur infrastructure privée)',
} as const
```

- [ ] **Step 4: Write the content module**

```ts
// apps/web/src/legal/content.ts
export interface LegalSection {
  heading: string
  paragraphs: string[]
  list?: string[]
}

export interface LegalDocument {
  slug: string
  title: string
  description: string
  version: string
  updated: string
  sections: LegalSection[]
}

export const TERMS_VERSION = '2026-11-14'
```

Write three documents in French, using `COMPANY` for every fact:

- `MENTIONS_LEGALES`: éditeur, directeur de la publication, contact, RCS/SIREN/SIRET, TVA, capital, hébergeur, propriété intellectuelle, responsabilité, liens externes.
- `CONFIDENTIALITE`: responsable de traitement, finalités, bases légales, données, destinataires (none but the operator), absence de sous-traitant d'hébergement, absence de transfert hors UE, durées (3 ans d'inactivité, 30 jours pour les événements traités, 3 ans pour le journal d'audit, 30 jours pour les journaux applicatifs), droits (accès, rectification, effacement, opposition, portabilité, limitation), exercice par courriel, réclamation CNIL, cookies (les deux, avec durée et absence de traceur), sécurité, mineurs (15 ans, déclaration), consentement et sa version.
- `CGU`: objet, accès, compte et identités, règles de conduite, XP et niveaux (pas une monnaie, niveau jamais perdu, détachement = perte définitive), sanctions, disponibilité, responsabilité, propriété intellectuelle, droit applicable et juridiction.

The text must not promise anything the code does not do. Re-read the design's anti-goals before writing.

- [ ] **Step 5: Write the renderer, footer and routes**

`LegalPage` renders `<title>`, `<meta name="description">`, `<h1>`, the version and date,
then each section as `<section><h2>…</h2><p>…</p><ul>…</ul></section>`. React 19 hoists the
title and the meta tag into the document head.

`Footer` renders the company line and three `Link`s: Mentions légales, Confidentialité, CGU.

`App.tsx`: add `{ path: 'mentions-legales', element: <LegalPage document={MENTIONS_LEGALES} /> }`, and the two siblings; render `<Footer />` inside `Layout` after `<Outlet />`.

- [ ] **Step 6: Run the web suite and commit**

```bash
pnpm exec vitest run --project @ashuworld/web
git add apps/web/src apps/web/test/legal.test.tsx
git commit -m "📝 feat(web): mentions légales, politique de confidentialité and CGU"
```

---

### Task 8: Consent and the migration

**Files:**
- Create: `packages/ledger/migrations/0005_consent_retention_erasure.sql`
- Create: `packages/ledger/src/consent.ts`
- Modify: `packages/ledger/src/index.ts`
- Modify: `apps/api/src/auth/handshake.ts`
- Modify: `apps/api/src/routes/auth.ts`
- Modify: `apps/api/src/config.ts` (`ERASURE_PEPPER`)
- Test: `packages/ledger/test/consent.test.ts`, `apps/api/test/consent.test.ts`

**Interfaces:**
- Produces: `recordTermsAcceptance(tx, fanId, version): Promise<void>`, `touchLastSeen(tx, fanId): Promise<void>`, `TERMS_VERSION_PATTERN`.
- `startHandshake` input gains `termsVersion: string | null`; `Handshake` gains `termsVersion: string | null`.

- [ ] **Step 1: Write the migration**

```sql
-- 0005_consent_retention_erasure.sql
alter table fans
  add column terms_version text,
  add column terms_accepted_at timestamptz,
  add column last_seen_at timestamptz,
  add column erased_at timestamptz;

alter table oauth_handshakes add column terms_version text;

create index fans_inactive on fans ((coalesce(last_seen_at, created_at)))
  where erased_at is null;

create index provider_identities_never_linked on provider_identities (created_at)
  where first_linked_at is null;
```

- [ ] **Step 2: Write the failing ledger test**

```ts
it('records the acceptance once and never overwrites it', async () => {
  const { id } = await withTransaction(pool, (tx) =>
    createFan(tx, { handle: 'ada', displayName: 'Ada' }),
  )

  await withTransaction(pool, (tx) => recordTermsAcceptance(tx, id, '2026-11-14'))
  const first = await pool.query<{ terms_version: string }>(
    'select terms_version from fans where id = $1', [id],
  )

  await withTransaction(pool, (tx) => recordTermsAcceptance(tx, id, '2027-01-01'))
  const second = await pool.query<{ terms_version: string }>(
    'select terms_version from fans where id = $1', [id],
  )

  expect(first.rows[0]?.terms_version).toBe('2026-11-14')
  expect(second.rows[0]?.terms_version).toBe('2026-11-14')
})
```

- [ ] **Step 3: Implement and run**

`recordTermsAcceptance` is `update fans set terms_version = $2, terms_accepted_at = now() where id = $1 and terms_accepted_at is null`. `touchLastSeen` is `update fans set last_seen_at = now() where id = $1`.

```bash
TEST_DATABASE_URL=postgres://ashu:ashu@localhost:5432/ashu pnpm exec vitest run --project @ashuworld/ledger packages/ledger/test/consent.test.ts
```

- [ ] **Step 4: Write the failing API test**

```ts
it('refuses a login with no acceptance and creates no fan', async () => {
  const res = await app.inject({ method: 'GET', url: '/auth/dev/start?purpose=login&handle=ada' })
  expect(res.statusCode).toBe(400)
  expect(res.json().error.code).toBe('consent_required')
})

it('records the version and timestamp when the fan is created', async () => {
  // `startDev`, `stateOf` and `callback` already live in auth.test.ts. Extend `startDev`
  // with an `accept?: string` option that appends `accept` to the query string.
  const start = await startDev(app, { handle: 'ada', accept: '2026-11-14' })
  await callback(app, { state: stateOf(start), code: 'ada' })
  const row = await db.pool.query<{ terms_version: string; terms_accepted_at: Date }>(
    'select terms_version, terms_accepted_at from fans where handle = $1', ['ada'],
  )
  expect(row.rows[0]?.terms_version).toBe('2026-11-14')
  expect(row.rows[0]?.terms_accepted_at).toBeInstanceOf(Date)
})

it('records it for an existing fan whose acceptance is null at the next login', async () => {
  // Seed a fan and an attached identity; start and finish a login; terms_version is set.
})
```

- [ ] **Step 5: Implement the gate**

- `config.ts`: `ERASURE_PEPPER` required, trimmed; empty is a startup error naming it.
  Every api `testEnv` helper gains `ERASURE_PEPPER: 'test-pepper'`, and `config.test` gains
  the empty-value case.
- `startHandshake`: insert `terms_version` (null for `link`).
- `consumeHandshake`: select and return it.
- `/auth/:provider/start`: for `purpose === 'login'`, `accept` must match `^\d{4}-\d{2}-\d{2}(\.\d+)?$`; otherwise `400 consent_required` with the sentence "tu dois avoir 15 ans ou plus et accepter les CGU et la politique de confidentialité". For `link`, ignore it.
- `resolveLogin(deps, profile, termsVersion)`: after the fan is known and before the session, `recordTermsAcceptance(tx, fanId, termsVersion)` when `termsVersion !== null`, and `touchLastSeen(tx, fanId)`.
- Callback passes `handshake.termsVersion`.

- [ ] **Step 6: Run both suites and commit**

```bash
TEST_DATABASE_URL=postgres://ashu:ashu@localhost:5432/ashu \
  pnpm exec vitest run --project @ashuworld/ledger --project @ashuworld/api
git add packages/ledger apps/api
git commit -m "⚖️ feat: record the age and terms acceptance at sign-in"
```

---

### Task 9: Erasure in the ledger

**Files:**
- Create: `packages/ledger/src/privacy.ts`
- Modify: `packages/ledger/src/index.ts`
- Modify: `packages/ledger/src/ladder.ts` (exclude erased)
- Test: `packages/ledger/test/privacy.test.ts`

**Interfaces:**
- Produces: `erasedExternalId(pepper, provider, externalId): string`, `eraseFan(tx, { fanId, pepper })`, `eraseIdentity(tx, { identityId, pepper })`, `exportFan(tx, handle)`, `purgeBatch(pool, input)`, and the retention constants.
- Consumes: `withTransaction`, `requireTransaction`, `getStanding`.

- [ ] **Step 1: Write the failing tests**

```ts
it('erases the account without deleting a row or a one-time key', async () => {
  // Seed fan, identity, one earn, one session.
  const result = await withTransaction(pool, (tx) => eraseFan(tx, { fanId, pepper }))
  expect(result.identities).toBe(1)
  const fan = await pool.query('select handle, display_name, erased_at from fans where id = $1', [fanId])
  expect(fan.rows[0].handle).toMatch(/^deleted_[0-9a-f]{16}$/)
  expect(fan.rows[0].display_name).toBe('Compte supprimé')
  expect(fan.rows[0].erased_at).toBeInstanceOf(Date)
  expect((await pool.query('select 1 from sessions where fan_id = $1', [fanId])).rowCount).toBe(0)
  expect((await pool.query('select 1 from xp_entries where fan_id is null and identity_id is not null')).rowCount).toBe(1)
})

it('keeps the one-time key: re-linking the erased account pays nothing', async () => {
  // After eraseFan, attach the erased identity to a fresh fan and call awardOnce with the
  // same action key: expect awarded false, reason 'action_spent'.
})

it('removes the erased account from the public ladder and profile', async () => {
  // listLadder has no linked row and no freeStanding row for it; getFanByHandle returns null.
})

it('erases a never-linked identity from the ladder', async () => {
  // eraseIdentity then listLadder: the freeStanding row is gone.
})

it('dry-run reports without writing', async () => {
  const before = await counts()
  const result = await purgeBatch(pool, { pepper, dryRun: true, now: new Date() })
  expect(result.fans).toBeGreaterThan(0)
  expect(await counts()).toEqual(before)
})
```

- [ ] **Step 2: Run them and watch them fail**

Expected: FAIL — `privacy.js` does not exist.

- [ ] **Step 3: Implement**

```ts
export const ERASURE_PEPPER_ENV = 'ERASURE_PEPPER'
export const INACTIVE_FAN_RETENTION_DAYS = 1095
export const NEVER_LINKED_IDENTITY_RETENTION_DAYS = 1095
export const PROCESSED_EVENT_RETENTION_DAYS = 30
export const AUDIT_RETENTION_DAYS = 1095

export function erasedExternalId(pepper: string, provider: string, externalId: string): string {
  const digest = createHmac('sha256', pepper).update(`${provider}:${externalId}`).digest('hex')
  return `erased:${digest}`
}

export async function eraseFan(tx: Queryable, input: { fanId: string; pepper: string }): Promise<{ identities: number }>
export async function eraseIdentity(tx: Queryable, input: { identityId: string; pepper: string }): Promise<{ forfeitedEntries: number }>
export async function exportFan(tx: Queryable, handle: string): Promise<unknown | null>
export async function purgeBatch(pool: Pool, input: { pepper: string; dryRun: boolean; now?: Date; limit?: number }): Promise<{ fans: number; identities: number; events: number; audit: number }>
```

Implementation notes that the tests do not determine:

- `eraseFan` must call `requireTransaction`. Order: anonymise the fan, detach and hash every identity, forfeit every live earn on those identities, delete the sessions.
- The erasure writes one `audit_log` row with `kind = 'erase'`, `fan_id = null`, `actor_fan_id = null` and counts only, so the trail cannot re-identify the person.
- The handle is `'deleted_' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 16)` — exactly 24 characters, which the schema's check allows.
- The identity update is `external_id = $2, display_handle = 'Compte supprimé', fan_id = null, linked_at = null`, and it never touches `first_linked_at`.
- `eraseIdentity` refuses a still-attached identity (`fan_id is not null`) with a named error: an attached identity is erased through its fan, so the two commands cannot disagree.
- `purgeBatch` runs one transaction: delete processed events older than 30 days, delete audit rows older than 3 years, select up to `limit` (default 100) inactive fans and never-linked identities, erase each through the same helpers, and count. `dryRun` selects and counts only.
- `exportFan` returns the fan, standing, identities and entries, or `null` for an unknown handle.

- [ ] **Step 4: Exclude erased accounts from the public reads**

In `listLadder`, add `where f.erased_at is null` to the linked query and `and i.external_id not like 'erased:%'` to the free-standing predicate. In `getFanByHandle`, add `and erased_at is null` to the select.

- [ ] **Step 5: Run the suite and commit**

```bash
TEST_DATABASE_URL=postgres://ashu:ashu@localhost:5432/ashu pnpm exec vitest run --project @ashuworld/ledger
git add packages/ledger
git commit -m "⚖️ feat(ledger): anonymising erasure that keeps the one-time keys"
```

---

### Task 10: A returning erased account starts over

**Files:**
- Modify: `packages/ledger/src/identity.ts` (`findIdentityForLogin`)
- Modify: `packages/ledger/src/index.ts`
- Modify: `apps/api/src/routes/auth.ts` (`resolveLogin`)
- Test: `packages/ledger/test/privacy.test.ts`, `apps/api/test/auth.test.ts`

**Interfaces:**
- Produces: `findIdentityForLogin(tx, { provider, externalId, pepper }): Promise<IdentityRef | null>`.
- Consumes: `erasedExternalId` from Task 9.

- [ ] **Step 1: Write the failing test**

```ts
it('signs in an erased provider account as a new fan at zero, keys still spent', async () => {
  // Seed fan A + identity I + earn (twitch.follow). eraseFan(A).
  // Run a full dev login as the same external id.
  // Expect: a new fan with handle derived from the profile, balance 0, level 0;
  //         identity I has fan_id = new fan and first_linked_at still set;
  //         awardOnce(I, 'twitch.follow') answers awarded false, reason 'action_spent'.
})
```

- [ ] **Step 2: Run it and watch it fail**

Expected: FAIL — a second identity row is created and a second bonus is paid.

- [ ] **Step 3: Implement the lookup**

```ts
export async function findIdentityForLogin(
  tx: Queryable,
  input: { provider: ProviderName; externalId: string; pepper: string },
): Promise<IdentityRef | null>
```

It selects `id` where `(provider, external_id)` matches the raw value first, then the value returned by `erasedExternalId`. It never inserts.

- [ ] **Step 4: Branch `resolveLogin`**

```ts
const erased = await findIdentityForLogin(tx, {
  provider: profile.provider,
  externalId: profile.externalId,
  pepper: deps.env.ERASURE_PEPPER,
})
const identityId = erased?.id ?? (await ensureIdentity(tx, profile)).id

const { rows } = await tx.query<{ fan_id: string | null; first_linked_at: Date | null; external_id: string }>(
  `select fan_id, first_linked_at, external_id from provider_identities where id = $1 for update`,
  [identityId],
)
```

Decision table after the lock:

- `fan_id !== null` → session for that fan.
- `fan_id === null` and `external_id` does **not** start with `erased:` → `{ kind: 'reattach' }`.
- `fan_id === null` and `external_id` starts with `erased:` → create a fan with a handle derived from the current profile, link the identity, record acceptance, session.

Update the identity's `display_handle` to the current profile handle as part of the link (the person is signing in again; the display handle is live personal data they just supplied).

- [ ] **Step 5: Run the suites and commit**

```bash
TEST_DATABASE_URL=postgres://ashu:ashu@localhost:5432/ashu \
  pnpm exec vitest run --project @ashuworld/ledger --project @ashuworld/api
git add packages/ledger apps/api
git commit -m "⚖️ feat(auth): an erased account can start over without a second payment"
```

---

### Task 11: The rights CLI

**Files:**
- Modify: `apps/worker/src/cli.ts`
- Modify: `apps/worker/src/index.ts` (`ERASURE_PEPPER` load)
- Test: `apps/worker/test/privacy-cli.test.ts`

**Interfaces:**
- Consumes: `exportFan`, `eraseFan`, `eraseIdentity`, `purgeBatch`, `ERASURE_PEPPER_ENV` from the ledger.
- Produces: exit codes 0/1 and one line per command.

- [ ] **Step 1: Write the failing tests**

```ts
it('export-fan prints one JSON document with the account and its entries', async () => {
  const out: string[] = []
  expect(await runCli(['export-fan', 'ada'], { pool, processors, out: (l) => out.push(l) })).toBe(0)
  const doc = JSON.parse(out.join('\n'))
  expect(doc.handle).toBe('ada')
  expect(Array.isArray(doc.entries)).toBe(true)
})

it('erase-fan refuses without the pepper and erases with it', async () => {
  // unset ERASURE_PEPPER -> 1 and nothing changed
  // set it -> 0, handle starts with deleted_, ladder no longer lists the fan
})

it('erase-identity refuses a still-attached identity', async () => {
  expect(await runCli(['erase-identity', 'twitch', 'ada'], deps)).toBe(1)
})

it('purge --dry-run writes nothing and is idempotent when run for real twice', async () => {
  // seed an inactive fan and an old processed event
  // dry-run: exit 0, rows still there
  // real run: rows gone, second run reports zeros
})
```

The purge tests arm `PURGE_CONFIRM` with the same saved-environment pattern the reset
tests already use in `cli.test.ts`.

- [ ] **Step 2: Run and watch fail**

Expected: FAIL — unknown argument.

- [ ] **Step 3: Implement the dispatch**

Add three branches before the unknown-argument refusal, in the existing explicit style (`argv.length` checks, one refusal line, no `--force`):

- `export-fan <handle>` → `withTransaction(pool, (tx) => exportFan(tx, handle))`; print `JSON.stringify(doc, null, 2)`; unknown handle is exit 1 with "no account has that handle".
- `erase-fan <handle>` → resolve the handle to an id, then `withTransaction(pool, (tx) => eraseFan(tx, { fanId, pepper }))`; print the counts.
- `erase-identity <provider> <handle>` → find the identity by `provider` and `display_handle`; zero rows is exit 1, more than one is exit 1 listing the ids, one is erased.
- `purge [--dry-run]` → requires `PURGE_CONFIRM=purge-ashuworld`; loops `purgeBatch` until `fans + identities === 0`; prints each batch's counts.

`ERASURE_PEPPER` is read through a `loadPepper()` helper that names the variable and refuses empty. `PURGE_CONFIRM` mirrors `ALPHA_RESET_CONFIRM` with its own constant pair.

- [ ] **Step 4: Run the suite and commit**

```bash
TEST_DATABASE_URL=postgres://ashu:ashu@localhost:5432/ashu pnpm exec vitest run --project @ashuworld/worker
git add apps/worker
git commit -m "⚖️ feat(worker): export-fan, erase-fan, erase-identity and purge"
```

---

### Task 12: Deployment of the pepper and the purge

**Files:**
- Modify: `deploy/helm/ashuworld/values.yaml`
- Modify: `deploy/helm/ashuworld/templates/_helpers.tpl` (`ashuworld.erasurePepperEnv`)
- Modify: `deploy/helm/ashuworld/templates/api.yaml`, `worker.yaml` (env)
- Create: `deploy/helm/ashuworld/templates/purge-cronjob.yaml`
- Modify: `deploy/helm/ashuworld/templates/secret.yaml` (purge confirm)
- Modify: `deploy/helm/ashuworld/test/render.sh`
- Modify: `compose.yaml`, `compose.dev.yaml`
- Modify: `apps/api/src/config.ts` tests' `testEnv` (already in Task 1)

- [ ] **Step 1: Add the failing render assertions**

```bash
test "$(grep -c 'kind: CronJob' <<<"$default_out")" -eq 0 || fail "purge CronJob rendered without purge.enabled"
purge_out="$(render --set purge.enabled=true)"
grep -q 'kind: CronJob' <<<"$purge_out" || fail "purge CronJob missing when purge.enabled=true"
grep -q 'ERASURE_PEPPER' <<<"$purge_out" || fail "purge has no pepper"
grep -q 'PURGE_CONFIRM' <<<"$purge_out" || fail "purge is not armed"
```

- [ ] **Step 2: Run it and watch it fail**

```bash
bash deploy/helm/ashuworld/test/render.sh
```

Expected: FAIL — no CronJob.

- [ ] **Step 3: Implement**

- `values.yaml`: add `erasure: { pepperSecretName: ashuworld-erasure, pepperKey: pepper }` and `purge: { enabled: false, schedule: "17 3 * * *", confirm: purge-ashuworld, secretName: "" }`.
- `_helpers.tpl`: one `secretKeyRef` helper for `ERASURE_PEPPER`, used by the api Deployment, the worker Deployment and the CronJob.
- `purge-cronjob.yaml`: gated by `purge.enabled`, `concurrencyPolicy: Forbid`, `restartPolicy: OnFailure`, the same hardened `securityContext` as the other jobs, command `["node", "dist/worker.js", "purge"]`, env from `databaseUrlEnv`, the pepper, `PURGE_CONFIRM` from a Secret, and `GAME_CONFIG_VERSION`.
- `secret.yaml`: render the purge confirm Secret when `purge.enabled` and no `secretName` is given, exactly as the reset does.
- `compose.yaml` and `compose.dev.yaml`: `ERASURE_PEPPER: dev-pepper-not-a-secret` on api and worker. Never a production value; the comment says so.

- [ ] **Step 4: Run the chart check and commit**

```bash
bash deploy/helm/ashuworld/test/render.sh
helm lint deploy/helm/ashuworld
git add deploy compose.yaml compose.dev.yaml
git commit -m "🔧 chore(deploy): erasure pepper and the daily purge"
```

---

### Task 13: The compliance documents

**Files:**
- Create: `docs/legal/registre-des-traitements.md`
- Create: `docs/legal/runbook-droits.md`
- Create: `docs/legal/conformite.md`

- [ ] **Step 1: Write the register**

One processing operation, in French: nom, responsable (`ASHU DEV`), finalité (comptes Dachi, XP, classement public), base légale (exécution du contrat pour le compte ; intérêt légitime pour le classement et la prévention de la double attribution), catégories de données, personnes concernées, destinataires (aucun), sous-traitants (aucun ; auto-hébergement), transferts (aucun), durées, mesures de sécurité, date de mise à jour.

- [ ] **Step 2: Write the runbook**

Procedure for an access or erasure request: who may ask, identity check (session, provider challenge, or a message from the provider account), the exact commands (`export-fan`, `erase-fan`, `erase-identity`), the one-month deadline and the extension, what to log and what not to log, and the escalation to the CNIL if the request is refused.

- [ ] **Step 3: Write the compliance map**

A table: obligation → where satisfied (file or route) → owner. At minimum: LCEN mentions légales, RGPD information, consent age, access, erasure, retention, security, cookies, register, breach notification (72 h to the CNIL), and the annual review.

- [ ] **Step 4: Commit**

```bash
git add docs/legal
git commit -m "📝 docs(legal): register, rights runbook and compliance map"
```

---

## Branch 3 — `docs/alignment`

### Task 14: README, CONTRIBUTING and SECURITY

**Files:**
- Modify: `README.md`, `CONTRIBUTING.md`, `SECURITY.md`

- [ ] **Step 1: Fix the facts**

- Replace every `55432` with `5432` in `README.md`, `CONTRIBUTING.md`, `apps/api/test/server.test.ts` and `packages/ledger/testing/index.ts`.
- Add to README: the three legal routes, the new env vars (`ERASURE_PEPPER`, the five `RATE_LIMIT_*`), the four worker commands, the purge CronJob, and an index linking the design, the plan and `docs/legal/`.
- CONTRIBUTING: add "user-facing legal text is product copy: changing it bumps `TERMS_VERSION` and the notice's version", and two non-negotiables: acceptance recorded at sign-in, erasure anonymises and never deletes a key.
- SECURITY.md: move rate limiting from "out of scope" to "in scope"; add the legal contact and say a failed erasure is a data-protection incident.

- [ ] **Step 2: Verify no stale value remains**

```bash
grep -rn "55432" --include='*.md' --include='*.ts' . | grep -v node_modules
```

Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add README.md CONTRIBUTING.md SECURITY.md apps/api/test/server.test.ts packages/ledger/testing/index.ts
git commit -m "📝 docs: align the README, contributing and security policy with the code"
```

---

### Task 15: Changelog, chart metadata and design banners

**Files:**
- Modify: `CHANGELOG.md`, `deploy/helm/ashuworld/Chart.yaml`, `deploy/helm/ashuworld/values.yaml`
- Modify: `docs/superpowers/plans/2026-11-14-ashuworld-foundation.md`
- Modify: `docs/superpowers/specs/2026-11-14-ashuworld-fan-xp-design.md`

- [ ] **Step 1: Fix the changelog**

Move the platform adapters and operator tools from `### Added` to a new `### Planned` note, worded as not yet built. Add the three branches under `[Unreleased]` → `### Added` (security headers, rate limits, legal pages, consent, erasure, CLI) and `### Changed` (public profile no longer publishes an id). Do not invent a version number or a date.

- [ ] **Step 2: Fix the chart metadata**

`Chart.yaml`: `home: https://github.com/vyrtualsynthese/ashuworld`, the same in `sources`. `values.yaml`: the three image repositories become `ghcr.io/vyrtualsynthese/ashuworld/{api,web,worker}`.

- [ ] **Step 3: Add the status banners**

- Foundation plan, first line under the title: `> Status: historical. Implemented in 0.1.0; kept as the record of the build order.`
- Game design, first line under the title: `> Status: approved. The access, legal and documentation decisions live in 2026-11-14-hardening-and-compliance-design.md.`
- In the game design's "Who is an admin" section, remove the `admin_identities` sentence and add `Admin tooling is not implemented; it belongs to a later milestone.`
- In the foundation plan, note that `@fastify/static` was never added and the web is served by nginx.

- [ ] **Step 4: Verify and commit**

```bash
grep -rn "your-org" deploy .github --include='*.yaml' --include='*.yml'
```

Expected: no output.

```bash
git add CHANGELOG.md deploy/helm/ashuworld/Chart.yaml deploy/helm/ashuworld/values.yaml docs/superpowers
git commit -m "📝 docs: make the changelog and the design record tell the truth"
```

---

## Branch 4 — `refactor/quality`

### Task 16: One name for the retry bound

**Files:**
- Modify: `apps/worker/src/loop.ts`
- Test: `apps/worker/test/loop.test.ts` (existing test at line 169 already pins the behaviour)

- [ ] **Step 1: Export the constant and use it**

```ts
export const MAX_EVENT_ATTEMPTS = 5
```

Use `${MAX_EVENT_ATTEMPTS}` in the claim SQL, in the log line, and in the comment that names five failures. The existing test "stops claiming a poison event after five failures" must still pass unchanged; if it imports the literal, change it to the constant.

- [ ] **Step 2: Run the worker suite and commit**

```bash
TEST_DATABASE_URL=postgres://ashu:ashu@localhost:5432/ashu pnpm exec vitest run --project @ashuworld/worker
git add apps/worker
git commit -m "♻️ refactor(worker): name the retry bound once"
```

---

### Task 17: Pool timeouts

**Files:**
- Modify: `packages/ledger/src/db.ts`
- Test: `packages/ledger/test/db.test.ts`

**Interfaces:**
- `createPool(url: string): Pool` keeps its signature; the options gain `max`, `connectionTimeoutMillis` and `idleTimeoutMillis`, defined as exported constants.

- [ ] **Step 1: Write the failing test**

```ts
it('bounds connection wait and idle lifetime instead of queueing forever', () => {
  const pool = createPool(testDatabaseUrl())
  try {
    expect(pool.options.max).toBe(POOL_MAX_CLIENTS)
    expect(pool.options.connectionTimeoutMillis).toBe(POOL_CONNECT_TIMEOUT_MS)
    expect(pool.options.idleTimeoutMillis).toBe(POOL_IDLE_TIMEOUT_MS)
  } finally {
    void pool.end()
  }
})
```

- [ ] **Step 2: Implement**

```ts
export const POOL_MAX_CLIENTS = 10
export const POOL_CONNECT_TIMEOUT_MS = 5_000
export const POOL_IDLE_TIMEOUT_MS = 30_000

export function createPool(url: string): Pool {
  const pool = new pg.Pool({
    connectionString: url,
    max: POOL_MAX_CLIENTS,
    connectionTimeoutMillis: POOL_CONNECT_TIMEOUT_MS,
    idleTimeoutMillis: POOL_IDLE_TIMEOUT_MS,
  })
  attachIdleErrorHandler(pool)
  return pool
}
```

Do not add a pool-level `statement_timeout`: it would apply to the long `purge` and `migrate` statements as well. The health route already sets a transaction-local one.

- [ ] **Step 3: Run and commit**

```bash
TEST_DATABASE_URL=postgres://ashu:ashu@localhost:5432/ashu pnpm exec vitest run --project @ashuworld/ledger
git add packages/ledger
git commit -m "♻️ refactor(ledger): bound pool waits with named constants"
```

---

### Task 18: The web imports the provider names

**Files:**
- Modify: `apps/web/package.json` (add `@ashuworld/providers`)
- Modify: `apps/web/src/providers.ts`
- Test: `apps/web/test/support.test.ts` and `apps/web/test/pages.test.tsx` must keep passing

**Interfaces:**
- `apps/web/src/providers.ts` re-exports `ProviderName` and `isProviderName` from `@ashuworld/providers` and keeps only `PROVIDERS`, `LINKABLE_PROVIDERS`, `LABELS`, `providerLabel`.

- [ ] **Step 1: Add the workspace dependency**

```bash
pnpm --filter @ashuworld/web add @ashuworld/providers@workspace:*
```

- [ ] **Step 2: Replace the copy**

```ts
import { isProviderName, type ProviderName } from '@ashuworld/providers'
export { isProviderName, type ProviderName }

export const PROVIDERS = ['twitch', 'youtube', 'discord', 'dev'] as const
```

`packages/providers` is pure names and a type guard; it imports nothing. The old comment claiming the bundle would pull in server code was wrong and goes with the copy. Keep `PROVIDERS` if a runtime array is still needed; otherwise delete it and its only user.

- [ ] **Step 3: Run the web suite and the build**

```bash
pnpm exec vitest run --project @ashuworld/web
pnpm --filter @ashuworld/web build
```

Expected: PASS, and the build resolves the workspace package.

- [ ] **Step 4: Commit**

```bash
git add apps/web/package.json pnpm-lock.yaml apps/web/src/providers.ts
git commit -m "♻️ refactor(web): share the provider names instead of copying them"
```

---

## Verification

- [ ] `bash scripts/check.sh` green on the final branch.
- [ ] `pnpm audit --prod --audit-level=high` clean.
- [ ] `bash deploy/helm/ashuworld/test/render.sh` and `helm lint deploy/helm/ashuworld` green with `purge.enabled=true` and `false`.
- [ ] The web image smoke step sees the four headers.
- [ ] The legal pages read end to end by the operator.
- [ ] A manual erasure on the local stack: `erase-fan`, then `listLadder` shows nothing, then a dev login as the same handle pays no bonus.
