-- 0004: how long an unanswered gate request stays open (D-199). The reconcile pass plans to
-- expire a request after this many days, and to cancel one whose node reached Done. Never edit an
-- earlier migration; add a new one instead.
insert into factory.settings (key, value, updated_by, updated_at) values
  ('gate_request_expiry_days', '7', 'migration', now());
