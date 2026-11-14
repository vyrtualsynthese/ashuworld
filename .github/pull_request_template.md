# Pull request

## What and why

<!-- One paragraph. What changes for a fan, an operator, or the deployment, and why now. -->

## The rule this touches

<!-- Delete what does not apply, but do not leave it blank. -->

- Ledger rule (level, one-time credit, forfeit, ladder, identity ownership):
- Session or sign-in:
- Public payload:
- Deployment (chart, image, migration, job):
- None: documentation, tooling or a test-only change.

## How it was verified

- [ ] `pnpm typecheck`
- [ ] `pnpm lint`
- [ ] `pnpm test:coverage` (with `TEST_DATABASE_URL` set)
- [ ] `bash deploy/helm/ashuworld/test/render.sh` (chart changes)
- [ ] The guard I changed fails a test when removed, and I ran that mutation locally

Evidence, not adjectives: paste the command output or the failing-then-passing test names.

## Migrations and deployment

- [ ] No schema change
- [ ] Schema change: migration added, and the migrate Job was exercised against a fresh database
- [ ] Chart values changed (note the value and its default)
- [ ] New environment variable (name it, and say what happens when it is missing)

## Risks and rollback

<!-- What could break in production, and how to get back. "None" is an answer only if it is true. -->
