# 0114. Model evaluation, routing and service tiers

- **Status:** proposed. Review point: Didi reviews it before any part is built. Money and security choices are open questions at the end, each with a recommended answer.
- **Date:** 2026-10-31
- **Related:** D-142, D-143, D-154, D-158, D-161, D-162, D-171, D-185, D-186, D-194, P-04, P-11, P-12, P-17, N-26, N-30, N-31, build plan M3.2 and M4.5, [ADR 0106](./0106-agent-execution-environment.md), [ADR 0107](./0107-agent-dispatch-adapters.md), [ADR 0112](./0112-qa-runtime-github-access-and-independence.md), [cost sheet](../costs.md)

## Context

Every agent run today names one model, fixed per role in the bot file: Claude Sonnet 5.5 for the Developer, Claude Opus 5.5 for QA (D-185, D-186). Didi's long-term direction is to move off the Claude API toward open models on DeepInfra, because of cost (N-31). On 2026-10-31 Didi set out what he wants:

1. A general coding model for the Developer.
2. A slightly better model of a **different family** for QA.
3. A cheaper model for Triage and similar work.
4. Nobody knows yet which models suit which task. So the system must **benchmark** cost, speed and quality per model and task type, refreshed continuously but not in real time. A daily delay is fine.
5. A **routing layer** that picks the model per task from that data.
6. **Service tiers.** The runner's work is asynchronous and runs while Didi is away, so it should mostly use DeepInfra's Flex tier. Standard is for specific products or coding agents where needed. Tuned later.

What DeepInfra documents (chat completions page on docs.deepinfra.com, pasted by Didi on 2026-10-31):

- An OpenAI-compatible endpoint, `https://api.deepinfra.com/v1/openai`, and an Anthropic-compatible endpoint, `https://api.deepinfra.com/anthropic`.
- A request parameter `service_tier`. Unset means Standard. `"flex"` is a 20% discount and best effort: when DeepInfra is busy, a request may wait up to 10 minutes and is then rejected with HTTP 429. DeepInfra says to use it "for work you can retry". `"priority"` costs 50% more and is faster.
- Not every model supports tiers. An unsupported tier is served and billed at Standard with no error. The response has a `service_tier` field with the tier actually used.
- `fail_fast: true` returns HTTP 429 (`engine_overloaded`) at once instead of queueing. A rejected request is not billed.
- Output is capped at 16384 tokens for most models. Tool calling and structured outputs are supported.
- Prompt caching reuses the KV cache when a request's prompt prefix matches a recent one.

The page Didi pasted is the OpenAI-compatible one. Whether the Anthropic-compatible endpoint accepts `service_tier` and returns the served tier is not documented there. It is checked in the rehearsal.

What the code does today:

- `src/core/runs.ts` records per run: role (`bot`), runtime, model, bot version, turns, minutes, cost, tokens (cached and uncached input kept apart, D-185), outcome, and for `usage_exhausted` its cause (`rate_limit`, `capacity`, `out_of_credit`) and retry-after. It does not record a provider, a tier or a task type.
- The egress proxy (`src/egress-proxy/`) serves each provider from a list in settings, adds the credential, forwards the body byte for byte (D-185), and refuses requests past the run's ceiling with 403. The ceiling counts a request when it is forwarded, before the provider answers.
- The agent images (`src/agent-images/`) run Claude Code or a Messages API loop. The API loop sets `maxRetries: 0`, so a 429 ends the run. The Kubernetes adapter maps any 429 to `usage_exhausted` with cause `rate_limit` (`src/adapters/agent-runtime/kubernetes/result.ts`). The API loop prices its own dollar limit from a table in `src/agent-images/claude-api/pricing.ts` and fails closed for a model with no price. Claude Code reports its own cost.
- The core is deterministic (D-162). Decision points are named interfaces in the core, and model routing is one of the examples P-11 lists.

## Options

| Option                                                            | For                                                                                                                                                                                                                                                               | Against                                                                                                                                                                                                                                                        |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hard-code one model per role in the bot file (today)              | Nothing to build. Easy to read                                                                                                                                                                                                                                    | No data on which model is better for which task. Every change is a guess. Cannot tell a Developer infra task from a code task. The QA family rule has nowhere to live                                                                                          |
| Routing in the model gateway (D-142, second release)              | Gateways such as LiteLLM or Bifrost have routing, fallbacks and cost tracking built in                                                                                                                                                                            | The gateway does not exist until the second release. Its choice is not recorded in the store, so it is not replayable (D-162) and the guards cannot read it. The QA family rule needs the item's Developer run, which only the store has. A second rule engine |
| A decision model picks the model per task (N-30)                  | Could be cheaper than a rule over time                                                                                                                                                                                                                            | No labelled history to train or judge it yet. A model only advises (P-12). It can advise a later version of the rule below                                                                                                                                     |
| **Routing in the core from a policy in settings and a scorecard** | Deterministic and recorded on every run (D-162). Hard rules (QA family, known price, approved provider) sit in one place next to the guards. Works before the gateway exists, and the gateway only carries it out later. Didi approves every policy change (P-17) | A scorecard and a policy to build. Quality needs enough finished items before it says anything                                                                                                                                                                 |

## Decision

Proposed: the last option. The core picks each run's route from a routing policy kept in settings, under hard rules the core enforces. Every run records its route. A daily scorecard rolls up cost, speed and quality per model and task type. The system proposes policy changes from the scorecard, and Didi approves them.

### 1. Task types

A task type is the unit that routing and scoring use. It is the role plus a small task class:

| Task type         | Meaning                                                        |
| ----------------- | -------------------------------------------------------------- |
| `developer:code`  | Developer work on application code. The Developer's default    |
| `developer:infra` | Developer work on infrastructure code, workflows or migrations |
| `designer`        | Designer work                                                  |
| `qa:review`       | QA review of a pull request                                    |
| `council`         | A Council question                                             |
| `triage`          | Triage, and similar short classification or breakdown work     |

- The list of task types is data in the contracts, at a version (ADR 0105). Each bot file names its role's task types and its default. No flow carries its own list.
- The core sets an item's task type at dispatch. The first rule: the role's default, unless the item carries a task class that its role allows. Who sets that class on an item (Triage through a P-11 decision point, or Didi) is settled with M3.6. Until then every Developer run is `developer:code`.
- New task types are added only when the scorecard shows that one type hides two different results. Keep the list small, so each type gathers enough runs to say something.

### 2. The route, recorded on every run

The route is what the core chose for a run. It is recorded on the `runs` row when the run is admitted, inside the same transaction (ADR 0106 section 7). The runner then starts the run with exactly that route.

Columns to add to `factory.runs`, in a migration in the dispatch slice that comes next in M3.2, not now:

| Column                   | Type          | Notes                                                                                                                                                     |
| ------------------------ | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `task_type`              | text not null | From section 1                                                                                                                                            |
| `provider`               | text not null | The provider entry name, as in the proxy's provider list (for example `anthropic`, `deepinfra`)                                                           |
| `model_family`           | text not null | From the model catalog (section 5). Kept on the run so the QA rule reads the store, not the agent (ADR 0112)                                              |
| `service_tier_requested` | text not null | `standard`, `flex` or `priority`                                                                                                                          |
| `service_tier_served`    | text null     | `standard`, `flex`, `priority` or `mixed`, from the provider's responses (section 8). Null when no response reported it                                   |
| `routing_policy_version` | text not null | The policy version the route came from                                                                                                                    |
| `model_catalog_version`  | text not null | The catalog version the price and family came from                                                                                                        |
| `capacity_retries`       | integer null  | Flex capacity rejections retried inside the run (section 9)                                                                                               |
| `capacity_wait_seconds`  | integer null  | Time spent waiting on those retries                                                                                                                       |
| `first_token_ms`         | integer null  | Time to the first output token of the first request, where the runtime can report it                                                                      |
| `reported_cost_usd`      | numeric null  | The runtime's own cost figure, kept for comparison. `cost_usd` becomes the cost the core computes from `tokens` and the catalog price for the served tier |

`runs.model` and `runs.runtime` keep their meaning: the model and runtime the runner started the run with. The route is also a P-11 decision record (decider id, input hash, output, confidence), so routing builds the same labelled history as every other decision point.

### 3. Quality, speed and cost signals

All signals come from rows the runner records from outside the agents (essential 6). None comes from an agent's own report. Item signals are attributed to the model of the item's first Developer run. An item whose Developer runs used more than one model is counted as `mixed` and left out of per-model rates.

| Signal                  | Precise definition                                                                                                                                                                                                                | Measurable today?                                                                                           |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| QA first pass           | The item's first `qa_verdict` is a pass                                                                                                                                                                                           | Yes, from `evidence` once QA runs record verdicts (M3.2)                                                    |
| Fix rounds              | The number of failed `qa_verdict` rows before the item's first pass. Counted from evidence, not from the `qa_round` counter, which resets                                                                                         | Yes, from `evidence`                                                                                        |
| CI green on first push  | The first `ci_run` with a final conclusion (`success` or `failure`) on the item's pull request is `success`                                                                                                                       | Yes, from `ci_run` evidence (ADR 0113)                                                                      |
| Escalated               | The item had a transition into Escalated to Council or Escalated to Didi in the window                                                                                                                                            | Yes, from `transitions`                                                                                     |
| Staging failed          | A `staging_check` failed after the item's merge                                                                                                                                                                                   | Yes, once M3.4 records staging checks                                                                       |
| Reopened                | The item went from Done to an earlier state                                                                                                                                                                                       | Yes, from `transitions`                                                                                     |
| QA escape (`qa:review`) | A QA pass followed, on that commit or later on the same item, by a failed `preview_check` or `staging_check`, or by a reopen. The N-26 escape rate (D-161) is escapes over QA passes                                              | Yes, from `evidence` and `transitions`                                                                      |
| Finished                | The item reached Done                                                                                                                                                                                                             | Yes                                                                                                         |
| Minutes                 | `runs.minutes`, summed per item for the item roll-up                                                                                                                                                                              | Yes                                                                                                         |
| Time to first token     | `runs.first_token_ms`                                                                                                                                                                                                             | No. Needs the new column and a runtime that reports it. Claude Code's JSON result does not, as far as known |
| Capacity wait           | `runs.capacity_wait_seconds`                                                                                                                                                                                                      | No. Needs the new column (section 9)                                                                        |
| Cost                    | `runs.cost_usd`, priced from `tokens` at the served tier. Cost per finished task is the sum of all runs of that task type on finished items, over the number of finished items. A run on an item that never finished still counts | Partly. Tokens are recorded today; the served tier and catalog price need the new columns                   |
| Run outcome             | `runs.outcome`: share of runs ending `success`, `budget_exceeded`, `timeout`, `usage_exhausted`                                                                                                                                   | Yes                                                                                                         |

For `triage` and `council` there is no outside quality signal yet. Their quality is not scored until one is defined (for example, how often Didi or the Council changes what Triage produced). Until then their scorecard rows show cost, speed and run outcome only, and their policy changes need a rehearsal comparison.

### 4. The scorecard

- A daily roll-up per task type, provider, model and served tier: runs, finished items, cost per finished task, success rate (finished over started items), QA first-pass rate, mean fix rounds, CI green on first push, escalation, staging failure and reopen rates, QA escape rate for `qa:review`, and minutes (median and 90th percentile).
- It lives in a new table, `factory.model_scorecard`, one row per day and key, with the window it covers (30 days to start, a setting) and the policy and catalog versions in that window. A table rather than a view: proposals cite the exact rows they were made from, and those rows must not change under them.
- It is computed by a plain function in `src/core/` from `runs`, `evidence` and `transitions`, with the day passed in (D-162). It is deterministic and recomputable: running it again for a past day gives the same rows, and a test checks that.
- It is refreshed once a day, in the same daily job as the M4.5 spend roll-up, which reads the same `runs` rows.
- A row with fewer finished items than `scorecard_min_items` (a setting, 10 to start) is marked too few. Proposals ignore it.
- The cost sheet (`docs/costs.md`) is updated from the scorecard once runs exist.

### 5. The routing policy and the model catalog

Both are settings, so they change without a deploy, and every settings change is logged with who made it.

**Model catalog** (`model_catalog`): one entry per model, with a version for the whole catalog.

```json
{
  "version": "2026-10-31.1",
  "models": {
    "claude-sonnet-5-5": {
      "provider": "anthropic",
      "family": "claude",
      "tiers": ["standard"],
      "pricePerMTok": {
        "standard": { "input": 2, "cachedInput": 0.2, "cacheWrite": 2.5, "output": 10 }
      },
      "maxOutputTokens": null,
      "priceSource": "anthropic list price",
      "priceReadOn": "2026-10-31"
    }
  }
}
```

The JSON above shows the shape only. Prices come from `docs/costs.md` and are confirmed on the provider's page before a model is used. The catalog replaces the price table in `pricing.ts` as the source of prices, so the core and the runtimes use one table.

**Routing policy** (`model_routing_policy`): per task type, an ordered list of candidates, each a provider, a model and a tier, plus rules.

```json
{
  "version": "2026-10-31.1",
  "qaIndependence": "model_id",
  "taskTypes": {
    "developer:code": {
      "candidates": [
        { "provider": "anthropic", "model": "claude-sonnet-5-5", "tier": "standard" }
      ],
      "onCapacity": "wait"
    },
    "qa:review": {
      "candidates": [
        { "provider": "anthropic", "model": "claude-opus-5-5", "tier": "standard" }
      ],
      "onCapacity": "wait"
    }
  }
}
```

The first policy reproduces today's choices (D-185, D-186), so turning routing on changes nothing until Didi approves a change.

**How a route is chosen.** A pure function in the core, a P-11 decision point backed by a rule: it takes the task type, the item's earlier runs, the policy, the catalog and the approved provider list, and returns the first candidate that passes every hard rule. If none passes, the dispatch is refused with a new reason, `no_route`, writes nothing, and the runner raises an alert. `onCapacity` is `wait` (the dispatch queues as today) or `next_candidate` (after a `usage_exhausted` capacity end, the next dispatch of that item takes the next candidate that passes the hard rules).

**Hard rules, enforced in the core, never in data alone:**

1. **QA independence.** With `qaIndependence: "family"`, QA's model family differs from the family of every Developer run on the same item, read from `runs.model_family`. This restores P-04 once a second family is approved. While no second family is approved, the setting is `"model_id"` and the D-158 waiver applies: QA's model id differs from the Developer's. Moving the setting to `"family"` is Didi's decision when a second family passes D-154.
2. **Known price.** A model with no catalog price for the requested tier cannot be chosen. A model that may be served at another tier needs a price for that tier too, and an unsupported tier is priced at Standard. The core fails closed, as `pricing.ts` does today.
3. **Approved provider.** A provider that has not passed the D-154 check cannot be chosen. The approved list is a setting (`model_providers_approved`) that names the decision that approved each provider. Only Didi changes it. Anthropic is on it (D-171). DeepInfra is not until its check is done.
4. **Output cap.** A candidate whose `maxOutputTokens` is below the task type's need (a setting per task type) cannot be chosen.

**Where the decision is made.** In the core, recorded on the run (D-162). The runner builds the run's proxy provider list from the route, with only the chosen provider in it, so a run can reach no other provider. The gateway (D-142, second release) only carries out the route it is given. It never picks a model. The egress proxy never picks a model either.

### 6. Changing the policy

- The system computes proposals from the scorecard: for example "for `developer:code`, Qwen3 Coder on Flex finishes items at 0.40 USD each with a QA first-pass rate within 5 points of Sonnet, over 24 items". A proposal cites its scorecard rows.
- Proposals are ordinary ideas for Didi. Didi approves a change, and the new policy version is written to settings (P-17). The scorecard and any model only advise (P-12).
- The thresholds that make a proposal (minimum items, how much quality may drop for how much saving) are proposed by the system and approved by Didi (P-17). They are settings.
- Later, optional automatic changes within limits Didi sets. Open question 3.

### 7. Benchmarking beyond live runs

- **Live runs are the main source.** Every run feeds the scorecard.
- **The rehearsal comparison is the first benchmark** (N-31): the same rehearsal items run on Sonnet 5.5 and on the open-model candidates, compared on cost per finished task and the quality signals above. It also checks the runtime questions in section 10.
- **An optional evaluation set.** A small fixed set of past items with known good results, replayed on candidate models once a week on Flex, scored the same way, and kept apart in the scorecard (task type suffix `:eval`). It spends money, so it is open question 2.

### 8. Service tiers

- The tier is part of each candidate in the policy. The default for runner work on a provider that offers Flex is Flex. Standard is named per task type or project where it is needed. Priority is never chosen without Didi naming it, because it costs 50% more.
- The tier actually served is recorded in `runs.service_tier_served`: one value if every response in the run reported the same tier, `mixed` otherwise. The cost is priced at the served tier, and a `mixed` or unknown run is priced at Standard, which is what an unsupported tier is billed at.
- **Who sets the tier on the request.**
  - Runtimes that build their own requests (the Messages API loop, and an OpenAI-compatible loop if one is built) set `service_tier` from the task file, and read the served tier from each response.
  - Runtimes that build requests we do not control (Claude Code) cannot set it. Either the egress proxy adds `service_tier` to that provider's request bodies, or those runtimes stay on Standard. This is an exception to D-185's byte-for-byte rule, so it is open question 1.
- **Why an added field should not break caching.** DeepInfra caches on the prompt prefix, the tokens the model reads. A top-level `service_tier` field is a request option and is not part of the prompt, so the prefix does not change. The proxy would insert the field once, at the same place, in every request of the run, so every request of the run is changed the same way. This is reasoning, not a measurement. The rehearsal confirms it with the ADR 0106 check 14 (cached input tokens above zero after the first turn) on a run with the field added.
- **How the proxy would do it, if approved.** Only for a provider entry marked as supporting tiers, with the tier from the run's route. The proxy inserts `"service_tier":"<tier>",` right after the body's opening brace and changes no other byte. If the body already has a `service_tier`, the proxy refuses the request rather than override it, so an agent cannot pick its own tier. The proxy reads the `service_tier` field from responses (it already sees the plain HTTP side) without changing them, and reports the served tiers in the run's proxy summary for the runtime adapter. It still never logs a payload.

### 9. Flex rejections

A Flex 429 means DeepInfra was busy. It must not end a long Developer run.

- **Three different responses, three different ends.**

| Response                                                                                                                                | Meaning           | What happens                                                                                                        |
| --------------------------------------------------------------------------------------------------------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------- |
| 429 on a Flex request, with an overload error (`engine_overloaded`, or the queue-timeout form DeepInfra returns, read in the rehearsal) | Flex capacity     | Retried inside the run, as below. After the bound: `usage_exhausted` with cause `capacity`, and the dispatch queues |
| Any other 429, or `rate_limit_error`                                                                                                    | Rate limit        | As today: the run ends `usage_exhausted` with cause `rate_limit`. No retry inside the run                           |
| 402, or a billing error                                                                                                                 | Out of credit     | As today: `usage_exhausted` with cause `out_of_credit`, and an alert to Didi. DeepInfra's exact form is checked     |
| 403 with the proxy's ceiling message                                                                                                    | The run's ceiling | As today: `budget_exceeded`                                                                                         |

- **The retry.** Backoff with a growing wait (30 seconds, doubling, at most 5 minutes to start), at most `flex_capacity_retries` times per run (a setting, 3 to start). The wait counts against the run's minute limit, which Kubernetes enforces anyway (`activeDeadlineSeconds`). It does not count against the proxy's model request ceiling, because a rejected request is not billed. The run records `capacity_retries` and `capacity_wait_seconds`.
- **Queue or fail fast.** `fail_fast` is a per-candidate setting in the policy, false to start: a queued Flex request is served when capacity frees, without a retry. The rehearsal measures both.
- **Where it is built.**
  - In the runtimes that build their own requests: the Messages API loop keeps `maxRetries: 0` for every other error, and gains this one bounded retry for a Flex capacity 429 only. This changes slice 4's rule for that case alone.
  - For Claude Code: its own retry behaviour on a 429 is measured in the rehearsal. Whatever it does, the proxy's bounds below hold.
  - In the egress proxy: a request whose upstream answered 429 does not count against the model request ceiling. A separate, small ceiling on rejected requests per run (a setting, `max_rejected_model_requests`, 5 to start) stops a runtime that retries without end; past it the proxy answers 403 and the run ends `budget_exceeded`. Both stay outside the model's reach (ADR 0106 section 6).
  - In the Kubernetes adapter: `usageCause` maps a Flex capacity 429 to `capacity`, not `rate_limit`, using the route's requested tier and the error type.

### 10. Runtimes for open models

Two ways to run an open model as an agent:

| Runtime                                                       | For                                                                                               | Risks, to measure                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code against DeepInfra's Anthropic-compatible endpoint | The same image, flags, budgets and proxy as today. Only `ANTHROPIC_BASE_URL` and the model change | Claude Code is built for Claude models, and features may not work with others (tool use details, thinking, caching marks). Claude Code may ask for more than 16384 output tokens. Its own cost figure and `--max-budget-usd` use its own prices, so for a non-Claude model they may be wrong; the proxy ceiling, the deadline and the core's catalog-priced cost are the backstops. Whether the endpoint reports cached tokens and accepts `service_tier` is unknown |
| An OpenAI-compatible agent runtime                            | Built for these endpoints. Sets `service_tier` and reads the served tier itself                   | A new runtime: either our own loop (like the Messages API loop, with tools) or an outside agent tool, which would be a new product to choose. More to build and test                                                                                                                                                                                                                                                                                                 |

Which works is measured in the rehearsal, not assumed. Choosing a new runtime product is open question 4.

### 11. Where each piece is built

| Piece                                                                                             | When                                                                                   |
| ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| The `runs` columns, the model catalog and policy settings, route choice and recording, `no_route` | The dispatch slice that comes next in M3.2                                             |
| The Flex retry and the served tier                                                                | The runtimes (agent images) and the Kubernetes adapter, before the first DeepInfra run |
| The proxy's 429 counting and rejected-request ceiling                                             | The egress proxy, before the first DeepInfra run                                       |
| The proxy adding `service_tier`, if open question 1 is yes                                        | The egress proxy, before the first Claude Code run on Flex                             |
| The scorecard                                                                                     | With M4.5, the spend roll-up                                                           |
| Proposals from the scorecard                                                                      | After cutover                                                                          |
| The evaluation set, if open question 2 is yes                                                     | After the rehearsal comparison                                                         |

**Prerequisite.** DeepInfra passes the D-154 provider check (no training on our data, a data processing agreement) before any project code reaches it, including the rehearsal comparison. Until then it is not on `model_providers_approved`, and the core cannot route to it.

## Constraints

- The core decides the route. It never calls a model, reads the clock or makes random choices (D-162, essentials 4 and 5).
- A model only advises. No scorecard result or model changes the policy without Didi (P-12, P-17).
- No provider sees project code before it passes D-154. No real personal data reaches any provider.
- Money: no paid plan, new provider account or evaluation budget without Didi. Priority tier is never chosen without Didi.
- Agents never hold a model credential and cannot choose their own model, provider or tier (ADR 0106 section 5).
- The proxy changes no byte of a request body unless open question 1 is approved, and then only by inserting `service_tier` for a provider marked as supporting it.
- No code before this ADR is accepted.

## How success is judged

1. With the first policy (today's models), every dispatch records the same model as before, and the `runs` row carries task type, provider, family, requested tier, policy version and catalog version.
2. A QA dispatch whose only candidate has the Developer's family is refused with `no_route` when `qaIndependence` is `family`, and admitted when it is `model_id` and the model ids differ.
3. A candidate with no catalog price, or from a provider not on `model_providers_approved`, is never chosen, and a test proves both.
4. The route choice is a pure function: the same inputs give the same route, and a replay of recorded runs gives the recorded routes.
5. The scorecard for a fixed set of rows gives fixed results, and recomputing a past day gives the same rows.
6. A simulated Flex capacity 429 is retried up to the bound, does not count against the request ceiling, and then ends the run `usage_exhausted` with cause `capacity`. A simulated rate-limit 429 ends the run at once with cause `rate_limit`. A runtime that retries without end is stopped by the rejected-request ceiling.
7. A response that reports `service_tier: "standard"` for a Flex request records `standard` and is priced at Standard.
8. If open question 1 is yes: a proxied request body differs from the original only by the inserted field; a body that already has `service_tier` is refused; in a rehearsal run through the proxy with the field added, turns after the first report cached input tokens above zero.
9. The rehearsal comparison reports cost per finished task and the quality signals for Sonnet 5.5 and each open-model candidate, and records which runtime worked.

## Reasons

- Nobody knows which model suits which task. Recording the route on every run and scoring finished items turns each run into data, and the policy can follow the data.
- Keeping the choice in the core makes it deterministic, replayable and visible to the guards. The QA family rule needs the item's earlier runs, which only the store has.
- The gateway arrives in the second release. Routing that lives in the core works now and stays the same when the gateway arrives: the gateway carries out the route.
- Flex fits the runner: its work is asynchronous and can wait. A bounded retry inside the run keeps the 20% saving without losing long runs to a busy spell.
- Pricing from one catalog at the served tier gives the true cost, even when a model silently falls back to Standard.

## Consequences

- The `runs` table grows by eleven columns, and `cost_usd` becomes the core's catalog-priced figure. M4.5 reads the same rows.
- Prices move from `pricing.ts` into a setting. A wrong price in settings now affects routing and budgets, so price changes are logged and confirmed against the provider's page.
- Slice 4's `maxRetries: 0` rule gains one exception, and the proxy's ceiling counts only requests the provider served.
- The cost sheet becomes a view of real data once runs exist.
- Scores need volume. With about 150 items in a quiet month, a task type and model pair needs weeks to reach the minimum, so early proposals come from the rehearsal comparison and the evaluation set.
- If open question 1 is no, Claude Code runs on DeepInfra stay on Standard and cost 25% more than Flex.

## Open questions for Didi

| Question                                                                                                                                                                                             | Recommended answer                                                                                                                                                                                                                                                                                                                                                                                             |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. May the egress proxy add `service_tier` to request bodies for runtimes that cannot set it (Claude Code), as an exception to D-185's byte-for-byte rule? Otherwise those runtimes stay on Standard | **Decided (D-203):** yes, as a narrow exception to D-185: the proxy inserts only `service_tier`, only for providers marked as supporting tiers, refuses a body that already carries one, and only once the rehearsal shows prompt caching still works with the field added                                                                                                                                     |
| 2. A weekly evaluation set replayed on candidate models on Flex costs money. Approve it, and with what budget?                                                                                       | **Decided (D-204):** yes, after the rehearsal comparison: about 10 past items, open models on Flex only, a hard cap of 10 USD a week (a setting); Claude once a month as a baseline inside the same cap                                                                                                                                                                                                        |
| 3. Should the system later change the policy by itself within limits you set?                                                                                                                        | **Decided (D-205):** not before cutover. After cutover, only reordering candidates Didi already approved for a task type, when cost per finished task falls and no quality signal is worse than Didi's threshold; never adding a model or provider, never changing `qaIndependence`, never choosing Priority. Each change is reported in the daily check                                                       |
| 4. Which runtime runs open models: Claude Code on DeepInfra's Anthropic-compatible endpoint, or a new OpenAI-compatible agent runtime?                                                               | **Decided (D-206):** Claude Code on DeepInfra's Anthropic-compatible endpoint first, in the rehearsal. OpenCode is the named fallback if Claude Code misses features, hits the output cap or loses caching; Qwen Code is compared if Qwen3 Coder becomes the Developer's main model; an in-house loop is the last resort. The weekly evaluation set (D-204) also compares runtimes on the same tasks and model |
| 5. Tier defaults: Flex for all runner work on DeepInfra, Standard only where named?                                                                                                                  | **Decided (D-207):** Flex for every task type to start. Standard for a task type or a named project when the scorecard shows Flex waits hurting it (for example capacity waits above 10% of its minutes), proposed by the system and approved by Didi, or when Didi names it. Priority only if Didi names it                                                                                                   |
| 6. The D-154 provider check for DeepInfra: its API terms, privacy policy and data processing agreement                                                                                               | **Decided (D-208):** DeepInfra passes the D-154 check for models it hosts itself. Its terms promise no training on customer data and incorporate a DPA. Anthropic and Google models reached through DeepInfra are not covered and are not routed there                                                                                                                                                         |
| 7. When a second family passes D-154, switch QA independence from model id to family (restoring P-04)?                                                                                               | Yes, as soon as the rehearsal shows a QA candidate of another family holds quality (for example Kimi K2.6 reviewing a Qwen3 Coder Developer). D-158's waiver then ends                                                                                                                                                                                                                                         |
| 8. The thresholds for proposals: minimum finished items, window, and how much quality may drop for a saving                                                                                          | 10 finished items per task type and model, a 30-day window, and no proposal that lowers QA first pass or raises the escape rate by more than 5 points. Tuned after cutover                                                                                                                                                                                                                                     |
