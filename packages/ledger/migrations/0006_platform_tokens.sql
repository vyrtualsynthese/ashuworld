-- Sealed channel grants.
--
-- One row per provider: the refresh token the channel owner authorized once, sealed with
-- AES-256-GCM (see `sealToken` in `@ashuworld/providers`) so this table holds ciphertext
-- only. A dump or a backup of this table is not a usable credential.
--
-- The provider is the primary key because the grant is per channel, not per fan: `twitch`
-- names the broadcaster's own authorization, which every fan's follow is read through.
-- Re-authorization replaces the row; there is no history to keep, and a stale row would
-- only be a token that no longer works.
create table platform_tokens (
  provider text primary key,
  refresh_token text not null,
  updated_at timestamptz not null default now()
);
