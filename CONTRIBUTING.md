# Contributing to AshuWorld

The short version: branch from `develop`, write the test before the code, keep the game rules
true, and open a pull request back into `develop`. `main` is production and only moves through a
release pull request.

## Branches

| Branch | Purpose |
|---|---|
| `main` | Production. Only accepts pull requests from `develop`. |
| `develop` | Integration. Every feature branch lands here. |
| `feature/<name>`, `fix/<name>`, `docs/<name>` | Short-lived work, cut from `develop`, merged back by pull request. |

Both permanent branches are protected: pull requests only, linear history, `verify` and `helm`
green, no force pushes, no deletions, all conversations resolved.

Before opening a pull request:

```bash
git fetch origin
git rebase origin/develop
TEST_DATABASE_URL=postgres://ashu:ashu@localhost:55432/ashu pnpm typecheck
pnpm lint
pnpm test:coverage
bash deploy/helm/ashuworld/test/render.sh   # if you touched the chart
```

If the rebase conflicts, resolve it and rerun the suite. We merge with **rebase**, never with a
merge commit and never with a squash, so the history stays a straight line.

## Commits

Gitmoji prefix, then what changed and why:

```
✨ feat: detach and identity listing endpoints
🐛 fix: bind the login handshake to the browser
📝 docs: Dachi XP and levels design
🔧 chore: container images and helm chart
⚡️ perf: index the ladder and cache the public reads
```

One logical change per commit. Squash "wip", "try again" and debug scaffolding before review.

## Tests

- Every rule in the ledger — and every route that decides who may act — needs a test that fails
  when the guard is removed. That is the bar, not "the tests pass".
- Tests run against a real Postgres. Each test file gets its own throwaway schema through
  `@ashuworld/ledger/testing`; do not point tests at a database you care about.
- Coverage must stay at or above **80%** on lines, branches, functions and statements. It is
  enforced by `pnpm test:coverage`, not by review.
- When you fix a bug, add the test that would have caught it. When you change a guard, run the
  relevant mutation locally (delete the guard, watch the test fail, restore it) and say so in the
  pull request.

## The rules that are not negotiable

These are product promises, and a pull request that weakens one will be rejected regardless of
how clean the code is:

1. A level is never lost. `peak_xp` is a high-water mark; the level derives from it.
2. A one-time action credits once per provider identity. The partial unique index is the
   enforcement; never replace it with application-level bookkeeping.
3. XP only decreases through an explicit punishment entry, with an actor and a reason.
4. A detach forfeits by marking `forfeited_at`. Rows are never deleted, because the one-time
   keys live in them.
5. An identity that was ever linked never returns to the ladder as an unattached account.
6. A Dachi holds at most one identity per provider, never ends with zero identities, and can never
   read or act on another Dachi's data.
7. A session cookie is issued only after a provider has proven who the Dachi is.

If a change seems to need one of these relaxed, open an issue first. The design document explains
why each exists.

## Copy and language

The product term is **Dachi**; the plural is **Dachis**. The database and the code still say
`fan` and `fans` — the `fans` table, `fanId`, `FanIdentity` — and that is deliberate: renaming
them touches the schema, the JSON and every caller, so it is a separate migration, not part of a
copy change. In user-facing text, the word is always Dachi.

The product speaks to Dachis, not to engineers. When you write user-facing text:

- Say what happens in plain words: "detaching forfeits this account's XP for good" rather than
  "the association will be removed".
- Never promise something the ledger does not do. Three bugs in the first implementation were
  copy that implied re-attaching recovers forfeited XP. It does not.
- Server error text is not a user message. Map codes to our own words in the app.

## Security

Do not open a public issue for a vulnerability. See [SECURITY.md](SECURITY.md).

## Local setup

See the "Run it locally" section of [README.md](README.md). The Compose stack gives you the whole
system, and the dev sign-in makes the account flows usable before the real platform applications
exist.

## Code of conduct

Participation is covered by [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
