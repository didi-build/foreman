-- 0008: the price each run is costed at (ADR 0114 sections 2, 5 and 8, build plan M3.2). Never edit
-- an earlier migration; add a new one instead. No new table, role or grant: the runner already
-- inserts runs.

-- The route's model entry from the model catalog version recorded on the run
-- (model_catalog_version): the tiers the provider supports for the model and its price per
-- million tokens at each tier, as `{ "tiers": [...], "pricePerMTok": { "standard": {...} } }`.
-- The core copies it onto the run when it admits the run, in the same transaction, and never
-- changes it. The runtime's dollar limit and the core's cost_usd both read this copy, so a run is
-- priced the same way however the catalog setting changes later (D-162). jsonb, as the catalog
-- entry it copies. Null only for a run recorded without one, which the core does not price
-- (cost_usd stays null) and the runner does not start.
alter table factory.runs add column model_price jsonb
  check (model_price is null or jsonb_typeof(model_price) = 'object');
