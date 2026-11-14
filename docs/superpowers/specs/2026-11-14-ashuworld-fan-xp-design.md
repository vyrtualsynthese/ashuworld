# AshuWorld — Dachi XP and levels

Status: draft for approval. Alpha; everything is expected to be wiped before launch.

## Intent

Dachis of the AshuWorld channel (YouTube, Twitch) earn XP for what they do for the
channel, level up, and can show that level wherever they appear. Today a level is
only a badge: status, not power. The rules must leave room for gameplays later
without a rewrite.

Why: reward engagement and support, and encourage more of it, without turning the
channel into a farm for a number nobody trusts.

## Goals

- One Dachi identity that spans providers, with explicit link, merge and detach.
- XP awarded automatically from platform events. Phase one is one-time actions only.
- Abuse handled by construction, not by moderation after the fact: a one-time action
  can credit once per provider identity.
- XP never decreases except by an explicit punishment, and a level is never lost.
- A Dachi can see their level, and later a bot or overlay can read it from the API.
- Runs in the operator's Kubernetes cluster: container images, a Helm chart, GitHub
  Actions for build and test.
- Alpha data can be wiped cheaply and safely.

## Non-goals

- A shop, perks or subscribers-only content bought with XP: XP is a level, not a currency.
- Repeating earn sources (chat messages, watch time, raid participation). Phase two.
- Twitch chat bot, Discord bot roles, stream overlay. Phase two; the API must permit
  them, nothing more.
- Mobile app.
- Ingesting donations or subs revenue.
- Claim-only actions for platforms with no readable follower list (Instagram, X, TikTok,
  Bluesky). Every alpha action is verified by its platform.

## Anti-goals — fails even if it technically works

- A Dachi earns the same one-time action twice by unfollowing and refollowing, by
  detaching and re-attaching, or by linking a second identity of the same provider.
- A Dachi ends up in someone else's account, or an attached provider account can be claimed
  a second time by another Dachi.
- A Dachi loses a level because of a detach, a punishment, or a change to the XP table.
- An identity that was ever linked to an account reappears on the public ladder as an
  unattached account, or a detach leaves phantom XP behind.
- A crash or a retried webhook loses or duplicates an award.

## Constraints

- TypeScript end to end, Node.js.
- Modular: one package per bounded piece, each deployable built as its own image.
- Kubernetes + Helm, images in ghcr.io, CI in GitHub Actions.
- Postgres is the source of truth. No SaaS loyalty platform; none model cross-provider
  identity merge with detach.
- No message broker at alpha (see Approaches and Queue).
- Platform reality, which sets scope rather than preference:
  - Twitch follow: event available; unfollow has no event, so state is polled.
  - Twitch chat and YouTube chat: events available (phase two).
  - Discord: bot sees membership of the operator's server; no notion of "following".
  - YouTube subscription: not observable from the channel side, but observable from the
    Dachi's side: with the Dachi's own token, `subscriptions.list(mine=true)` reports the
    channels they follow. Verification is per Dachi, at link time and on a poll, and fails
    closed when the list comes back empty or unreadable.
  - Instagram, X, TikTok, Bluesky: no usable follower API. **Excluded from alpha** — no
    claims, no self-declared XP. Every alpha action is verified by the platform that owns
    it.

## Approaches

**A — one deployable (API, webhooks, worker, frontend in one image).** Rejected.
Cheapest to run and the ledger stays in one transaction, but every platform
integration shares a restart and a failure with the others.

**B — split services (chosen).** Separate `api`, `web` and `worker` deployables with
shared domain packages. Blast radius is per component, each integration can be
restarted, redeployed or scaled alone, and it matches the operator's Kubernetes and
GitHub Actions workflow. Cost: more manifests, more to watch, and the ledger's rules
must hold across a network boundary — handled by making one service the only writer
of ledger rows.

**C — hosted loyalty platform with a custom linker.** Rejected: the merge and detach
semantics do not exist there, and the game rules would live in someone else's schema.

Refinement inside B: three deployables today, not one per platform. Provider adapters
are packages inside `worker`, so a fourth deployment is possible later without moving
the ledger.

## Decided design

### Services

| Component | Role |
|---|---|
| `web` | React + Vite single-page app. Public profile, ladder, account linking, admin views. Static, served by nginx. |
| `api` | Fastify. OAuth login and linking, sessions, Dachi reads, admin actions, and the writes that Dachi actions produce: link, detach, penalty. |
| `worker` | Platform connectors (Twitch EventSub receiver + follower poller, Discord gateway), the awarding pipeline, outbox consumer, and the writes that platform events produce. |
| `packages/ledger` | Domain rules and SQL: award, merge, detach, punishment, level. No HTTP, no platform code. |
| `packages/providers` | One adapter per platform: identity, verified events, login. |
| `packages/gameconfig` | Action values and the level table, versioned, loaded from a file. |

Sessions live in Postgres (one less component at alpha). OAuth only: Twitch, Google and
Discord, no passwords. Google is there for exactly one reason — it is the only way to see
whether a Dachi follows the YouTube channel — and a Google-only account still gets a profile
like any other.

Write ownership is by kind of entry, not by one blessed service: `worker` owns the
verified-earn transaction (award plus inbound event marked processed), `api` owns the
writes a Dachi or the operator triggers (link, detach, penalty). Both call
`packages/ledger`, which is compiled into each image and talks to the same Postgres, so
no award crosses a network call and "exactly once" stays inside one transaction. What
must never happen is a third writer: no connector, no script, no manual SQL.

### Login and linking — one Dachi, many doors

A Dachi joins with one provider and links the rest. From then on **any attached identity is
a valid login and all of them land on the same profile**: same handle, same level, same
balance. Discord-attached first, then Twitch and YouTube linked, and all three are doors
to the same account.

1. **Login with an attached identity** → that account. No choice, no prompt.
2. **Login with an identity that has never been linked** → a new account is created. This
   is the accepted "two accounts, one person" case; nothing in the product guesses that
   the person behind it already has a profile.
3. **Login with a detached identity** → one confirmation before it attaches again:
   "this account was detached; its past XP is gone". Accept and it is a door again with
   the forfeit intact. Decline and the Dachi is shown the sign-in choice again. It is never
   silent, which is what keeps a detach meaningful.
4. **Attaching an identity that already belongs to another account** → refused, always,
   even if the other account is inactive. Otherwise one Dachi can take over another Dachi's
   ladder history by linking their provider account.
5. **The last attached identity cannot be detached.** Refused with the reason: it is the
   only way into the account, and detaching it would leave an account nobody can log into
   holding a level nobody can show.
6. **Sessions belong to the account, not the identity.** Detaching the identity you signed
   in with does not sign you out; you stay on the account until you sign out or the
   session expires.

### Identity and ledger — the crux

```
fans              id, handle, display_name, peak_xp, level, created_at
provider_identities  id, provider, external_id, fan_id (nullable), linked_at,
                  first_linked_at
xp_entries        id, identity_id (nullable), fan_id (nullable), provider,
                  action_key, amount (signed), kind (earn | penalty),
                  reason, actor, idempotency_key, created_at, forfeited_at
inbound_events    id, provider, event_id, payload, received_at, processed_at
```

A check constraint keeps exactly one of `identity_id` and `fan_id` set on an entry:
an earn always names the identity that produced it, a penalty always names the Dachi.

Rules the ledger must satisfy, at all times:

1. **Attribution.** Every earn names the provider identity that produced it. An
   account's balance is the sum of entries of its currently linked identities, plus
   account-level entries, which are penalties. Penalties therefore survive a detach:
   detaching an identity takes that identity's earns off the balance and nothing else.
2. **One-time earns.** A unique constraint on `(identity_id, action_key)` for
   `kind = 'earn'`. Unfollow, refollow and re-link cannot credit twice; that is the
   database refusing, not code remembering.
3. **A detach is a forfeit, not a pause.** Detaching marks that identity's earns as
   forfeited: they stay as rows, with a timestamp, and are excluded from every balance
   from then on. Deleting them would be simpler and is wrong — the one-time keys would
   vanish with them, so unfollowing, refollowing and linking the same account again
   would pay out a second time. Forfeited rows keep the keys spent. Re-linking that same
   account therefore brings back nothing; linking a different account brings that
   account's own earns. `peak_xp` is untouched, so the badge stays. One account holds at
   most one identity per provider: linking a second Twitch identity while one is attached
   is refused, and the Dachi must detach first.
4. **Level is a high-water mark.** `peak_xp` is the highest account total ever
   observed, written monotonically forward, and `level` is derived from `peak_xp`.
   Detach, punishment and table changes lower the balance but cannot lower the badge.
   After a table change, `peak_xp` is re-read through the new table and can only rise.
5. **Punishment is an entry.** Negative `amount`, `kind = 'penalty'`, with an actor and
   a reason in plain words. It never touches `peak_xp`.
6. **Idempotent ingestion.** Every inbound platform event carries a key; a unique
   constraint on it makes redelivery a no-op. Award and event-processed are written in
   one transaction.
7. **Once linked, never free-standing.** `first_linked_at` is stamped the first time an
   identity joins an account and never cleared. An identity with a `first_linked_at` is
   not on the public ladder as an unattached account, ever again — not after a detach, not
   after a forfeit.
   The identity still exists internally, keeps its spent one-time keys, and can be linked
   again; it simply has no public life of its own once it has been part of an account.

### The ladder before anyone links anything

An identity is awarded XP from the moment its first verified event arrives, whether or
not any Dachi account exists for it yet. That is what makes "before linking, accounts
count as separated on the ladder" true rather than aspirational: `fans` rows are created
at first login, identity rows at first contact, and the ladder is one ranked table holding
both kinds of account:

- a **Dachi** row: handle, level badge, XP, and a link to `/f/<handle>`;
- an **unattached account** row: provider label, provider handle and XP, with no level and
  no profile page, because it has never belonged to a Dachi.

The api still answers two lists — `linked` and `freeStanding` — from one snapshot, because
the ledger distinguishes them. The page merges them into one table: rank 1 is whoever has
the most XP, whether or not that account has a Dachi yet. Rows are ordered by XP
descending, then by display name ascending in French, so equal totals keep a stable order.

Ranking uses the current balance, not `peak_xp`: the ladder is about who is contributing
now, the badge is about how far you have come. Detached identities forfeit their earns
and never return to the ladder; from the outside, they are gone.

### Queue

No broker. Postgres holds a transactional outbox: connectors write `inbound_events`,
the worker claims rows with `FOR UPDATE SKIP LOCKED`, awards, and marks them processed
in the same transaction.

Reason: the invariant that matters ("process exactly once, never lose an event") is
the same invariant a broker would be asked to guarantee, and the ledger already sits
in Postgres, so the transaction can cover both. A broker is added when a consumer
needs replay beyond retention, fan-out to several consumers, or a backlog large enough
that Postgres row claims become the bottleneck. Nothing in the design blocks swapping
the outbox for NATS JetStream later, because the connectors only know "hand over an
event".

### Awarding pipeline

```
connector → inbound_events (raw, deduplicated)
          → normalise to (provider, identity, action_key)
          → award, guarded by the one-time constraint
          → update account totals and peak → outbox row for side effects
```

Side effects later (bot message, role grant) consume the outbox; the Dachi-facing award
never waits on a third-party call.

### Level and action table

A versioned file, loaded at start: action keys with values, plus a level table
(threshold XP per level). A Dachi's `level` is recomputed on change and only ever rises for a
given `peak_xp`. Numbers are a separate gameplay pass; this design fixes the structure,
not the values.

Alpha actions, all verified by the platform that owns them:

| Action | Provider | Detection |
|---|---|---|
| Followed the channel | Twitch | EventSub `channel.follow`, follower poll as the fallback |
| Subscribed to the channel | YouTube | `subscriptions.list(mine=true)` with the Dachi's own grant, at link and on a poll |
| Member of the Discord server | Discord | Bot gateway, membership sync on boot |

### Display

- `/f/<handle>` public profile: level, total XP, provider badges, earned actions.
- `/ladder` one ranked table of Dachis and unattached accounts, sorted by XP.
- `GET /api/public/fans/<handle>` — level, peak XP, balance, badges. This is the
  contract Twitch/Discord bots and overlays consume in phase two.

### Abuse and safety

- No claim endpoints and no self-declared XP: every alpha action is verified.
- Twitch EventSub signatures verified; Discord interactions verified; OAuth `state`
  checked; provider `external_id` unique per provider.
- Attach, detach, merge and punishment are written to an audit trail with actor and
  reason (rows in the ledger or a parallel table, decided by the builder).
- A detach requires a confirmation naming what leaves the ladder.

### Who is an admin

No roles table at alpha. An allowlist of provider identities in the chart's values
(`admin_identities`) is checked after login; the allowlist is the operator and any mod
they add. Consequences: no bootstrap problem, no admin UI to build, and the audit trail
records the acting Dachi. Moving to a role column later is a migration, not a redesign.

### Kubernetes, images and CI

Three images from one TypeScript monorepo (pnpm workspaces), tagged by commit SHA and
pushed to ghcr.io. One Helm chart with a values file per environment; deployments for
`api`, `web`, `worker`, a `Job` for migrations, a `CronJob` for pollers, secrets and
ingress.

One hostname, path-routed, behind the operator's existing reverse proxy: `/` to `web`,
`/api` and `/auth` to `api`, `/hooks/twitch` to `worker`. That single origin keeps the
session cookie first-party and avoids CORS between the app and its API. The Twitch
EventSub callback URL and the OAuth redirect URLs therefore all live on that hostname,
and must exist (public, TLS) before phase 3 can be tested end to end.

GitHub Actions: type check, lint, unit and integration tests against a Postgres service
container, image build and push on `develop` and tags, `helm lint` and `helm template`
on pull requests.

Postgres itself is out of scope: the chart expects an existing database and a secret
with its URL.

### Platform applications — external prerequisites

None exist yet, so creating them is part of phase 0. Three applications live outside this
repo and must be registered with their callback URLs pointing at the hostname above: a
Twitch application (OAuth + EventSub subscription), a Google Cloud project (OAuth client
with the YouTube read scope), and a Discord application (OAuth + bot invited to the
operator's server). Client IDs and secrets go into the chart's secret, never the repo.
This is phase 0 rather than a surprise during phase 3 because registration has lead time,
and the Google one has review lead time on top.

### Excluded sources, and why

Instagram, X, TikTok and Bluesky expose no follower list a third party may read. Decided:
no claims, no self-declared XP. An action either is verified by the platform that owns it
or it is not in the game. If one becomes readable later, it enters as a new adapter with
no change to the ledger.

A consequence worth naming: a Dachi can be told "follow me on Instagram for XP" only if a
human pays the reward, and that is a penalty-style manual entry, not an earn.

### Alpha reset

A Helm `Job` (also runnable locally) that truncates `xp_entries`, `inbound_events` and
`provider_identities`, zeroes totals and peaks, keeps accounts, and stamps the config
version. Safe because nothing outside the ledger depends on XP yet.

## Accepted consequences

**No account merge, by decision.** A Dachi who signs in with Twitch one week and Discord the
next owns two accounts, each with its own level, and cannot join them himself. That is
accepted for alpha rather than fixed: repairs are an audited operator action ("move this
identity to that account"), and the alpha wipe ends the problem. If repairs turn out to be
routine, self-serve merge is a later design of its own, not a checkbox.

**The Google scope has a gate.** Reading a Dachi's subscriptions needs `youtube.readonly`,
which Google treats as sensitive: an unverified app is limited to a small number of test
users, and raising that limit means a verification review. Consequence: the YouTube action
may stay behind that limit during alpha, and nothing else in the game depends on it —
Twitch and Discord carry the feature. The risk is calendar time, not architecture.

**No merge means no `peak_xp` reconciliation.** One Dachi, one peak. If an operator repair
ever joins two accounts, the surviving profile keeps the higher peak, because a level is
never taken away.

## Left to the builder

- Exact HTTP shapes, session and PKCE details, migration tooling.
- Whether the audit trail is ledger rows or its own table.
- nginx vs. serving `web` from `api`, if the extra image proves annoying.
- Chart layout and whether Postgres is external or a dependency of the chart.

## Phases (feeds the implementation plan)

0. Repo skeleton, pnpm workspaces, CI, Dockerfiles, Helm chart, empty services, and the
   Twitch, Google and Discord applications registered against the final hostname.
1. `packages/ledger` with tests for all seven rules, including detach, forfeit, penalty
   and the never-free-standing rule.
2. Accounts, OAuth login, linking, detach with confirmation, audit, operator repair.
3. Twitch adapter: EventSub receiver, signature check, follower poller, one-time follow.
4. `web`: profile page and ladder against real data.
5. YouTube adapter: Google OAuth with the read scope, subscription check at link and on a
   poll, and an honest "cannot verify" state.
6. Discord bot: server membership as a one-time action.
7. Alpha reset job and runbook.
8. Punishment UI for the operator, plus the audit read view.
