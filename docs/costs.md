# Cost sheet

Status: planning figures, 2026-10-31. Fixed costs are the amounts Didi accepted for planning. Model prices come from a search snapshot of DeepInfra's pricing page and from Anthropic's list prices. **Every price marked "to confirm" is read on the provider's own page before it is relied on.** Once agent runs exist, this sheet is updated from the model scorecard ([ADR 0114](./decisions/0114-model-evaluation-routing-and-tiers.md) section 4) and the M4.5 spend roll-up, and real cost per finished task replaces the estimates below.

All amounts are US dollars.

## 1. Fixed monthly costs

| Item                        | Per month                                 | Status                                                                          | Source                                                                                                  |
| --------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| DigitalOcean cluster        | 48                                        | Confirmed                                                                       | D-194: two 2 vCPU / 4 GiB nodes at 24 each, DigitalOcean's pricing page (Didi's screenshot, 2026-10-31) |
| Supabase Pro                | 25                                        | To confirm                                                                      | Accepted by Didi for planning, 2026-10-31                                                               |
| DigitalOcean Spaces backups | 5                                         | To confirm                                                                      | Accepted by Didi for planning, 2026-10-31                                                               |
| Cloudflare                  | 5                                         | To confirm                                                                      | Accepted by Didi for planning, 2026-10-31                                                               |
| MagicPath                   | 10                                        | To confirm                                                                      | Accepted by Didi for planning, 2026-10-31                                                               |
| Domains                     | Yearly renewals divided by 12             | To confirm. Amount not recorded                                                 | Accepted by Didi for planning, 2026-10-31                                                               |
| Alerts provider (M4.3)      | A few dollars                             | To confirm when ADR 0109 picks the provider                                     | Accepted by Didi for planning, 2026-10-31                                                               |
| Windmill Cloud              | 0                                         | Free tier for now (D-163). Self-hosting Windmill later may add a third node, 24 | D-163, D-165                                                                                            |
| GitHub                      | 0                                         | For now                                                                         | Accepted by Didi for planning, 2026-10-31                                                               |
| Weekly evaluation set       | up to about 40 (10 a week)                | Approved cap (D-204), a setting. Starts after the rehearsal                     |
| Didi's own Claude plan      | 180 (Max) now, maybe about 20 (Pro) later | Didi's choice                                                                   | Didi, 2026-10-31                                                                                        |
| Grok                        | 300                                       | Dropped at cutover                                                              | Didi, 2026-10-31                                                                                        |
| Linear                      | Not recorded                              | Cancelled after cutover                                                         | Didi, 2026-10-31                                                                                        |

Infrastructure without Didi's own plans comes to about 93, plus domains and the alerts provider: about 100 to 110 a month.

## 2. Model prices

Per 1 million tokens: input, cached input, output. Standard tier.

| Model                  | Provider  | Input  | Cached input | Output | Status                                                                                                        |
| ---------------------- | --------- | ------ | ------------ | ------ | ------------------------------------------------------------------------------------------------------------- |
| DeepSeek V4 Flash      | DeepInfra | 0.09   | 0.018        | 0.18   | To confirm on deepinfra.com                                                                                   |
| Qwen3 Coder 480B Turbo | DeepInfra | 0.30   | 0.10         | 1.00   | To confirm on deepinfra.com                                                                                   |
| GLM 5.3 (promotion)    | DeepInfra | 0.5625 | 0.125        | 2.50   | To confirm on deepinfra.com. List price 0.90 input, 4.00 output, cached not known                             |
| DeepSeek V4 Pro        | DeepInfra | 1.30   | 0.10         | 2.60   | To confirm on deepinfra.com                                                                                   |
| Kimi K2.6              | DeepInfra | 0.75   | 0.15         | 3.50   | To confirm on deepinfra.com                                                                                   |
| Kimi K3                | DeepInfra | 2.85   | 0.285        | 14.25  | To confirm on deepinfra.com                                                                                   |
| Claude Haiku 5.5       | Anthropic | 0.10   | 0.01         | 0.50   | Cached input from `src/agent-images/claude-api/pricing.ts`. A higher rate applies above 100,000 prompt tokens |
| Claude Sonnet 5.5      | Anthropic | 2      | 0.20         | 10     | Anthropic list price                                                                                          |
| Claude Opus 5.5        | Anthropic | 4      | 0.20         | 20     | Anthropic list price                                                                                          |

Source for the DeepInfra rows: a search snapshot of deepinfra.com/pricing, given by Didi on 2026-10-31. Cache write prices on DeepInfra are not known.

**DeepInfra service tiers** (docs.deepinfra.com, chat completions page): Flex is 20% off and best effort, Priority is 50% more. Not every model supports tiers; an unsupported tier is billed at Standard. Whether the Flex discount also applies to cached input is to confirm.

## 3. Workload model

A quiet month: about 150 items, each with one Developer run, one QA run and half a fix round. That gives about:

- 500 million cached input tokens
- 26 million uncached input tokens
- 20 million output tokens

Busy months are 4 to 5 times this.

## 4. Model cost per quiet month

All work on one model, from the workload above. Flex is 0.8 times Standard, shown only for DeepInfra models and only if the model supports tiers.

| Model                                     | Standard  | Flex (0.8x) | Busy month, Standard (4 to 5x) |
| ----------------------------------------- | --------- | ----------- | ------------------------------ |
| DeepSeek V4 Flash                         | about 15  | about 12    | 60 to 75                       |
| Claude Haiku 5.5                          | about 18  | none        | 70 to 90                       |
| Qwen3 Coder 480B Turbo                    | about 80  | about 62    | 320 to 400                     |
| GLM 5.3 (promotion)                       | about 127 | about 102   | 510 to 635                     |
| DeepSeek V4 Pro                           | about 136 | about 109   | 545 to 680                     |
| Kimi K2.6                                 | about 165 | about 132   | 660 to 825                     |
| Claude Sonnet 5.5                         | about 350 | none        | 1,400 to 1,750                 |
| Kimi K3                                   | about 500 | about 400   | 2,000 to 2,500                 |
| Claude Opus 5.5                           | about 605 | none        | 2,420 to 3,025                 |
| Developer on Qwen3 Coder, QA on Kimi K2.6 | about 100 | about 80    | 400 to 500                     |

How a row is worked out, for Qwen3 Coder: 500 x 0.10 + 26 x 0.30 + 20 x 1.00 = 77.8.

## 5. Scenario totals per quiet month

| Scenario                                                                | Total            | Made of                                                                                                     |
| ----------------------------------------------------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------- |
| Today                                                                   | about 480 and up | Grok 300 and Claude Max 180, plus whatever infrastructure is running                                        |
| Long term on the Claude API                                             | about 415 to 615 | Infrastructure, Didi's Claude plan (Pro about 20 to Max 180), and Claude model usage of about 300 to 350    |
| Long term on DeepInfra                                                  | about 145 to 285 | Infrastructure, Claude Pro, and open-model usage from DeepSeek V4 Flash (about 15) to Kimi K2.6 (about 165) |
| Long term on DeepInfra: Developer Qwen3 Coder, QA Kimi K2.6, Claude Pro | about 215        | Infrastructure, Claude Pro, and about 100 of model usage at Standard (about 80 on Flex)                     |

The totals are rounded planning figures from 2026-10-31. Their parts add up to within about 20 of them, depending on domains, the alerts provider and the tier served. Model usage in a busy month is 4 to 5 times the quiet-month figure; the fixed costs do not change.

## 6. Caveats

- **Cost per finished task is what counts**, not price per token. A cheaper model that needs more fix rounds, fails QA more often or escalates more can cost more per finished item. The scorecard measures this (ADR 0114 section 3).
- **Cache hit rates drive the totals.** Most input is cached in the workload model. With worse cache hit rates, Qwen3 Coder could cost about 180 a quiet month instead of about 80. Prompt caching is required (D-185), and each run records cached and uncached tokens.
- **Flex may not be served.** A model without tier support is billed at Standard, and the served tier is recorded per run (ADR 0114 section 8).
- **Prices change.** DeepInfra prices come from a search snapshot, and GLM 5.3 is on a promotion. Every DeepInfra price is confirmed on deepinfra.com before a model is added to the model catalog.
- **DeepInfra is not usable yet.** It must pass the D-154 provider check before any project code reaches it (N-31).
