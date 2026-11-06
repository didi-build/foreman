# Cost sheet

Status: planning figures, 2026-10-31; fixed costs and Anthropic prices read again 2026-11-06. Fixed costs are the amounts Didi accepted for planning. DeepInfra prices are read from deepinfra.com/pricing and deepinfra.com/models on 2026-10-31. Anthropic prices are Anthropic's list prices. **A price is read again on the provider's own page before a model is added to the model catalog.** Once agent runs exist, this sheet is updated from the model scorecard ([ADR 0114](./decisions/0114-model-evaluation-routing-and-tiers.md) section 4) and the M4.5 spend roll-up, and real cost per finished task replaces the estimates below.

All amounts are US dollars.

## 1. Fixed monthly costs

| Item                        | Per month                                 | Status                                                      | Source                                                                                                                                                                                                                                                                                                                                                           |
| --------------------------- | ----------------------------------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DigitalOcean cluster        | 48                                        | Confirmed 2026-11-06                                        | D-194: two `s-2vcpu-4gb` Basic nodes (2 vCPU, 4 GiB) at 24 each, 4,000 GiB of transfer each, pooled; the DOKS control plane is free. digitalocean.com/pricing/droplets and /pricing/kubernetes, read 2026-11-06                                                                                                                                                  |
| Supabase Pro                | 25                                        | Confirmed 2026-11-06                                        | supabase.com/pricing, read 2026-11-06: 25 a month including 10 a month of compute credits, enough for one Micro instance                                                                                                                                                                                                                                         |
| DigitalOcean Spaces backups | 5                                         | Confirmed 2026-11-06                                        | digitalocean.com/pricing/spaces-object-storage, read 2026-11-06: 5 a month for 250 GiB                                                                                                                                                                                                                                                                           |
| Cloudflare                  | 0 to 5                                    | Checked 2026-11-06                                          | The R2 state bucket fits the free tier (10 GB-month of storage, developers.cloudflare.com/r2/pricing, read 2026-11-06). The 5 is the Workers Paid minimum (developers.cloudflare.com/workers/platform/pricing), needed only if the gallery previews run on Workers                                                                                               |
| MagicPath                   | 10                                        | To confirm                                                  | Accepted by Didi for planning, 2026-10-31                                                                                                                                                                                                                                                                                                                        |
| Domains                     | Yearly renewals divided by 12             | To confirm. Amount not recorded                             | Accepted by Didi for planning, 2026-10-31                                                                                                                                                                                                                                                                                                                        |
| Alerts provider (M4.3)      | A few dollars                             | To confirm when ADR 0109 picks the provider                 | Accepted by Didi for planning, 2026-10-31                                                                                                                                                                                                                                                                                                                        |
| Windmill Cloud              | 0                                         | Confirmed 2026-11-06                                        | Free plan with 1,000 executions a month (windmill.dev/docs/getting_started/how_to_use_windmill, read 2026-11-06; D-163, D-164). Self-hosting Windmill later may add a third node, 24 (D-165)                                                                                                                                                                     |
| Container registry          | 0 to 20                                   | Open: Didi's choice before sitting 3 of first hosting       | Seven images go to a registry (the OpenCode, Messages API and repo map agent images, the egress proxy, the state API, the GitHub receiver and the run watcher). DigitalOcean Container Registry, read 2026-11-06: Starter free with 1 repository, Basic 5 a month with 5 repositories and 5 GiB, Professional 20 a month with unlimited repositories and 100 GiB |
| GitHub                      | 0                                         | For now                                                     | Accepted by Didi for planning, 2026-10-31                                                                                                                                                                                                                                                                                                                        |
| Weekly evaluation set       | up to about 40 (10 a week)                | Approved cap (D-204), a setting. Starts after the rehearsal |
| Didi's own Claude plan      | 180 (Max) now, maybe about 20 (Pro) later | Didi's choice                                               | Didi, 2026-10-31                                                                                                                                                                                                                                                                                                                                                 |
| Grok                        | 300                                       | Dropped at cutover                                          | Didi, 2026-10-31                                                                                                                                                                                                                                                                                                                                                 |
| Linear                      | Not recorded                              | Cancelled after cutover                                     | Didi, 2026-10-31                                                                                                                                                                                                                                                                                                                                                 |

Infrastructure without Didi's own plans comes to about 93, plus domains and the alerts provider: about 100 to 110 a month.

## 2. Model prices

Per 1 million tokens, Standard tier.

**Source.** DeepInfra prices come from the data behind deepinfra.com/pricing and deepinfra.com/models, read on 2026-10-31. The list covers every text-generation model on those pages that is public, not deprecated and priced per token: 69 models. It leaves out Anthropic and Google models resold by DeepInfra, because D-208 covers only DeepInfra's own open models.

**Columns.**

- Tools: whether DeepInfra lists tool calling for the model. Agent work needs it.
- Flex: whether the model supports service tiers. Flex is 0.8 times Standard (docs.deepinfra.com, chat completions page). An unsupported tier is billed at Standard.
- Cached input "none listed": DeepInfra shows no cached price. The month is worked out with all cached input at the full input price, so these rows are upper estimates.

Cache write prices on DeepInfra are not listed. Some models on the page also carry a separate "discount" figure that the shown price does not use; the shown price is used here.

**Anthropic, direct, for comparison:**

| Model             | Input | Cached input | Output | Note                                                                                                                                                                                              |
| ----------------- | ----- | ------------ | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Haiku 5.5  | 0.10  | 0.01         | 0.50   | Cached input from the price table the Messages API image had before the model catalog replaced it. A higher rate applies above 100,000 prompt tokens, which the catalog does not model yet (O-26) |
| Claude Sonnet 5.5 | 2     | 0.10         | 10     | Anthropic list price, read 2026-11-06 (cache hits fell from 0.20 to 0.10)                                                                                                                         |
| Claude Opus 5.5   | 4     | 0.20         | 20     | Anthropic list price                                                                                                                                                                              |

## 3. Workload model

A quiet month: about 150 items, each with one Developer run, one QA run and half a fix round. That gives about:

- 500 million cached input tokens
- 26 million uncached input tokens
- 20 million output tokens

A busy month is worked out as 5 times this, the top of the 4 to 5 times range.

How a month is worked out, for Qwen3 Coder 480B Turbo: 500 x 0.10 + 26 x 0.30 + 20 x 1.00 = 77.8, about 78. Busy month: 5 x 77.8 = 389. On Flex: 0.8 x 389 = 311.

## 4. Model cost per month

### Shortlist

Agent-capable models (tool calling listed) that are realistic candidates for each kind of work. The scorecard decides the real routing (ADR 0114).

| Model                                     | Likely use           | Quiet month | Busy month  | Busy month on Flex |
| ----------------------------------------- | -------------------- | ----------- | ----------- | ------------------ |
| DeepSeek V4 Flash 0731                    | Triage, simple tasks | 13          | 63          | 51                 |
| DeepSeek V4.1 Flash                       | Triage, simple tasks | 20          | 101         | 81                 |
| GLM 5.3 Flash                             | Triage, simple tasks | 29          | 144         | no Flex            |
| Qwen3 Coder 480B Turbo                    | Developer            | 78          | 389         | 311                |
| GLM 4.7                                   | Developer            | 85          | 427         | 342                |
| DeepSeek V4 Pro                           | Developer, QA        | 136         | 679         | 543                |
| GLM 5.2                                   | Developer, QA        | 138         | 688         | 550                |
| Kimi K2.6                                 | QA, hard tasks       | 164         | 822         | 658                |
| GLM 5.3                                   | QA, hard tasks       | 203         | 1,017       | 814                |
| Kimi K3                                   | Escalation only      | 502         | 2,508       | no Flex            |
| Developer on Qwen3 Coder, QA on Kimi K2.6 | Mixed                | about 100   | about 500   | about 400          |
| Claude Haiku 5.5 (Anthropic)              | Comparison           | about 18    | about 90    | no Flex            |
| Claude Sonnet 5.5 (Anthropic)             | Comparison           | about 300   | about 1,510 | no Flex            |
| Claude Opus 5.5 (Anthropic)               | Comparison           | about 605   | about 3,025 | no Flex            |

Changes from the earlier search snapshot: GLM 5.3 is now at its list price (0.90 input, 0.20 cached, 4.00 output), so it costs about 203 a quiet month instead of about 127. DeepSeek V4 Flash 0731 is a newer, cheaper DeepSeek V4 Flash (0.06 input, 0.015 cached).

### All DeepInfra text models

All work on one model, sorted by quiet month. Model names are DeepInfra's model ids.

| Model                                           | Input | Cached input | Output | Tools | Flex | Quiet month | Busy month (5x) | Busy month on Flex |
| ----------------------------------------------- | ----- | ------------ | ------ | ----- | ---- | ----------- | --------------- | ------------------ |
| `XiaomiMiMo/MiMo-V2.6-Flash`                    | 0.140 | 0.003        | 0.280  | Yes   | No   | 11          | 53              | no Flex            |
| `inclusionAI/Ling-3.0-flash`                    | 0.060 | 0.012        | 0.180  | Yes   | No   | 11          | 56              | no Flex            |
| `inclusionAI/Ling-3.0-flash-VL`                 | 0.060 | 0.012        | 0.180  | Yes   | No   | 11          | 56              | no Flex            |
| `meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo`   | 0.020 | none listed  | 0.040  | Yes   | Yes  | 11          | 57              | 45                 |
| `deepseek-ai/DeepSeek-V4-Flash-0731`            | 0.060 | 0.015        | 0.180  | Yes   | Yes  | 13          | 63              | 51                 |
| `ibm-granite/granite-4.2-8b`                    | 0.060 | 0.015        | 0.250  | Yes   | No   | 14          | 70              | no Flex            |
| `deepseek-ai/DeepSeek-V4-Flash`                 | 0.090 | 0.018        | 0.180  | Yes   | Yes  | 15          | 75              | 60                 |
| `mistralai/Mistral-Nemo-Instruct-2407`          | 0.029 | none listed  | 0.030  | Yes   | Yes  | 16          | 79              | 63                 |
| `Qwen/Qwen3.8-Flash`                            | 0.113 | 0.014        | 0.382  | Yes   | No   | 18          | 88              | no Flex            |
| `openai/gpt-oss-20b`                            | 0.030 | none listed  | 0.140  | Yes   | Yes  | 19          | 93              | 74                 |
| `nvidia/NVIDIA-Nemotron-3.5-Lightning`          | 0.060 | 0.030        | 0.160  | Yes   | No   | 20          | 99              | no Flex            |
| `deepseek-ai/DeepSeek-V4.1-Flash-1017`          | 0.200 | 0.006        | 0.600  | Yes   | Yes  | 20          | 101             | 81                 |
| `deepseek-ai/DeepSeek-V4.1-Flash`               | 0.200 | 0.006        | 0.600  | Yes   | Yes  | 20          | 101             | 81                 |
| `ByteDance/Seed-2.0-mini`                       | 0.100 | 0.020        | 0.400  | Yes   | No   | 21          | 103             | no Flex            |
| `Sao10K/L3-8B-Lunaris-v1-Turbo`                 | 0.040 | none listed  | 0.050  | No    | Yes  | 22          | 110             | 88                 |
| `openai/gpt-oss-120b`                           | 0.037 | none listed  | 0.170  | Yes   | No   | 23          | 114             | no Flex            |
| `nvidia/NVIDIA-Nemotron-3.5-Super-VL`           | 0.150 | 0.020        | 0.500  | Yes   | No   | 24          | 119             | no Flex            |
| `mistralai/Mistral-Small-24B-Instruct-2501`     | 0.050 | none listed  | 0.080  | No    | Yes  | 28          | 140             | 112                |
| `zai-org/GLM-5.3-Flash`                         | 0.150 | 0.030        | 0.500  | Yes   | No   | 29          | 144             | no Flex            |
| `XiaomiMiMo/MiMo-V2.6-Pro`                      | 0.430 | 0.004        | 0.870  | Yes   | No   | 30          | 152             | no Flex            |
| `microsoft/phi-4`                               | 0.070 | none listed  | 0.140  | No    | Yes  | 40          | 198             | 158                |
| `mistralai/Mistral-Small-3.2-24B-Instruct-2506` | 0.075 | none listed  | 0.200  | Yes   | Yes  | 43          | 217             | 174                |
| `deepseek-ai/DeepSeek-V4-Flash-Vision-Exp`      | 0.440 | 0.014        | 1.320  | Yes   | Yes  | 45          | 224             | 179                |
| `Qwen/Qwen3-32B`                                | 0.080 | none listed  | 0.280  | Yes   | Yes  | 48          | 238             | 191                |
| `Qwen/Qwen3.5-35B-A3B`                          | 0.140 | 0.050        | 1.000  | Yes   | Yes  | 49          | 243             | 195                |
| `meta-models/Muse-Glimmer-30B`                  | 0.300 | 0.040        | 1.200  | Yes   | No   | 52          | 259             | no Flex            |
| `nvidia/NVIDIA-Nemotron-3-Super-120B-A12B`      | 0.085 | none listed  | 0.400  | Yes   | Yes  | 53          | 264             | 211                |
| `Qwen/Qwen3.5-9B`                               | 0.100 | none listed  | 0.150  | Yes   | Yes  | 56          | 278             | 222                |
| `inclusionAI/Ling-3.1-flash`                    | 0.300 | 0.060        | 0.900  | Yes   | No   | 56          | 279             | no Flex            |
| `MiniMaxAI/MiniMax-M3`                          | 0.280 | 0.056        | 1.100  | Yes   | Yes  | 57          | 286             | 229                |
| `Qwen/Qwen3-235B-A22B-Instruct-2507`            | 0.090 | none listed  | 0.550  | Yes   | Yes  | 58          | 292             | 233                |
| `meta-llama/Llama-4-Scout-17B-16E-Instruct`     | 0.100 | none listed  | 0.300  | Yes   | Yes  | 59          | 293             | 234                |
| `meta-llama/Llama-3.3-70B-Instruct-Turbo`       | 0.100 | none listed  | 0.320  | Yes   | Yes  | 59          | 295             | 236                |
| `Qwen/Qwen3-14B`                                | 0.120 | none listed  | 0.240  | Yes   | Yes  | 68          | 340             | 272                |
| `Qwen/Qwen3-Next-80B-A3B-Instruct`              | 0.090 | none listed  | 1.100  | Yes   | Yes  | 69          | 347             | 277                |
| `ByteDance/Seed-1.8`                            | 0.250 | 0.050        | 2.000  | Yes   | No   | 72          | 358             | no Flex            |
| `Qwen/Qwen3.6-35B-A3B`                          | 0.100 | 0.100        | 0.950  | Yes   | Yes  | 72          | 358             | 286                |
| `Qwen/Qwen3-30B-A3B`                            | 0.120 | none listed  | 0.500  | Yes   | Yes  | 73          | 366             | 292                |
| `Qwen/Qwen3-Coder-480B-A35B-Instruct-Turbo`     | 0.300 | 0.100        | 1.000  | Yes   | Yes  | 78          | 389             | 311                |
| `Qwen/Qwen3-VL-235B-A22B-Instruct`              | 0.200 | 0.110        | 0.880  | Yes   | Yes  | 78          | 389             | 311                |
| `deepseek-ai/DeepSeek-V3.2`                     | 0.260 | 0.130        | 0.380  | Yes   | Yes  | 79          | 397             | 317                |
| `Qwen/Qwen3.8-27B`                              | 0.200 | 0.050        | 2.500  | Yes   | Yes  | 80          | 401             | 321                |
| `zai-org/GLM-4.7`                               | 0.400 | 0.080        | 1.750  | Yes   | Yes  | 85          | 427             | 342                |
| `thinkingmachines/Inkling-Small`                | 0.450 | 0.100        | 1.200  | Yes   | No   | 86          | 428             | no Flex            |
| `deepseek-ai/DeepSeek-V3.1`                     | 0.250 | 0.130        | 0.950  | Yes   | Yes  | 90          | 452             | 362                |
| `Qwen/Qwen3-VL-30B-A3B-Instruct`                | 0.150 | none listed  | 0.600  | Yes   | Yes  | 91          | 454             | 364                |
| `tencent/Hy4-preview`                           | 0.834 | 0.042        | 2.501  | Yes   | No   | 93          | 464             | no Flex            |
| `meta-llama/Llama-Guard-4-12B`                  | 0.180 | none listed  | 0.180  | No    | Yes  | 98          | 491             | 393                |
| `zai-org/GLM-4.6`                               | 0.500 | 0.100        | 2.000  | Yes   | Yes  | 103         | 515             | 412                |
| `nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B`      | 0.500 | 0.100        | 2.200  | Yes   | Yes  | 107         | 535             | 428                |
| `nvidia/Nemotron-Content-Safety-3.5`            | 0.200 | none listed  | 0.200  | No    | Yes  | 109         | 546             | 437                |
| `ByteDance/Seed-2.0-code`                       | 0.500 | 0.100        | 3.000  | Yes   | No   | 123         | 615             | no Flex            |
| `ByteDance/Seed-2.0-pro`                        | 0.500 | 0.100        | 3.000  | Yes   | No   | 123         | 615             | no Flex            |
| `openai/gpt-oss-120b-Ultra`                     | 0.200 | none listed  | 0.950  | Yes   | No   | 124         | 621             | no Flex            |
| `deepseek-ai/DeepSeek-V4-Pro-0813`              | 1.300 | 0.100        | 2.600  | Yes   | Yes  | 136         | 679             | 543                |
| `deepseek-ai/DeepSeek-V4-Pro`                   | 1.300 | 0.100        | 2.600  | Yes   | Yes  | 136         | 679             | 543                |
| `zai-org/GLM-5.2`                               | 0.750 | 0.140        | 2.400  | Yes   | Yes  | 138         | 688             | 550                |
| `moonshotai/Kimi-K2.6`                          | 0.750 | 0.150        | 3.500  | Yes   | Yes  | 164         | 822             | 658                |
| `Qwen/Qwen3.5-397B-A17B`                        | 0.450 | 0.220        | 3.000  | Yes   | Yes  | 182         | 909             | 727                |
| `deepseek-ai/DeepSeek-V3`                       | 0.320 | none listed  | 0.890  | Yes   | Yes  | 186         | 931             | 744                |
| `Qwen/Qwen3.5-27B`                              | 0.260 | none listed  | 2.600  | Yes   | Yes  | 189         | 944             | 755                |
| `Qwen/Qwen2.5-72B-Instruct`                     | 0.360 | none listed  | 0.400  | Yes   | Yes  | 197         | 987             | 789                |
| `zai-org/GLM-5.3`                               | 0.900 | 0.200        | 4.000  | Yes   | Yes  | 203         | 1,017           | 814                |
| `deepseek-ai/DeepSeek-R1-0528`                  | 0.500 | 0.350        | 2.150  | Yes   | Yes  | 231         | 1,155           | 924                |
| `Qwen/Qwen3.6-27B`                              | 0.320 | none listed  | 3.200  | Yes   | Yes  | 232         | 1,162           | 929                |
| `Qwen/Qwen3.8-Max`                              | 1.650 | 0.206        | 4.951  | Yes   | No   | 245         | 1,225           | no Flex            |
| `Sao10K/L3.1-70B-Euryale-v2.2`                  | 0.850 | none listed  | 0.850  | No    | Yes  | 464         | 2,321           | 1,856              |
| `Qwen/Qwen3.7-Max`                              | 2.500 | 0.500        | 7.500  | Yes   | No   | 465         | 2,325           | no Flex            |
| `moonshotai/Kimi-K3`                            | 2.850 | 0.285        | 14.250 | Yes   | No   | 502         | 2,508           | no Flex            |

### DeepSeek direct (not approved: fails the D-154 check)

Read on DeepSeek's own pricing page (api-docs.deepseek.com/quick_start/pricing) on 2026-11-06, per 1 million tokens. Off-peak is half of peak. Peak is 01:00 to 04:00 and 06:00 to 10:00 UTC, Monday to Friday (8 to 11 pm and 1 to 5 am Toronto time in winter, 9 pm to midnight and 2 to 6 am in summer), excluding Chinese public holidays. Every other hour is off-peak.

| Model                                       | Cached input, off-peak / peak | Input, off-peak / peak | Output, off-peak / peak |
| ------------------------------------------- | ----------------------------- | ---------------------- | ----------------------- |
| `deepseek-flash` (DeepSeek V4.1 Flash 1017) | 0.003 / 0.006                 | 0.15 / 0.30            | 0.60 / 1.20             |
| `deepseek-v4-pro` (DeepSeek V4 Pro 0813)    | 0.022 / 0.044                 | 0.66 / 1.32            | 1.98 / 3.96             |

With the workload model of section 3. "Spread evenly" puts about 21% of the work in peak hours (35 of the 168 hours in a week):

| Model               | Quiet month, all off-peak | Quiet month, spread evenly | Quiet month, all peak | Busy month, spread evenly | Same model on DeepInfra, quiet / busy |
| ------------------- | ------------------------- | -------------------------- | --------------------- | ------------------------- | ------------------------------------- |
| DeepSeek V4.1 Flash | 17                        | 21                         | 35                    | 105                       | 20 / 101 (81 on Flex)                 |
| DeepSeek V4 Pro     | 68                        | 82                         | 136                   | 409                       | 136 / 679 (543 on Flex)               |

Direct Flash costs about the same as DeepInfra. Direct Pro costs about 40% less, and about half if most work falls off-peak.

**The D-154 check, read 2026-11-06 (Proposed: fails; Didi decides).** D-154 lets a hosted provider see a repository only if its API terms say it does not train on our data and it offers a data processing agreement. DeepSeek's own documents say neither:

- The DeepSeek Open Platform Terms of Service (released 2026-04-22, effective 2026-04-29, cdn.deepseek.com) give us the rights in our inputs and outputs (section 4.2) and say nothing that stops DeepSeek training on API inputs. Section 5.5 sends personal data to the DeepSeek Privacy Policy.
- The DeepSeek Privacy Policy (last updated 2026-02-10) lists, among the uses of "text input, ... prompt, uploaded files" and other inputs: "To improve and develop the Services and to train and improve our technology, such as our machine learning models and algorithms". It offers a "right to opt-out of using your Personal Data for training our models", which is an opt-out on request, not a commitment.
- Neither document offers a data processing agreement or zero data retention. The policy says DeepSeek retains personal data "for as long as necessary".
- The policy says DeepSeek will "directly collect, process and store your Personal Data in People's Republic of China". The terms are governed by the law of mainland China, with disputes in the courts at DeepSeek's registered office in Hangzhou (section 10).

So DeepSeek's API may not see a repository under D-154. DeepSeek's models stay available through DeepInfra, which passed the check (D-208) and costs about the same for Flash.

## 5. Scenario totals per month

| Scenario                                                                | Quiet month      | Busy month           | Made of                                                                                                          |
| ----------------------------------------------------------------------- | ---------------- | -------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Today                                                                   | about 480 and up | about 480 and up     | Grok 300 and Claude Max 180, plus whatever infrastructure is running                                             |
| Long term on the Claude API                                             | about 415 to 615 | about 1,630 to 2,040 | Infrastructure, Didi's Claude plan (Pro about 20 to Max 180), and Claude model usage                             |
| Long term on DeepInfra                                                  | about 145 to 295 | about 195 to 950     | Infrastructure, Claude Pro, and open-model usage from DeepSeek V4 Flash 0731 to Kimi K2.6, at Standard           |
| Long term on DeepInfra: Developer Qwen3 Coder, QA Kimi K2.6, Claude Pro | about 230        | about 630            | Infrastructure, Claude Pro, and model usage of about 100 quiet or about 500 busy at Standard (80 or 400 on Flex) |

Infrastructure is about 110 a month with domains and the alerts provider, and does not change in a busy month. The totals are rounded planning figures from 2026-10-31. The fixed prices above were read again on 2026-11-06 for first hosting (runbook step 1) and are unchanged, apart from the container registry, which is new and open.

## 6. Budget options: busy month under 300

Didi's target, 2026-10-31: the whole monthly bill stays under 300 even in a busy month (D-212). Fixed costs take about 130 of it (infrastructure about 110, Claude Pro 20), which leaves about 170 for models in a busy month, or about 34 in a quiet month.

How the rows are worked out:

- Developer work, with its fix rounds, is taken as about 75% of the token use and QA as about 25%. This is an assumption, chosen because it gives the "about 100" quiet month for Developer on Qwen3 Coder and QA on Kimi K2.6 in section 4. The real split comes from the run records.
- QA uses a model from another family than the Developer, as it will once D-209 applies.
- Totals are all-in: fixed costs plus 5 times the quiet-month model usage. The Flex column applies Flex only to models that support it.

### Developer and QA pairs

| Developer              | QA                     | Busy month, Standard | Busy month, Flex | Under 300 |
| ---------------------- | ---------------------- | -------------------- | ---------------- | --------- |
| DeepSeek V4 Flash 0731 | MiMo V2.6 Flash        | 192                  | 183              | Yes       |
| DeepSeek V4 Flash 0731 | Qwen3.8 Flash          | 201                  | 192              | Yes       |
| DeepSeek V4 Flash 0731 | GLM 5.3 Flash          | 215                  | 205              | Yes       |
| DeepSeek V4 Flash 0731 | MiMo V2.6 Pro          | 216                  | 206              | Yes       |
| DeepSeek V4.1 Flash    | Qwen3.8 Flash          | 228                  | 212              | Yes       |
| DeepSeek V4 Flash 0731 | MiniMax M3             | 250                  | 226              | Yes       |
| DeepSeek V4 Flash 0731 | Qwen3 Coder 480B Turbo | 276                  | 247              | Yes       |
| DeepSeek V4 Flash 0731 | GLM 4.7                | 285                  | 254              | Yes       |
| DeepSeek V4.1 Flash    | GLM 4.7                | 311                  | 275              | On Flex   |
| Qwen3.5 35B            | DeepSeek V4 Flash 0731 | 330                  | 290              | On Flex   |
| Qwen3 Coder 480B Turbo | MiMo V2.6 Flash        | about 440            | about 375        | No        |
| Qwen3 Coder 480B Turbo | Kimi K2.6              | about 630            | about 530        | No        |
| Kimi K2.6              | Any cheap model        | about 650 and up     | about 550 and up | No        |

A strong coding model as the main Developer model does not fit. The Developer has to run mostly on a Flash-class model.

### Cheap by default, stronger model for hard items

Most Developer work runs on DeepSeek V4 Flash 0731. About 20% of items go to a stronger model (routing by task type, ADR 0114). QA runs on MiMo V2.6 Flash.

| Model for the hard 20% | Busy month, Standard | Busy month, Flex | Under 300 |
| ---------------------- | -------------------- | ---------------- | --------- |
| Qwen3 Coder 480B Turbo | about 240            | about 220        | Yes       |
| Kimi K2.6              | about 305            | about 275        | On Flex   |

### Planning choice

Plan around DeepSeek V4 Flash 0731 for the Developer, Qwen3.8 Flash or GLM 5.3 Flash for QA, and Qwen3 Coder 480B Turbo for the hard items: about 220 to 250 in a busy month. This is a starting point for the model catalog, not a routing decision. The scorecard (ADR 0114 section 4) shows whether the cheap models finish tasks without extra fix rounds; if they do not, cost per finished task rises and the plan is revisited.

What would push a busy month over 300:

- Worse cache hit rates. The rows above assume the workload model's caching; much worse caching can roughly double model costs.
- More escalations to the stronger model than 20%.
- Flex not being served, so runs bill at Standard.

Ways to get back under: drop Claude Pro (about 20) or lower the share of hard items. There is no spend cap that stops work (D-011). The daily spend phone call starts at 25 a day (D-117, setting `daily_spend_call_usd`), which is about 750 over a month, well above this target.

## 7. Vision models for the screenshot comparison (D-242)

The visual comparison (D-242) needs a model that reads images: it compares the option Didi approved with CI screenshots of the built components, per component. Read on 2026-11-03. Prices in USD per million tokens (input / output). Volume is low, about one comparison per design item. Under D-249 the choice goes to the smallest, cheapest model that passes our own test, not the strongest one available.

### What matters for this job

In order: few false passes (saying "matches" when it does not); few false fails; seeing fine detail (copy, colour shades, a few pixels of spacing, missing states, font size and weight); holding several images at once; clear findings; the same verdict on the same input; saying "can't tell" when unsure. Cost barely matters at this volume.

### The cost of one comparison

Assumed: 1 approved image and 4 component screenshots at 1280x800, 1,500 text tokens in, 800 out. Every candidate costs about **0.0005 to 0.006 USD per comparison**. Reasoning tokens are not included; even at 10 times the output, every model stays under 0.03. Cost does not decide this. Accuracy does.

Image tokens per 1280x800 screenshot: Claude documents 1,334, with no downscaling on Haiku 5.5. Qwen3-VL is about 1,000 (inferred from its patch size). Every other figure is guessed or not found. The first test calls replace the guesses with `usage.prompt_tokens`.

### Candidates

| Model                                                                    | In / out                    | Flex    | Evidence (V = vendor, I = independent, S = read through search only)                                                             | Verdict                                                             |
| ------------------------------------------------------------------------ | --------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `Qwen/Qwen3.8-27B`                                                       | 0.20 / 2.50                 | Yes     | V: OSWorld-Verified 84.3, OmniDocBench 91.1, CharXiv 83.7. No UI-diff score                                                      | Shortlist: strongest screen and document numbers on DeepInfra       |
| `deepseek-ai/DeepSeek-V4.1-Flash-1017`                                   | 0.20 / 0.60                 | Yes     | V: Chartography 83.0, run with tools. No OCR, UI or multi-image score                                                            | Shortlist: confirm it accepts images on DeepInfra at the first call |
| Claude Haiku 5.5 (Anthropic, not DeepInfra)                              | 0.10 / 0.50                 | n/a     | V: OSWorld 72.4, Chartography 46.4. Image handling documented. I (family only): Claude Opus 4.7 has few false alarms on DiffSpot | Shortlist: the control                                              |
| `nvidia/NVIDIA-Nemotron-3.5-Super-VL`                                    | 0.15 / 0.50                 | No      | V, S: OCRBench v2 68.1, ScreenSpot-Pro about 43. Built for documents and GUIs                                                    | Alternate if a shortlisted model refuses images or JSON             |
| `Qwen/Qwen3.6-35B-A3B`                                                   | 0.10 / 0.95                 | Yes     | V: MMMU 81.7, OmniDocBench 89.9, CC-OCR 81.9                                                                                     | Not shortlisted; could replace Qwen3.8 if it fails                  |
| `Qwen/Qwen3-VL-235B-A22B-Instruct`                                       | 0.20 / 0.88                 | Yes     | V, S: OCRBench 920, ScreenSpot-Pro 62.0. **I, S: DiffSpot found 5.1% of changes**, by almost always saying "no difference"       | Out: worst false-pass signal                                        |
| `Qwen/Qwen3-VL-30B-A3B-Instruct`                                         | 0.15 / 0.60                 | Yes     | **I, S: DiffSpot found 9.3% of changes, with 18% false alarms**                                                                  | Out: weak on both error rates                                       |
| Gemma 4 (31B, 31B turbo, 26B)                                            | 0.07 to 0.20 / 0.34 to 0.40 | Yes     | V: MMMU-Pro 73.8 to 76.9. DeepInfra's image token budget is unknown and cannot be raised                                         | Out for now: small text may be lost                                 |
| `inclusionAI/Ling-3.0-flash-VL`                                          | 0.06 / 0.18                 | No      | V, S only: CharXiv 81.3, OmniDocBench 91.35                                                                                      | Out for now: no vision numbers could be read directly               |
| `XiaomiMiMo/MiMo-V2.6-Flash`                                             | 0.14 / 0.28                 | No      | I, S: Roboflow vision evals 52nd of 59                                                                                           | Out: poor independent score                                         |
| `deepseek-ai/DeepSeek-V4-Flash-Vision-Exp`                               | 0.44 / 1.32                 | Yes     | V, S: Chartography 64.3                                                                                                          | Out: experimental, and V4.1 Flash is newer and cheaper              |
| `meta-llama/Llama-4-Scout-17B-16E-Instruct`                              | 0.10 / 0.30                 | Yes     | V: ChartQA 88.8, DocVQA 94.4                                                                                                     | Out: April 2025, behind on every shared score                       |
| `mistralai/Mistral-Small-3.2-24B-Instruct-2506`, `zai-org/GLM-5.3-Flash` | 0.075 / 0.20; 0.15 / 0.50   | Yes; No | Weak or no vision numbers                                                                                                        | Out                                                                 |

Several models the table in section 4 lists as text only also take images on DeepInfra (they are tagged "multimodal"): DeepSeek V4.1 Flash, Qwen3.8, Qwen3.6 and 3.5, Gemma 4, Mistral Small 3.2, MiMo V2.6 Flash, GLM 5.3 Flash and Kimi K2.6. Already deprecated on DeepInfra: the Qwen3-VL Thinking variants, Llama 4 Maverick, GLM-4.6V and Kimi K2.5, among others.

### What DeepInfra's endpoint does with images

Several images per request, in the OpenAI format; jpg, png or webp up to 20 MB each. DeepInfra rescales images itself and does not support the `detail` parameter, so the image token budget cannot be raised. JSON schema output works on every candidate, but DeepInfra's docs warn that JSON mode can push a model to invent an answer rather than say it does not know, so the answer schema needs an explicit `cannot_tell` value.

### The most important finding: no model alone is enough

DiffSpot (a May 2026 paper, read through search only) is the closest published match: 4,400 rendered web-page pairs with one CSS property changed, plus 500 identical pairs. The best of 13 models found only about 40 to 47% of the changes, and under 23% on the hard tier. Claude Opus 4.7 found 31.2% with 0.4% false alarms. Open models found about 5%, mostly by answering "no difference". So a model given two whole screenshots will pass many small spacing, colour and font changes. In line with D-249, the fix is in the scaffolding: a pixel difference or per-component crops before the model call, so the model judges a located change instead of hunting for it.

### Test plan

20 synthetic pairs, half identical and half with one planted difference (colour, spacing, copy, a missing state, font, alignment), each run 3 times on the three shortlisted models and the alternate, with a `match` / `differs` / `cannot_tell` answer per component. Rank by false-pass rate, then false-fail rate, then consistency. Estimated total under 1 USD.

### How to run the test (D-242, D-249)

The harness is `spikes/visual-model-test/`. It draws the 20 pairs in code (`pairs.ts`), builds each request exactly as the runner builds a `qa:visual` run's task (the same crops, pixel summary, input text, QA's `qa:visual` instructions and answer schema from `contracts/bots/qa.yaml`, and the Messages API image's frame), sends each pair 3 times, and scores the answers with the runner's own check: false-pass rate, then false-fail rate, then consistency, with the `cannot_tell` rate and unusable answers beside them. It prints one JSON record.

- No network, no key: `node spikes/visual-model-test/run.ts` runs a fake model that answers from the pixel summary alone. Its record is the baseline the scaffolding gives for free.
- A real model (Didi's credential gate): set `VISUAL_TEST_API_KEY` in the shell, never in a file, and run `node spikes/visual-model-test/run.ts --real --model <id>` for Anthropic's Messages API, or add `--api openai` and `VISUAL_TEST_BASE_URL` (for DeepInfra, `https://api.deepinfra.com/v1/openai`) for an OpenAI-compatible endpoint. Without `--real`, or without the key or a model, it refuses and names what is missing. The key is never printed.

Paste each record into this section with the date. The routing policy gets a `qa:visual` entry only after the test has picked a model (N-57).

### Measured and guessed

- Read directly on 2026-11-03: DeepInfra prices, Flex, tags and deprecations; DeepInfra's image limits; Haiku 5.5's prices and image token formula; the model-card numbers marked V without S.
- Read through search snippets only (S): the Qwen3-VL report, Nemotron, Ling, DeepSeek Vision-Exp, DiffSpot and Roboflow. huggingface.co and arxiv.org were blocked in this session.
- Guessed: tokens per image for every model except Claude and Qwen3-VL.
- Almost every benchmark is vendor-reported. No candidate on the shortlist has a published UI-difference score, so the test set decides.

## 8. Caveats

- **Cost per finished task is what counts**, not price per token. A cheaper model that needs more fix rounds, fails QA more often or escalates more can cost more per finished item. The scorecard measures this (ADR 0114 section 3).
- **Cache hit rates drive the totals.** Most input is cached in the workload model. With worse cache hit rates, Qwen3 Coder could cost about 180 a quiet month instead of about 80. Prompt caching is required (D-185), and each run records cached and uncached tokens.
- **Flex may not be served.** A model without tier support is billed at Standard, and the served tier is recorded per run (ADR 0114 section 8).
- **Prices change.** DeepInfra prices were read on 2026-10-31 and have changed before (GLM 5.3's promotion ended). Every price is read again on deepinfra.com before a model is added to the model catalog.
- **Some rows have no cached price.** Those months assume no cache discount, so they are upper estimates. A cheaper real cost needs a cached price from DeepInfra.
- **DeepInfra passed the D-154 provider check for its own models** (D-208). The DPA at trust.deepinfra.com was not read (it returned 403).
