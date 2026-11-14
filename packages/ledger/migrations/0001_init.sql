create extension if not exists pgcrypto;

create table fans (
  id uuid primary key default gen_random_uuid(),
  handle text not null unique check (handle ~ '^[a-z0-9_]{3,24}$'),
  display_name text not null,
  peak_xp integer not null default 0 check (peak_xp >= 0),
  level integer not null default 0 check (level >= 0),
  created_at timestamptz not null default now()
);

create table provider_identities (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  external_id text not null,
  display_handle text not null,
  fan_id uuid references fans(id),
  linked_at timestamptz,
  first_linked_at timestamptz,
  created_at timestamptz not null default now(),
  unique (provider, external_id),
  unique (fan_id, provider)
);

create table xp_entries (
  id uuid primary key default gen_random_uuid(),
  identity_id uuid references provider_identities(id),
  fan_id uuid references fans(id),
  provider text not null,
  action_key text not null,
  amount integer not null,
  kind text not null check (kind in ('earn', 'penalty')),
  reason text,
  actor_fan_id uuid references fans(id),
  idempotency_key text not null unique,
  created_at timestamptz not null default now(),
  forfeited_at timestamptz,
  constraint xp_entries_one_owner check ((identity_id is null) <> (fan_id is null)),
  constraint xp_entries_penalty_has_reason check (kind <> 'penalty' or reason is not null)
);

create unique index xp_entries_one_time on xp_entries (identity_id, action_key) where kind = 'earn';
create index xp_entries_identity on xp_entries (identity_id) where forfeited_at is null;

create table inbound_events (
  id bigserial primary key,
  provider text not null,
  event_id text not null,
  payload jsonb not null,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  attempts integer not null default 0,
  unique (provider, event_id)
);

create table sessions (
  id text primary key,
  fan_id uuid not null references fans(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create table audit_log (
  id bigserial primary key,
  kind text not null,
  fan_id uuid references fans(id),
  identity_id uuid references provider_identities(id),
  actor_fan_id uuid references fans(id),
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
