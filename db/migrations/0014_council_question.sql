-- 0014: the question a Council run answers (build plan M3.5, Council slice, D-228, D-229). Never
-- edit an earlier migration; add a new one instead. No new table, role, grant or policy: the
-- runner already inserts runs.

-- The topic key of the Council question the run was started for: `escalation:<node id>` for an
-- item in Escalated to Council, `decision-reversed:<decision id>` for a reversal's question. The
-- runner reads it when the run ends, to check the run's answer against that question's output
-- schema and to record the `council_decision` on the right topic (src/core/council.ts). Only a
-- Council run carries one.
alter table factory.runs add column question_topic text
  check (question_topic is null or question_topic ~ '^[a-z][a-z-]*:[0-9a-f-]{36}$');
alter table factory.runs add constraint runs_question_topic_council
  check (question_topic is null or bot = 'council');
