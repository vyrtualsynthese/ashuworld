# Security policy

## Reporting a vulnerability

Do not open a public issue, and do not post it in a stream chat.

Use GitHub's private vulnerability reporting on this repository: **Security → Report a
vulnerability**. If that is unavailable, contact the maintainer through the channel's business
contact and say that it is a security report.

Please include what you did, what happened, and what you expected. A reproduction against the
local Compose stack is ideal. You will get an acknowledgement, and credit in the fix if you want
it.

## What counts as a vulnerability here

The system holds fan identities and levels, so these are the areas worth probing:

- **Acting as another fan**: reading or changing another fan's profile, identities or standing.
- **Session and sign-in**: a cookie issued without provider verification, a handshake that can be
  replayed or bound to someone else's browser, a session id that leaks into a body, header,
  redirect or log, or an expiry that can be extended.
- **Double payment**: any sequence — replay, refollow, re-link, concurrent delivery — that pays a
  one-time action twice.
- **Ladder and public payloads**: provider account ids, sessions, audit data, or detached
  identities exposed through the public endpoints.
- **Deployment**: a chart default that runs a container as root, a writable root filesystem, a
  secret rendered into a manifest, or `/hooks` reachable with no signature verification.

## Out of scope

- Rate limiting and denial of service on the alpha deployment.
- Findings that require an already-compromised operator account, or direct database access.
- The `dev` provider. It is a deliberate backdoor for local development, it is gated behind
  `ALLOW_DEV_LOGIN`, and it must be off in every deployment. A report that it works when that
  flag is on is not a vulnerability; a report that it works when the flag is off is.
- Social engineering, and anything against the provider platforms rather than this code.
