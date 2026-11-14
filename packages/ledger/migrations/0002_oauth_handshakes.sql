-- Single-use sign-in handshakes.
--
-- The row is the state: a 32-byte random value that proves a callback belongs to a start
-- this server issued. It is deleted by the callback that consumes it, so a replay finds
-- nothing. `fan_id` is set only for `link`, which must name the fan whose account the
-- identity may attach to; the check constraint makes a fan-less link handshake impossible
-- even for a writer that bypasses the api.
--
-- No cleanup job exists yet: an expired row is deleted when someone presents it, and
-- otherwise stays until a later sweep. The expiry is enforced by the consuming query, not
-- by a background task, so a stale row can never be redeemed.
create table oauth_handshakes (
  state text primary key,
  provider text not null,
  purpose text not null,
  fan_id uuid references fans(id),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  constraint oauth_handshakes_purpose_check check (purpose in ('login', 'link')),
  constraint link_handshake_has_fan check (purpose <> 'link' or fan_id is not null)
);
