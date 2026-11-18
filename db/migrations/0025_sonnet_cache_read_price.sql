-- 0025: Claude Sonnet 5.5's cache read price falls from 0.20 to 0.10 USD per million tokens, its
-- Anthropic list price since 2026-11-06 (docs/costs.md section 2), so new runs on Sonnet are
-- priced at what Anthropic bills (O-150). Never edit an earlier migration; add a new one instead.
-- A privileged change for Didi's review. No new table, column, role or grant: it only changes the
-- model_catalog row in place, and the settings trigger records the change in settings_log.
--
-- model_catalog.models."claude-sonnet-5-5".pricePerMTok.standard.cachedInput becomes 0.1, only
-- while it is still the 0.2 that 0005 seeded, so an operator's own price is never replaced; any
-- other value is left as it is, with a NOTICE. Nothing else in the entry or the catalog changes.
-- Claude Opus 5.5's entry already has its list price (4, 0.20 cached, 20) and is left as it is.
--
-- The catalog's version changes with its content, as in 0019 and 0024: 0024's 2026-11-18.1
-- becomes 2026-11-18.2, and any other version gets "+o150" at its end. The version changes only
-- when the price did, so running this again changes nothing. A run already admitted keeps the
-- price recorded on it (runs.model_price, migration 0008), so its cost is not changed.
do $$
declare
  path constant text[] := array['models', 'claude-sonnet-5-5', 'pricePerMTok', 'standard', 'cachedInput'];
  catalog jsonb;
begin
  select value into catalog from factory.settings where key = 'model_catalog';
  if catalog is null then
    return;
  end if;
  if catalog #> path = '0.2'::jsonb then
    catalog := jsonb_set(catalog, path, '0.1'::jsonb);
    catalog := jsonb_set(catalog, '{version}', to_jsonb(
      case when catalog ->> 'version' = '2026-11-18.1' then '2026-11-18.2'
           else coalesce(catalog ->> 'version', '') || '+o150' end));
    update factory.settings
      set value = catalog, updated_by = 'migration', updated_at = now()
      where key = 'model_catalog';
  elsif catalog #> path is distinct from '0.1'::jsonb then
    raise notice '0025 left model_catalog.models.claude-sonnet-5-5.pricePerMTok.standard.cachedInput as it is: it is not the 0.2 that 0005 seeded';
  end if;
end
$$;
