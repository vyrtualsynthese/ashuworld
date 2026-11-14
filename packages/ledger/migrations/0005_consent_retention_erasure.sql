-- Consent and activity, kept on the fan row.
--
-- `terms_version` remembers which terms the fan agreed to and `terms_accepted_at` when
-- that happened; both are written once, at the first acceptance, and kept forever. A later
-- version is not recorded, so changing the terms means a deliberate migration of these
-- columns, not something a sign-in does.
-- `last_seen_at` is the activity signal that retention uses: an account nobody has signed
-- into for long enough becomes a candidate for deletion. `erased_at` marks an account whose
-- personal data was erased; the row survives in that state so its history stops pointing at
-- nothing, and every retention query skips it.
alter table fans
  add column terms_version text,
  add column terms_accepted_at timestamptz,
  add column last_seen_at timestamptz,
  add column erased_at timestamptz;

-- The pair moves together: an acceptance is a version and a moment, never one alone.
alter table fans add constraint fans_terms_pair check ((terms_version is null) = (terms_accepted_at is null));

-- The consent shown while a sign-in is in flight. A login can only record an acceptance
-- it actually carried from the start page, and a link has none: the column is filled at
-- start and copied onto the fan at the callback that consumes the handshake.
alter table oauth_handshakes add column terms_version text;

-- Retention sweeps fans by inactivity, using the last activity signal the account has:
-- its last sign-in, or its creation when it never came back. Partial, because an erased
-- account is never a retention candidate and must not sit in this index forever.
create index fans_inactive on fans ((coalesce(last_seen_at, created_at)))
  where erased_at is null;

-- Discovery asks which provider identities have never been attached to a fan, and the
-- query orders them by age. Partial keeps the index to the rows still waiting, so it
-- shrinks as identities are linked instead of growing with every sign-in.
create index provider_identities_never_linked on provider_identities (created_at)
  where first_linked_at is null;
