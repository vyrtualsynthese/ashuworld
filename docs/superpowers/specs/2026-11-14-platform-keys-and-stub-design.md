# Platform keys, sign-in and the unlinked ladder

**Status:** approved, 2026-11-14.
**Date:** 2026-11-14.
**Depends on:** the foundation design and plan (`2026-11-14-ashuworld-fan-xp-design.md`,
`2026-11-14-ashuworld-foundation.md`), which this extends without changing its rules.

## What this is for

A Dachi should see their name on the ladder before they ever sign in, and a Dachi who signs in
should find the XP already earned sitting on the account they just claimed.

That needs the three platform integrations the foundation deferred: Twitch, Discord and YouTube
(through a Google account). Sign-in works the same way for all three; discovery does not, and that
is why there are two kinds of credential:

- **Sign-in and linking.** An app registration per platform (a client id and a secret) lets a
  fan prove they control an account. This is the OAuth dance the api already implements in
  `apps/api/src/auth/providers.ts`; today only the `dev` provider is registered.
- **Discovery**, for Twitch and Discord only. An operator-side read lists the people already
  following the channel or sitting in the server, so their identities get XP and appear on the
  ladder before anyone signs in. This needs the channel's own Twitch token and a Discord bot
  token, not the fan's.

YouTube has no discovery half. There is no API that lists who subscribes to a channel, so a
YouTube row can only appear when a fan signs in with Google and their own grant reports the
subscription. That was already recorded in the foundation design. Because the monthly amount for
a subscription has to be re-checked each month, the fan's Google grant is kept, encrypted, and
re-read on a daily poll — the only platform whose credential belongs to a fan rather than to the
channel.

A local stack also needs to work before any of those apps exist. That is what the stub is: a
connector behind the same seam that invents people instead of calling a platform, so the ladder
fills with no keys at all and every award still goes through the real pipeline.

## Goals

- A laptop with no platform keys can fill the ladder with fake Dachis (`PLATFORM_CONNECTORS=stub`)
  and exercise the ladder, the profile and the XP page.
- With keys present, Twitch followers and Discord members are discovered on a schedule, get
  their one-time and monthly XP, and appear as unattached ladder rows.
- A linked YouTube subscriber keeps earning the monthly amount while their stored grant still
  reports the subscription, re-checked daily.
- A fan who signs in with Twitch, Discord or Google claims the identity they already have,
  inheriting its XP, exactly as the foundation design's `resolveLogin` already intends.
- A visitor with no session sees a sign-in button for each configured platform on the account
  page, without typing a URL.
- Each platform that lacks credentials is simply off: the api starts, the account page offers
  only what works, and the worker logs what it skipped.
- No credential in the repository. Locally, a git-ignored `.env`; in the chart, a Secret the
  operator creates.

## Non-goals

- Twitch EventSub (the webhook feed of platform events) and the Discord gateway. Discovery is a
  poll for alpha; webhooks are a later plan, and the poll stays useful as the fallback.
- Operator tools, punishment UI, the audited identity-move repair.
- Removing XP when a fan unfollows, unsubscribes or leaves. The condition simply stops being
  re-verified, so no further monthly XP is paid. Nothing already earned is taken back.
- A fourth platform. The foundation design excludes anything without a readable follower list.

## Anti-goals

- **No personal data on the public ladder.** A discovered row carries a provider name, the
  provider handle, and XP. Never an email, an avatar, a message, a role list or a real name.
  The handle is already what the ladder shows for unattached rows; this does not widen it.
- **No stub in a deployment.** The stub requires its own explicit switch, in the same spirit as
  `ALLOW_DEV_LOGIN`, and the chart never sets it.
- **No awarding from the api.** The api enqueues; the worker awards. Two writers to the ledger
  would mean two places to get the idempotency wrong.

## Constraints the platforms impose

These are checked against the providers' current documentation during the plan; they are the
reason the shape below looks the way it does.

- **YouTube subscribers cannot be listed.** Neither publicly nor with the channel's own token.
  Only `subscriptions.list(mine=true)` on the fan's grant says what they subscribe to. Re-checking
  it every month therefore needs a stored refresh token, and Google only returns one when the
  authorization asks for offline access (`access_type=offline`, plus `prompt=consent` on a
  repeat grant).
- **Twitch followers need the broadcaster's authority.** `GET /helix/channels/followers` accepts
  only a user token for the broadcaster or one of their moderators, with the
  `moderator:read:followers` permission. An app token (client-credentials) cannot read it. The
  worker therefore needs a refresh token obtained once from the channel owner.
- **Twitch per-fan verification is easier on the fan's side.** With a token carrying
  `user:read:follows`, `GET /helix/channels/followed` lists the channels that fan follows. That
  proves the follow at sign-in without the operator token.
- **Discord server members need a bot.** `GET /guilds/{id}/members` works with a bot token for a
  bot invited to the server and the `GUILD_MEMBERS` privileged intent enabled. There is no
  public member list.
- **Discord per-fan membership uses the fan's token.** With the `guilds` scope,
  `GET /users/@me/guilds` lists the servers that fan is in; presence of the operator's guild id
  is the proof.
- **Google grant.** `https://www.googleapis.com/auth/youtube.readonly` covers
  `channels.list(mine=true)` and `subscriptions.list(mine=true)`. The identity stored is the
  YouTube channel, not the Google account.
- **Callbacks are fixed by the existing route table.** Every provider returns to
  `/auth/<provider>/callback` on `PUBLIC_BASE_URL`, and that exact URL must be registered in
  each platform's app.
- **The web has only half a door.** `apps/web/src/providers.ts` lists Twitch, YouTube and
  Discord, and `AttachPanel` offers them to a fan who is already signed in, but `SignInPanel`
  shows only the dev button (or "not activated") to a visitor with no session. A real provider
  therefore needs a web change: sign-in buttons for the configured platforms, and a way for the
  browser to learn which ones are configured.
- **The ladder already handles unattached identities.** `listLadder` returns `linked` and
  `freeStanding`, and the page merges them. No schema change is needed for this feature.
- **The worker's processor map is empty.** `apps/worker/src/index.ts` registers none, so the
  queue path this feature depends on has to be added.

## Approaches considered

Three ways to get fake data into a local stack. The real connectors' seam is the same in all
three; the choice was where the stand-in sits.

- **A — a connector seam with a stub connector.** One `Connector` interface ("list the people this
  platform says are in"), with real Twitch and Discord implementations and a `stub` one, selected
  by environment. The stub pushes invented people through `inbound_events`, so awards happen by
  the same code path as production. **Chosen.** The fake lives in one file and cannot award
  directly.
- **B — recorded fixtures at the HTTP layer.** The real client code runs against recorded
  responses. Better at testing pagination, but recordings go stale, and a 500-person ladder would
  need a 500-person fixture.
- **C — a seed script writing XP straight into Postgres.** Fastest, but it skips ingestion and the
  award rules, so local behaviour would not match production. Rejected: the repository is the
  system, not a demo.

## How it is built

### 1. Credentials and configuration

Two environment readers already exist, `apps/api/src/config.ts` and
`apps/worker/src/index.ts`; both grow the fields below. A pair of values (`id` and `secret`) is
read together: neither set means "provider off", one set means a startup error naming the missing
half, both set means the provider is on. That is the same fail-loud rule `COOKIE_SECURE` already
follows.

The pair is not the whole check: a configured platform also needs the target it verifies against.
`TWITCH_CLIENT_ID`/`SECRET` without `TWITCH_CHANNEL_LOGIN`, `DISCORD_*` without
`DISCORD_GUILD_ID`, or `GOOGLE_*` without `YOUTUBE_CHANNEL_ID` or `PLATFORM_TOKEN_KEY` is a
startup error naming the missing variable. Starting anyway and verifying nothing would let a fan
sign in, earn no XP and be told nothing, which is the one outcome this rule exists to prevent.

| Variable | Read by | Purpose |
|---|---|---|
| `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET` | api, worker | Twitch app for sign-in and the follower poll |
| `TWITCH_CHANNEL_LOGIN` | api, worker | The channel whose followers are listed and the channel a fan's follow is checked against |
| `TWITCH_CHANNEL_REFRESH_TOKEN` | worker | Seeds the channel owner's grant; the live value is rotated into the database |
| `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET` | api | Discord app for sign-in |
| `DISCORD_BOT_TOKEN` | worker | Bot token that can read the member list |
| `DISCORD_GUILD_ID` | api, worker | The operator's server, for membership and discovery |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | api, worker | Google app for sign-in and the subscription re-check |
| `YOUTUBE_CHANNEL_ID` | api, worker | The channel a subscription is checked against |
| `PLATFORM_TOKEN_KEY` | api, worker | 32 random bytes, base64; encrypts the fan grants at rest |
| `YOUTUBE_POLL_INTERVAL_SECONDS` | worker | How often stored grants are re-checked (default 86400) |
| `PLATFORM_CONNECTORS` | worker | Comma list of discovery sources; empty means none |
| `ALLOW_STUB_CONNECTORS` | worker | Second, explicit switch for the fake source |
| `STUB_PEOPLE` | worker | How many fake people to invent (default 250, capped at 5000) |
| `SYNC_INTERVAL_SECONDS` | worker | How often Twitch and Discord discovery runs (default 900) |

Local plumbing:

- A tracked `.env.example` with every name above, values empty and one line of comment each.
  `.env` is already git-ignored.
- `compose.dev.yaml` mounts `.env` into `api` and `worker` with Compose's optional `env_file`
  form, so a missing file is not an error.
- The README's "Running the Node processes without containers" section gains
  `set -a; . ./.env; set +a`, and a new "Platform keys" subsection that says where to create
  each app and which redirect URL to register.
- Nothing logs a secret. Startup logs say which platforms are on and which are off, by name.

### 2. Sign-in providers

`apps/api/src/auth/providers.ts` grows into one file per platform under
`apps/api/src/auth/providers/`, with the registry and the `dev` provider kept where they are.

The interface changes from returning an identity to returning an identity plus what the fresh
grant could prove:

```ts
export interface ExchangeResult {
  profile: IdentityProfile
  /** One-time actions this grant verified, e.g. ['twitch.follow']. Empty when nothing matched. */
  verifiedActions: string[]
  /** A grant to keep when the platform must be re-checked later. Only Google returns one. */
  refreshToken?: string
}
```

`dev` returns an empty `verifiedActions` and no grant, so every existing test and the dev door
behave exactly as before. A provider verifies while the token is fresh, inside `exchange`, because
that is the only moment it holds a usable grant.

| Provider | Scopes | Identity | Verification |
|---|---|---|---|
| Twitch | `user:read:follows` | user id, login, display name | `channels/followed` contains the channel |
| Discord | `identify guilds` | user id, username, global name | `users/@me/guilds` contains the guild |
| Google | `openid email profile youtube.readonly`, offline access | YouTube channel id, handle, title | `subscriptions.list(mine=true)` contains the channel; the refresh token is kept |

- "Not following" is not an error: the fan signs in, `verifiedActions` is empty, no XP is paid.
  A broken exchange (bad code, revoked app, Google account with no channel) is a
  `ProviderExchangeError` with a 4xx, the existing contract.
- `resolveLogin` and `resolveLink` use `result.profile`; after the transaction commits, the
  callback enqueues one event per verified action (section 3). The event is enqueued after the
  commit so a rollback cannot leave an award for an identity that was never linked.
- When `result.refreshToken` is present, it is encrypted and written in the same transaction that
  attaches the identity, so a grant never exists without its identity.
- The registry takes the whole env object, not just `ALLOW_DEV_LOGIN`, and registers only the
  providers whose credentials are present.

A public capability route, `GET /api/public/providers`, answers the configured platform names in
the fixed order `twitch`, `discord`, `youtube`, then `dev` when `ALLOW_DEV_LOGIN` is true. It
carries no credential and no identity. `SignInPanel` and `AttachPanel` in
`apps/web/src/pages/Account.tsx` render only those names, so a button that would answer
`unknown_provider` is never shown, and "la connexion n'est pas activée" appears only when nothing
at all is configured. The pinned route-table test in `apps/api/test/identities.test.ts` gains the
route on purpose.

Twitch verification compares the channel login, which `channels/followed` returns per row, so the
api never needs to resolve a login to a numeric id before answering.

When a kept grant is revoked or can no longer be unsealed, `GET /api/me` reports the provider in a
new `revokedGrants` list and the account page shows one sentence beside that identity: YouTube
verification stopped, sign in with Google again to renew it. The identity stays attached; only the
monthly re-check stops.

#### The kept Google grant

A YouTube subscription is only observable from the fan's own grant, so that grant has to outlive
the sign-in. `0006_fan_grants.sql` adds:

```sql
create table fan_grants (
  identity_id uuid primary key references provider_identities(id) on delete cascade,
  provider text not null,
  refresh_token text not null,
  status text not null default 'ok' check (status in ('ok', 'revoked')),
  checked_at timestamptz,
  created_at timestamptz not null default now()
);
```

- **Encrypted at rest.** `PLATFORM_TOKEN_KEY` is 32 random bytes, base64. The token is sealed with
  AES-256-GCM and stored as `v1:<iv>:<tag>:<ciphertext>`; the crypto helper lives in
  `packages/providers/src/grants.ts` so the api and the worker use one implementation. The key
  never leaves the Secret, and a rotated key that cannot unseal a row marks that row `revoked`
  instead of failing the poll: the fan signs in again and gets a fresh grant.
- **Deleted on detach.** The detach transaction removes the grant with the identity (the cascade
  covers it). After the response, the api makes a best-effort call to Google's revoke endpoint;
  a failure is logged and changes nothing, because the row is already gone.
- **Never read back.** No route returns a token and no log line contains one. The only consumer is
  the worker's poll.

### 3. One awarding path

A new ledger function, `enqueueEvent(pool, { provider, eventId, payload })`, inserts a row into
`inbound_events` and returns `'queued'` or `'duplicate'`. It deliberately does not run a
handler: the api's job ends at the row, and the worker owns the transaction that awards. The
existing `ingestEvent` stays for callers that must award in the same transaction.

Event id shape: `<source>:<provider>:<externalId>:<action>:<YYYY-MM>`. The month is included
because the same fact is re-affirmed every month while the condition holds; the id is stable
within a month, so a fan signing in twice is one event, and a failed event is still retried by
the worker's existing attempts mechanism.

Payload:

```ts
{
  kind: 'discovery',
  provider: 'twitch' | 'discord' | 'youtube',
  externalId: string,
  displayHandle: string,
  displayName: string,
  actions: string[]   // ['twitch.follow'], ['discord.member'], ['youtube.subscribe']
}
```

The worker gains a processor for each of those three providers. Each processor:

1. `ensureIdentity` (the same upsert the api uses, so a pre-existing row keeps its id and its
   handle is refreshed even when it earns nothing).
2. Reads the identity's `fan_id` and `first_linked_at`, and stops before awarding when the
   identity was once attached and is detached now (`fan_id is null and first_linked_at is not
   null`). Discovery keeps reporting someone who still follows after a detach, and paying them
   would create fresh, non-forfeited earns that would count if that identity were re-linked —
   against the foundation rule that a re-link brings back nothing. The guard is deliberately not
   "has no fan": that is exactly the unattached ladder this feature exists for.
3. For each action, `awardOnce` with the action's amount from the game config.
4. `awardMonthly` for the current UTC month, using the ledger function that already exists and
   currently has no caller.

The one-time unique index and the monthly key stay the only things that prevent double payment;
the processor is safe to replay, which is what the event id and the retry bound rely on.

Consequence worth naming: XP from a sign-in appears when the worker picks the event up, up to
about one second later. The account page may show the previous balance for that moment. The
alternative, awarding inside the callback, would give the api a second write path and is
rejected.

### 4. Discovery connectors and the YouTube poll

`apps/worker/src/connectors/` holds:

```ts
export interface Connector {
  name: 'twitch' | 'discord' | 'stub'
  /** Yields the people the platform currently reports. */
  discover(): AsyncIterable<DiscoveredPerson>
}

export interface DiscoveredPerson {
  provider: ProviderName
  externalId: string
  displayHandle: string
  displayName: string
  actions: string[]
}
```

A runner in the worker's loop wakes every `SYNC_INTERVAL_SECONDS`, runs each enabled connector,
and enqueues one event per person. Connectors are enabled by `PLATFORM_CONNECTORS`; an empty
value runs none, so an existing deployment is unchanged. Only sources the operator can enumerate
implement `Connector`; the YouTube poll reads grants and produces the same `DiscoveredPerson`
shape without pretending to enumerate a channel's subscribers.

- **Twitch.** Exchange the stored refresh token for a user token (cached until shortly before
  expiry), resolve the broadcaster id from `TWITCH_CHANNEL_LOGIN`, page through
  `channels/followers` 100 at a time. Each follower is `twitch.follow`.
- **Discord.** Page through `guilds/{id}/members` 1000 at a time with the bot token, skipping
  bot accounts and the operator's own account. Each member is `discord.member`.
- **YouTube.** Not a connector in the same sense: it reads `fan_grants` for provider `youtube`
  with status `ok`, refreshes each grant, asks `subscriptions.list(mine=true)`, and enqueues a
  `youtube.subscribe` event only when the channel is present. A fan who unsubscribed simply stops
  being re-affirmed. An `invalid_grant` answer marks the row `revoked` and the poll skips it from
  then on. It runs on `YOUTUBE_POLL_INTERVAL_SECONDS` and is enabled by
  `PLATFORM_CONNECTORS=youtube`.
- **Failure behaviour.** A 429 waits for `Retry-After`; any other error is logged with the
  connector and the run ends until the next tick. One platform failing never stops the other.
- **Nothing is deleted.** A person who is no longer reported simply stops being re-affirmed, so
  no further monthly credit lands. The foundation rule that a detach forfeits and never returns
  is untouched.

A one-time command, `pnpm --filter @ashuworld/worker twitch-authorize`, prints a URL, takes the
code back, and prints the refresh token to paste into `.env`. It exists because the channel
owner must grant `moderator:read:followers` by hand once. The command never writes the token
anywhere itself.

Twitch rotates that refresh token when it is spent: the old value stops working and the response
carries the next one. A token that only lives in `.env` would therefore be stale after the first
refresh, and the poll would stop with nothing but a log line. The worker stores it. A new
migration, `0005_platform_tokens.sql`, adds
`platform_tokens (provider text primary key, refresh_token text not null, updated_at timestamptz
not null default now())`. The worker seeds the row from `TWITCH_CHANNEL_REFRESH_TOKEN` when no row
exists, and rewrites it in the same transaction as each refresh. The value is sealed with the same
helper and `PLATFORM_TOKEN_KEY` as the fan grants, so no plaintext credential sits in a table. The
environment value is a seed, not the live credential. A row that cannot be unsealed stops the
connector with a message asking for a new one-time authorization; falling back to the environment
would only replay a token that is already dead.

### 5. The stub connector

`PLATFORM_CONNECTORS=stub` plus `ALLOW_STUB_CONNECTORS=true` enables it; either one alone is
refused at startup with a message naming the other, and the chart never sets either.

It invents `STUB_PEOPLE` people deterministically: `stub-0001-tv` and so on, 60% Twitch and 40%
Discord, with handle and display name derived from the index. Each carries its platform action,
so the ladder shows the real action values and the real labels. Running it twice is harmless:
the event ids repeat within the month and the award rules are idempotent.

It is not claimable: a real Twitch sign-in will never present `stub-0001-tv`. That is deliberate.
Claiming is exercised by the dev door against its own `dev:` identities, and the stub's job is to
fill the ladder. The startup log line says the stub is active, in plain words, every time.

### 6. The chart

- New `providers` values block: `secretName` (the existing Secret the operator creates) and
  non-secret channel settings (`twitch.channelLogin`, `discord.guildId`, `youtube.channelId`).
- Both the api and worker read the credential keys from that Secret with `secretKeyRef` and
  `optional: true`, so a missing key is "provider off" rather than a pod that will not start.
  The key names are `twitch-client-id`, `twitch-client-secret`, `twitch-channel-token`,
  `discord-client-id`, `discord-client-secret`, `discord-bot-token`, `google-client-id`,
  `google-client-secret` and `platform-token-key`. The chart still creates no Secret and renders
  no credential value.
- `worker.env.PLATFORM_CONNECTORS` is the operator's switch; it is empty by default, so nothing
  polls until asked.
- `hooks.enabled` stays `false`. No HTTP hook exists yet.
- `deploy/helm/ashuworld/test/render.sh` gains assertions: credentials absent renders no
  secret reference value, credentials present renders the references, and the stub switches are
  never set by the chart.

### 7. Tests

- Provider unit tests with a fake `fetch`: happy path, "not following" (sign-in works, no XP),
  exchange failure, Google account without a channel. No network.
- Registry: configured pair on, one half set is a startup error, credentials without their target
  is a startup error, nothing set is off.
- Capability route: lists exactly the configured names in the fixed order, and never a name whose
  credentials are absent.
- Web: `SignInPanel` renders one button per configured provider and none for an absent one; the
  "not activated" sentence appears only when the list is empty (jsdom, mocked `fetch`).
- `enqueueEvent`: first insert queues, second is a duplicate, no handler runs.
- Processors: one-time plus monthly award, replay is a no-op, identity row reused, and a detached
  identity receives no new earn while its handle still updates.
- Grants: seal and unseal round trip, the stored value contains no plaintext, a wrong key marks the
  row revoked instead of throwing, a detach deletes the row, `invalid_grant` marks it revoked, and
  the poll enqueues only when the subscription is present.
- `GET /api/me` reports `revokedGrants` only for identities whose grant is revoked.
- The alpha reset leaves no `fan_grants` behind (the existing `cascade` on
  `provider_identities` reaches the table), and `platform_tokens` survives it: that row is
  operator infrastructure, not fan data.
- Connectors: pagination over two pages, bot filtering, 429 honouring `Retry-After`, a failure
  in one connector not stopping the other, and a rotated refresh token written back.
- Stub: deterministic output, cap enforced, refuses without both switches.
- Chart: the three render assertions above.
- Coverage stays at or above 80% on every metric, as the repository already requires.

### 8. Order of work

Five plans, each shipping working software:

1. **Credentials, local env and the stub.** Env parsing, `.env.example`, compose plumbing,
   `enqueueEvent`, the discovery processors, the connector seam and the stub. A laptop with no
   keys ends with a full ladder. This is the smallest and the answer to "run it locally now".
2. **Twitch.** Sign-in provider, follow verification, the capability route, the account page's
   real sign-in buttons, the channel-token command, the token table and the follower connector.
3. **Discord.** Sign-in provider, membership verification, the member connector. The buttons and
   the capability route already exist from plan 2, so this plan only extends the list.
4. **Google / YouTube sign-in.** The provider, the link-time check, encrypted grant storage,
   deletion on detach, and the `revokedGrants` answer.
5. **The YouTube poll.** The daily re-check over stored grants, the revocation path, and the
   monthly amount plan 4 can only pay once.

The order is deliberate: the stub makes the ladder useful before any app registration exists, and
Twitch comes first because the foundation design already puts it first. Plan 5 is last because it
is the only one whose correctness depends on credentials owned by the fans.

## Calls made after the builder review

- The web change is in scope and belongs to plan 2, not a later cleanup: without it the "sign in
  and claim" goal has no button.
- `TWITCH_CHANNEL_LOGIN` is read by the api as well as the worker.
- A credential pair without its target variable is a startup error, not "start and verify
  nothing".
- Discovery never pays a detached identity; the guard is on `first_linked_at`, not on the absence
  of a fan.
- The rotated Twitch refresh token is persisted in `platform_tokens`; `.env` only seeds it.
- YouTube keeps its monthly amount: each fan's Google refresh token is stored sealed with
  `PLATFORM_TOKEN_KEY`, re-checked daily, deleted on detach, and reported as revoked rather than
  silently dropped when Google refuses it.

## What this leaves to the builder

HTTP client shape and timeouts, retry/backoff constants, log wording, the exact CLI prompts for
the Twitch grant, test file layout, and whether the providers share one small `fetch` helper or
each keeps its own. None of these changes what gets built.
