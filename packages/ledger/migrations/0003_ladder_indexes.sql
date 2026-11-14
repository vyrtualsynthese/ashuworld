-- The public ladder's per-fan balance, grouped in one pass: see `liveBalancesQuery`.
create index xp_entries_fan_live on xp_entries (fan_id) where forfeited_at is null;
