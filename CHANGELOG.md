# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

During alpha, the numbers describe the shape of the system rather than a stable interface, and
the data is expected to be wiped before launch.

## [Unreleased]

### Added

- Security headers on the API and the web app, rate limits on sign-in, on destructive writes and
  on public reads, and `no-store` on every response that carries personal data.
- The three legal pages at `/mentions-legales`, `/confidentialite` and `/cgu`, linked from every
  page.
- A consent gate: the 15-year declaration and the CGU acceptance, recorded once and never
  overwritten.
- Data-rights commands `export-fan`, `erase-fan`, `erase-identity`, `erase-identity-id` and
  `purge`, the gated daily purge CronJob and the `ERASURE_PEPPER` Secret. Erasure anonymises the
  rows and keeps the one-time keys spent, so an erased account cannot be re-linked.
- `docs/legal/`: the processing register, the rights runbook and the compliance map.
- CI hardening: every GitHub Action pinned by commit SHA, the Helm tarball checksum-verified
  before extraction, the chart-check image pinned by digest, and `pnpm audit --prod` in the
  `verify` job.

### Changed

- The public profile and the ladder no longer publish the account's database id.
- The auth rate limit applies per route instead of over one shared counter.
- The Postgres pool now fails a connection attempt after 5 seconds instead of waiting forever.

### Planned

- Platform adapters (Twitch EventSub follow events, Discord membership, YouTube subscription) and
  the operator tools (punishment view, audit read view, audited identity repair) are not built
  yet.

## [0.1.0] - 2026-11-14

The foundation: everything a fan account needs, and nothing that depends on a platform adapter
existing yet.

### Added

- XP ledger with the game rules enforced by the database: one credit per provider account per
  action, a level that never drops, forfeit-on-detach without deletion, and a linked account that
  never returns to the free-standing ladder.
- Fan accounts: provider sign-in with single-use handshakes bound to the browser that started
  them, sessions in Postgres with an `HttpOnly` cookie, and link, detach and re-attach through the
  provider.
- Public ladder and profile, ranked by live balance, readable without a session, exposing no
  provider account ids and no detached identities.
- Web app: ladder, profile, and account pages, including a detach confirmation that states the
  permanent forfeit in plain words.
- Worker: skip-locked queue loop with a five-attempt bound, plus `reset` and `recompute-levels`
  commands.
- Deployment: three non-root, read-only container images and a Helm chart with migration, reset
  and level-recompute jobs, SPA fallback and same-origin proxy.
- Local Compose stack with a dev sign-in so the flows are usable before the real platform
  applications exist.
