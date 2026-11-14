-- The worker's claim and its unrouted-provider report both scan `inbound_events` for
-- unprocessed rows. This partial index serves the claim's `where processed_at is null
-- and provider = any(...) order by id` (the provider prefix lets the planner take the
-- oldest unprocessed row of each provider without reading the processed backlog) and the
-- report's `where processed_at is null and not (provider = any(...)) group by provider`.
-- Partial keeps the index small: a processed event never needs to be found again.
create index inbound_events_unprocessed on inbound_events (provider, id) where processed_at is null;
