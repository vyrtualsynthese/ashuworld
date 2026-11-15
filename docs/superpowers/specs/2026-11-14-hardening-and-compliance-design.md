# AshuWorld — hardening, legal compliance and documentation alignment

Status: approved 2026-11-14. Alpha; the data is still expected to be wiped before launch. The
security, legal and documentation branches are implemented; the refactor branch is the last one.

This design sits beside the game design in
[`2026-11-14-ashuworld-fan-xp-design.md`](2026-11-14-ashuworld-fan-xp-design.md). That one
decides what the game does. This one decides what the site must satisfy before it can face
the public in France, and how the code around the ledger is hardened.

## Intent

The ledger and its guards are in good shape: strict TypeScript, the game rules enforced by
SQL constraints, an 80% coverage gate, and comments that explain why each guard exists.
`pnpm typecheck` and `pnpm lint` are green at the commit this design starts from.

What is missing is everything that surrounds the ledger:

- **The site has no legal pages.** There is no mentions légales (the page naming who
  publishes the site), no politique de confidentialité (privacy notice) and no CGU (terms of
  use). The ladder and the profiles publish handles, provider accounts and XP — personal
  data — without telling anyone what is collected, why, for how long, or how to get it
  removed.
- **There is no way to answer a rights request.** The RGPD (the EU data-protection
  regulation) gives a person the right to see their data and to have it erased. The code can
  do neither, and the ledger's "earns are never deleted" promise looks like it forbids the
  second.
- **The HTTP edges are thin.** No security headers, no rate limit on sign-in, session
  responses that a proxy could cache, and an internal identifier on the public profile.
- **The docs have drifted** from the code they describe.

Why now: the legal pages and the erasure path are the two things that cannot be added
after a public launch without having broken the law in the meantime. The rest is cheaper to
do while the tree is small.

## Goals

- A public deployment that a French visitor can use lawfully: the three legal documents,
  a processing register (registre des traitements, the RGPD article 30 record), a
  documented retention period, and a working way to answer access and erasure requests.
- The only cookies are the two strictly necessary ones, and the notice says so — no consent
  banner, because there is nothing to consent to.
- A visitor under 15 is refused at sign-in, and the refusal is recorded as a self
  declaration (no identity document, no birth date stored).
- Security headers, a rate limit, `no-store` on session responses, and no unnecessary
  identifier in a public payload.
- CI and images pinned to immutable references.
- Documentation that describes the shipped system, with one source per fact.

## Non-goals

- An admin UI, a payment flow, analytics, marketing cookies or a third-party tracker.
- Real age verification: no ID upload, no birth date, no parental-consent collection
  workflow. At this scale a self declaration is the proportionate answer; the privacy
  notice says what is stored (the acceptance, not the age).
- A rewrite of the ledger, or any change to a game rule. The XP rules stay exactly as the
  game design states them.
- A DPO (data protection officer) appointment, a CNIL certification or a binding corporate
  rules filing. None is required for a single small processing operation.
- NetworkPolicy, PodDisruptionBudget, autoscaling or a WAF. Those belong to the cluster.
- Internationalisation: the site and the legal text are French only.

## Anti-goals

- **A legal page that promises something the code does not do.** If the notice says
  "erased", the erasure must work. Three early bugs were copy that implied re-attaching
  recovers forfeited XP; legal text that lies is the same defect with a worse consequence.
- **An erasure that deletes the one-time keys.** Deleting `xp_entries` rows would let a
  detached account re-earn on re-link, which is the exact anti-goal the ledger exists to
  prevent. Erasure must anonymise, not truncate.
- **A rate limit that locks out a real audience.** A stream audience can share one carrier
  NAT address; a tight per-IP limit on the ladder would 429 a crowd. Limits on sign-in are
  strict, on public reads generous, and both are configurable.
- **Headers that break the app or the sign-in redirect.** The CSP is tested against the
  built bundle, not assumed.
- **Two copies of a legal fact.** The company details live in one module; the docs point at
  it rather than repeat it.
- **A purge that runs on a promise.** Retention needs a command and a schedule, not a
  sentence.

## Constraints

- The delivery shape chosen in conversation: four short branches, one pull request each, in
  this order — security, legal, documentation, refactor — each cut from `develop` and
  mutually rebased.
- No new runtime dependency unless it replaces hand-written security code. Two are in
  scope: `@fastify/helmet` (headers) and `@fastify/rate-limit` (limits). Both are the
  established Fastify plugins and are maintained with Fastify itself.
- The site is French. Legal text is French; code, comments and this document are English,
  like the rest of the repository.
- Company facts, from the public company register (annuaire des entreprises):

  | Field | Value |
  |---|---|
  | Raison sociale | ASHU DEV |
  | Forme juridique | SARL (société à responsabilité limitée) |
  | SIREN / SIRET | 898 442 538 / 898 442 538 00010 |
  | Siège social | 14 rue Bausset, 75015 Paris, France |
  | RCS | RCS Paris 898 442 538 |
  | TVA intracommunautaire | FR 72 898 442 538 |
  | Activité (NAF) | 62.01Z — programmation informatique |
  | Représentant légal / directeur de publication | Valentin Ronteix |
  | Capital social | 1 000 € |
  | Hébergeur | ASHU DEV, auto-hébergement sur infrastructure privée, 14 rue Bausset, 75015 Paris — info@ashudev.com |
  | Contact | info@ashudev.com |

  Nothing is missing. The site runs on the operator's own hardware, so the hébergeur is the
  publisher: the mentions légales name ASHU DEV and its siège rather than a third-party
  host, and the privacy notice declares no hosting sub-processor. The machine's physical
  address is not published; the company address is, and that is the address that answers
  for the data.

## Approaches

### Delivery shape

**A — one branch, four commits.** Rejected. The security headers can break sign-in; that
change should not share a review with prose about the RGPD.

**B — four branches, one PR each (chosen).** Each review is about one thing, and the
documentation lands last, describing the finished state.

**C — report only.** Rejected in conversation: the legal pages and the erasure path need
code, not a memo.

### Where the legal pages live

**A — static HTML served by nginx.** Rejected. It duplicates the layout and the navigation,
and the site already has one router and one stylesheet.

**B — React routes plus one content module (chosen).** Three routes rendered from a single
structured content module, with the company facts in a separate module. One copy of the
text, one place to change a version. A crawler that does not run JavaScript is the one
cost; the pages are also linked from the footer and the README, and the content module can
be exported later if a static copy is needed.

**C — a hosted legal-page service.** Rejected. It adds a sub-processor (another company
that handles data on our behalf), a possible transfer outside the EU and a dependency for
text that changes twice a year.

## Decided design

### Branch 1 — `security/hardening`

**API headers (`@fastify/helmet`).** The API answers JSON only, so its policy is
`default-src 'none'; frame-ancestors 'none'`, with `X-Content-Type-Options: nosniff`,
`Referrer-Policy: no-referrer`, `Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Resource-Policy: same-origin`. `X-Powered-By` is removed. The policy is
registered once, in `buildServer`, so no route can opt out.

**Web headers (nginx).** The SPA needs a policy that allows its own bundle and stylesheet
and nothing else:

```
default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:;
font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self';
form-action 'self'
```

Plus `Strict-Transport-Security: max-age=31536000; includeSubDomains` (browsers ignore it
over plain HTTP, so the local stack is unaffected), `X-Content-Type-Options: nosniff`,
`Referrer-Policy: strict-origin-when-cross-origin` and a minimal `Permissions-Policy`.
If the Vite build emits an inline script or style, the policy gets a hash for it — never
`unsafe-inline`.

**Rate limit (`@fastify/rate-limit`).** Three buckets, keyed by `request.ip` (which already
follows `TRUST_PROXY`):

| Scope | Default | Why |
|---|---|---|
| `/auth/*` | 20 per minute, per route (start, callback, logout each have their own counter) | A sign-in is a browser redirect, not polling; this stops a script from burning handshakes. |
| detach | 10 / minute | A destructive write a human does once. |
| `/api/public/*` | 120 / minute | Generous enough for a crowd behind one NAT; still bounds scraping. |

Configured by `RATE_LIMIT_ENABLED` (default true), `RATE_LIMIT_WINDOW_MS` and the three
per-scope ceilings `RATE_LIMIT_PUBLIC_MAX`, `RATE_LIMIT_AUTH_MAX` and `RATE_LIMIT_WRITE_MAX`, so
a problematic address can be relieved without a rebuild. A refusal
uses the existing error envelope with code `rate_limited` and status 429. The store is
in-memory: with several replicas each pod has its own counter. That is documented as the
alpha trade-off; a shared store (Redis) is what a multi-replica deployment would need.

**`no-store` on anything personal.** `requireFan` sets `Cache-Control: no-store` and
`Vary: Cookie` before any handler runs, and the sign-in routes do the same. The public
routes keep their 15-second shared cache.

**No internal identifier in a public payload.** `PublicFanProfile.id` and the web's
`PublicFan.id` are removed. Nothing renders it; a public page has no reason to publish a
database identifier. The design document promises level, peak XP, balance and badges — not
an id — so this narrows the contract to what was promised.

**Supply chain.** GitHub Actions are pinned to commit SHAs with the tag in a trailing
comment; `alpine/helm` is pinned by digest; the Helm tarball is checked against the
published `.sha256sum` before it is installed; and `pnpm audit --prod --audit-level=high`
runs in `verify`.

**Verification.** API header and 429 assertions in the existing route tests. The web headers
are asserted by extending the image smoke job: start the web image, `curl -I /`, and grep
the four headers. `scripts/check.sh` stays the local mirror.

### Branch 2 — `legal/compliance`

**Company facts, one source.** `apps/web/src/legal/company.ts` exports the table above plus
the two facts still to be supplied. `apps/web/src/legal/content.ts` holds the three
documents as structured sections, so the page and any future export read one copy.

**Three routes**, linked from a footer on every page:

- `/mentions-legales` — éditeur, forme juridique, capital, siège, RCS, TVA, contact,
  directeur de la publication, hébergeur, propriété intellectuelle, responsabilité.
- `/confidentialite` — responsable de traitement, finalités, bases légales, données
  collectées, destinataires et sous-traitants, transferts hors UE, durées, droits et
  comment les exercer, réclamation auprès de la CNIL, cookies, sécurité, mineurs.
- `/cgu` — objet, accès, compte et identités rattachées, règles de conduite, XP et niveaux
  (not a currency; a level is never lost; a detach forfeits), sanctions, disponibilité,
  responsabilité, propriété intellectuelle, droit applicable.

Each page sets its own `<title>` and `<meta name="description">` through React 19's
document metadata.

**Cookies.** Two, both strictly necessary, so no consent is required: `ashuworld_session`
(the session, `HttpOnly`, 30 days) and `ashu_oauth_state` (binds a sign-in handshake to the
browser that started it, 10 minutes). The notice names both, their purpose and their
lifetime, and states that there is no tracker. A consent banner would be theatre over a
cookie wall that does not exist.

**Hosting.** The site is self-hosted, so the notice declares no hosting sub-processor and
no transfer outside the EU. The data sits on the operator's own hardware in France, and the
notice says so in one sentence; the processing register records it the same way.

**Age and acceptance.** One migration adds to `fans`:

```sql
terms_version    text,
terms_accepted_at timestamptz,
last_seen_at      timestamptz,
erased_at         timestamptz
```

The sign-in panel requires a checkbox — "J'ai 15 ans ou plus et j'accepte les CGU et la
politique de confidentialité" — and appends `?accept=<terms version>` to the login start
URL. The start route refuses a login without it (400, `consent_required`). The callback is
the one writer: it records the version and timestamp whenever the resolved fan has no
acceptance yet, whether that fan is new or already existed. There is no account-page
notice and no second endpoint. The age itself is not stored: the declaration is the record,
which is the data-minimising choice.

A `link` start does not require the parameter, because it runs behind a session whose fan
accepted at sign-in. A session that predates this change keeps working until it expires,
and its fan accepts at the next login.

**Erasure (right to be forgotten).** One ledger function, `eraseFan(tx, fanId)`, used by
the CLI and by the retention purge:

1. anonymise the account: handle becomes `deleted_<random>`, display name becomes
   "Compte supprimé", `erased_at` is stamped;
2. delete the fan's sessions;
3. detach every identity (`fan_id` and `linked_at` null) and replace
   `external_id` with `erased:<HMAC(pepper, external_id)>`, clearing `display_handle`;
4. mark every live earn `forfeited_at`;
5. keep the `xp_entries` rows, because the one-time keys live in them.

The result is not personal data: no handle, no display name, no provider account, and the
provider id is only recoverable with the server-side pepper (`ERASURE_PEPPER`, a Secret in
the chart). Keeping the rows preserves the CONTRIBUTING rule "rows are never deleted" and
the anti-goal "a one-time action never pays twice". Excluding `erased_at` from the ladder
and the profile is what removes the account from public view.

**A returning erased account.** When a provider account that was erased signs in again, the
sign-in path looks it up by HMAC once the raw `(provider, external_id)` matches nothing. A
match means the person is recognised as an erased identity, and the decided behaviour is to
let them start over:

- a new fan is created at 0 XP with a handle derived from the provider's current display
  handle, because the old handle was overwritten by the erasure;
- the erased identity is attached to it, which keeps `first_linked_at` and every forfeit,
  so it has no free-standing life on the ladder and nothing is paid a second time;
- the callback records a fresh acceptance, because the erased account's acceptance went
  with the old fan.

The privacy notice carries one sentence saying the pseudonym is kept for this purpose, and
names the interest it serves: preventing a second payment and keeping the two accounts from
being merged by accident. That is the only personal data the erasure retains, and it is
pseudonymous by construction.

**Never-linked identities.** The ladder also publishes provider accounts that never belonged
to a fan. They have no account, no session and no sign-in, so `eraseFan` cannot reach them
and the "three years after the last sign-in" clock never starts. They are covered
explicitly:

- `erase-identity <provider> <display_handle>` anonymises one identity row: `external_id`
  becomes its HMAC, `display_handle` becomes "Compte supprimé", live earns are forfeited,
  and the row leaves the ladder because the public query already hides an identity with no
  live earn.
- The retention clock for a never-linked identity starts at its `created_at`; the daily
  `purge` anonymises it after three years. A free-standing identity that never earned is
  not published at all.
- The runbook's identity check for a person with no account is a provider-side proof sent
  to info@ashudev.com (a message from the account, or a code placed in its profile). The
  operator records the request and runs the command.

Both commands call one shared helper that takes a set of identity ids, so `eraseFan` and
`erase-identity` cannot drift.

**Access (right of access).** `export-fan <handle>` prints one JSON document: the account,
its standing, its attached identities and its entries. A never-linked identity has no
account to export; the operator answers from the same identity row. In both cases the
operator sends the answer after checking that the requester controls the account (a
signed-in session, a provider challenge, or a message from the provider account).

**Retention.**

| Data | Period | Mechanism |
|---|---|---|
| Account, identities, XP entries | while the account is used, then 3 years after the last sign-in | `purge` |
| Never-linked identities | 3 years from first sight | `purge` |
| Sessions | 30 days (already) | expiry in the query |
| Processed inbound event payloads | 30 days | `purge` |
| Audit log | 3 years | `purge` |
| Application logs | 30 days | cluster log pipeline, documented |

`purge` needs a confirmation variable like the alpha reset (`PURGE_CONFIRM`), supports
`--dry-run`, and runs from a gated daily `CronJob`. The 3-year figure is the CNIL's
recommendation for inactive customer accounts; it is a policy choice the operator can
shorten, and it is stated in the notice.

**CLI.** The worker gains `export-fan <handle>`, `erase-fan <handle>`,
`erase-identity <provider> <display_handle>` and `purge [--dry-run]`, in the same explicit
style as `reset` and `recompute-levels`: no `--force`, one line of help, a non-zero exit
code on refusal.

**The register and the runbook.** `docs/legal/registre-des-traitements.md` records the
processing operation for article 30. `docs/legal/runbook-droits.md` is the procedure for an
access or erasure request: who may ask, how identity is checked, the commands, the
one-month deadline, and what to log. `docs/legal/conformite.md` maps each obligation to the
file or code that satisfies it.

**Security measures stated in the notice** are the ones that exist: HTTPS, `HttpOnly`
cookies, non-root read-only containers, no password storage (OAuth only), access limited
to the operator, and the audit trail.

### Branch 3 — `docs/alignment`

- **README**: the two database ports, recorded as a decision rather than an inconsistency:
  `5432` is the Compose dev stack and `55432` is the dedicated test database (container
  `ashuworld-pg`), and the README states both. Also the new environment variables and CLI
  commands, a "Documents légaux" section, and an index of the design and legal documents.
- **CONTRIBUTING**: the same port; a rule that user-facing legal text is product copy and
  changes with its version; the new non-negotiables (consent recorded, erasure anonymises).
- **CHANGELOG**: move the unbuilt platform adapters and operator tools out of "Added" into
  a "Planned" note, and record the three branches under `[Unreleased]`. No version is
  invented: the repository has no tags, and 0.1.0 is the only release that exists.
- **Chart**: `home` and `sources` point at `github.com/vyrtualsynthese/ashuworld`, and the
  image repositories at `ghcr.io/vyrtualsynthese/ashuworld/*`.
- **Design documents**: a status banner on the foundation plan ("historical; implemented")
  and on the game design ("approved; superseded in part by this document"). The
  `admin_identities` paragraph is removed from the game design's "who is an admin" section
  and recorded as not implemented, because no values file has ever carried it.
- **SECURITY.md**: rate limiting moves from "out of scope" to "in scope"; add the legal
  contact and the erasure path to "what counts as a vulnerability" (a failed erasure is a
  data-protection incident).
- **Plan file** names `@fastify/static`, which is not a dependency; correct it in the
  historical banner's notes rather than rewriting history.

### Branch 4 — `refactor/quality`

Small and deliberately unambitious:

- `MAX_EVENT_ATTEMPTS = 5` exported from the worker's loop module and used by the claim
  SQL, the log line and the comment, instead of the literal appearing three times.
- Pool timeouts as named constants in `createPool` (`connectionTimeoutMillis`,
  `idleTimeoutMillis`, `max`), so a lost database fails fast instead of queueing forever.
- The web app imports `ProviderName` and `isProviderName` from `@ashuworld/providers`
  instead of keeping a local copy. The package holds names and a type guard and no server
  code, so the stated reason for the copy ("the browser bundle would pull in the server
  package") does not hold; if Vite resolution makes this noisy, the copy stays and the
  comment is corrected.
- The inaccurate comment is fixed either way.

What is deliberately **not** refactored: the two balance queries. They look like a
duplicate, but one is per-fan and index-friendly and the other is a single grouped pass;
the module already documents that they must change together and the ladder test asserts
they agree. Merging them would either reintroduce a full-table scan per award or add a
view that hides the trade-off. The same reasoning applies to the five savepoint pairs:
each has a different failure path, and a generic helper would be harder to read than the
explicit statements.

## Verification

- `bash scripts/check.sh` green (typecheck, lint, coverage, chart lint and render).
- Each new guard has a test that fails when it is removed: a missing header, a 429, a
  session response without `no-store`, a login without acceptance, an erasure that leaves
  a handle or a display name, an erased identity that still shows on the ladder, a re-link
  after erasure that pays twice, and a returning erased account that starts over at 0 XP
  without a second payment.
- The web image smoke job asserts the four headers on the built image.
- The legal pages are read end to end by the operator, because they are not legal advice
  until a human has read them.

## Risks

| Risk | Mitigation |
|---|---|
| The CSP breaks the SPA | Tested against the built image before merge; hashes rather than `unsafe-inline` if Vite emits inline code. |
| The rate limit 429s a stream audience | Generous public default, configurable per deployment, `Retry-After` sent. |
| Erasure damages the ledger | One transaction, one tested function, and a test that a re-link after erasure cannot pay again. |
| Legal text drifts from the code | The compliance map names the file that satisfies each obligation; the docs branch keeps it current. |

## What is still theirs

- Whether the site is already public, or still alpha behind a private host: it sets the
  deadline, not the content.
- Whether 3 years of inactivity is the retention they want; shorter is allowed and the
  notice follows the choice.

## What is left to the builder

- The exact wording of the three legal documents, in French, reviewed by the operator.
- Whether the acceptance is a checkbox on the panel or a dedicated pre-login step.
- The rate-limit numbers and whether the store stays in-memory at alpha.
- Whether `purge` ships with a CronJob or only a documented manual run.
- The HMAC pepper's rotation policy (a rotation would break the "no second payment"
  guarantee for accounts erased under the old key; the design accepts keeping one key).
