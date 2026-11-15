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
- **Erasure and retention**: a failed or partial erasure, meaning a handle, a display name or a
  provider id still readable after `erase-fan` or `erase-identity`; or a retention window that
  does not delete what the documentation says it deletes. The erasure pepper belongs here too: a
  leak of `ERASURE_PEPPER`, or its value appearing in a manifest, a log or a repository file,
  makes every stored pseudonym matchable back to a real provider account.
- **Rate limiting**: a way to bypass the configured limits — a key the caller can choose, a path
  that skips its bucket, a limit that silently does nothing, or a window that can be reset by the
  client.
- **Legal pages**: text that promises a deletion, an export or a retention period the code does
  not perform. The three documents must describe the system that exists; a promise beyond it is a
  defect, not a wording issue.
- **Ladder and public payloads**: provider account ids, sessions, audit data, or detached
  identities exposed through the public endpoints.
- **Deployment**: a chart default that runs a container as root, a writable root filesystem, a
  secret rendered into a manifest, or `/hooks` reachable with no signature verification.

## Out of scope

- Denial of service on the alpha deployment: a single overloaded instance is not a finding on its
  own. Bypassing the rate limiter is, and is listed above.
- Findings that require an already-compromised operator account, or direct database access.
- The `dev` provider. It is a deliberate backdoor for local development, it is gated behind
  `ALLOW_DEV_LOGIN`, and it must be off in every deployment. A report that it works when that
  flag is on is not a vulnerability; a report that it works when the flag is off is.
- Social engineering, and anything against the provider platforms rather than this code.

## Legal and data protection

Data protection questions, and any request to access, correct or erase a person's data, go to
**info@ashudev.com**. Do not send them to the issue tracker.

A vulnerability that exposes or alters personal data is also an incident. Follow
[`docs/legal/runbook-droits.md`](docs/legal/runbook-droits.md) for the rights procedure, and the
breach procedure in [`docs/legal/conformite.md`](docs/legal/conformite.md): contain the access
first, evaluate what and who was touched, and notify the CNIL within 72 hours if the risk is real.
