-- 0033: the trusted documentation sites, seeded with the first list (ADR 0119 slice 4c, D-474,
-- D-475, O-172). Never edit an earlier migration; add a new one instead. A privileged change for
-- Didi's review: one setting, and nothing else. No new table, column, role, grant, policy or gate
-- kind: a run's request to add a site reuses the approve-once kind `new_credentials` (D-473).
--
-- Why. A run whose bot file declares `docs_lookup` reads documentation pages through its egress
-- proxy from these hosts only, and from no other (ADR 0119 slice 4). One list for every project
-- (D-474). The runner reads it when it builds such a run's task (flows/lib/tasks.ts), and adds
-- one host when Didi approves a run's request for it (src/core/docs-sites.ts). A host Didi rejects
-- is never asked again (D-475); any other add is a small pull request like this one.
--
-- The value: a JSON array of canonical host names (lower case, no trailing dot, no scheme, port,
-- path, IP address or wildcard), sorted, each once. A host is matched exactly, so a subdomain of
-- a listed host is not on the list. A malformed list refuses every run that asks for it.
--
-- The first list, 14 hosts, for Didi to approve entry by entry. Each host was tried from the build
-- sandbox on 2026-11-24: its root page and one documentation page, read as text with the lookup's
-- own `pageText`. The sandbox's network refused 10 of the 14 hosts, so those are unchecked.
--   developer.mozilla.org      unchecked: the network refused it
--   developers.cloudflare.com  200 text/html at / and /workers/; the page text reads without JavaScript
--   docs.github.com            / redirects to /en on the same host; a moved page redirects within
--                              docs.github.com; the page text reads without JavaScript
--   kubernetes.io              unchecked: the network refused it
--   node-postgres.com          unchecked: the network refused it
--   nodejs.org                 / redirects to /en on the same host; /api/fs.html is 200 text/html
--                              and its text reads without JavaScript
--   opentofu.org               unchecked: the network refused it
--   playwright.dev             unchecked: the network refused it
--   react.dev                  unchecked: the network refused it
--   vite.dev                   unchecked: the network refused it
--   vitest.dev                 unchecked: the network refused it
--   www.postgresql.org         unchecked: the network refused it
--   www.typescriptlang.org     unchecked: the network refused it
--   www.windmill.dev           200 text/html at / and /docs/intro; the page text reads without JavaScript
-- No checked host redirects to another host, so the list keeps the plan's hosts as they are.
--
-- A value already set (by Didi, by hand) is left as it is. The insert is logged in
-- factory.settings_log like any other.
insert into factory.settings (key, value, updated_by, updated_at)
  values (
    'trusted_docs_hosts',
    '["developer.mozilla.org", "developers.cloudflare.com", "docs.github.com", "kubernetes.io", "node-postgres.com", "nodejs.org", "opentofu.org", "playwright.dev", "react.dev", "vite.dev", "vitest.dev", "www.postgresql.org", "www.typescriptlang.org", "www.windmill.dev"]',
    'migration',
    now()
  )
  on conflict (key) do nothing;
