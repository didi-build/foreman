# OpenCode runtime spike (D-222)

- **Question:** can OpenCode, pinned to one version, replace Claude Code as the Developer and Designer runtime for every model: a headless run with a machine-readable result, a dollar cap at our catalog prices, the D-196 tool list, the MagicPath MCP for the Designer, prompt caching (D-185), and model traffic through the egress proxy with a placeholder key?
- **Status:** **run 2026-10-31 against local fakes: yes, with a wrapper.** Five of the six checks pass as they stand. The dollar cap (check 2) works only when the image wrapper enforces it, and the wrapper must also keep repository code out of OpenCode's startup (finding 6a). Recommendation: build the image with a wrapper-enforced cap (see the end).
- **Decision it feeds:** D-222, and the OpenCode image that replaces [`src/agent-images/claude-code/`](../../src/agent-images/claude-code/) (ADR 0106 sections 2 to 6, ADR 0107, ADR 0114 sections 8 to 10).
- **Scripts:** throwaway, kept in the session scratchpad and not committed (a fake provider, a fake MCP server, a deny-all proxy, a cap wrapper prototype and a run script). What they do is described under Method, so they can be rebuilt.

## Version

| Item                    | Value                                                                                                                                                 |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| npm package             | `opencode-ai@1.19.5`, published 2026-10-28 (the newest; 1.19.1 of 2026-10-15 is the newest one older than two weeks)                                  |
| `opencode-ai` integrity | `sha512-tEqMvQahfhdDj8vceYpXtoIrvjPXm5XRfetWnPN5YISueU7adNx9JcUA3zZ+2GKuDVgDpGdQe1ZLtCZDjqodvA==`                                                     |
| Platform package        | `opencode-linux-x64@1.19.5`, integrity `sha512-i1qh7VooLGML9xX6ud93y0JA8j/1aPeDYRKjsmYXrJX1TjIWHgBBMkEbEJPZthpWbsJg//XfBgR6Kb7+NPaJiQ==`              |
| Binary                  | `node_modules/opencode-linux-x64/bin/opencode`, 214,386,864 bytes, ELF x86-64, glibc                                                                  |
| Binary sha256           | `7df4e4136301f16589b0f30bf91a61380fca5f8ef22dd36570f5ebe1d4ec802c` (the `-baseline` package's binary has the same hash in this version)               |
| Source read             | `github.com/sst/opencode` tag `v1.19.5`, commit `810c0eba1a7348036f8bdf61e6632d0c36c6876c`; docs from the same tree (`packages/web/src/content/docs`) |
| Runtime inside          | Bun 1.4.4, AI SDK provider-utils 4.0.46 (from its `user-agent` header)                                                                                |

**Install.** `npm install --ignore-scripts --save-exact opencode-ai@1.19.5` first. The package's own `bin/opencode.exe` is a shell stub that only prints an error. Its `postinstall.mjs` picks a platform package from `optionalDependencies` (AVX2 and musl checks), copies that package's binary over the stub and runs `--version`. If the platform package is missing it runs `npm install` for it. So the only host it fetches from is the npm registry, and with `--ignore-scripts` nothing runs at all: the binary is already in `node_modules/opencode-linux-x64/bin/opencode` and can be called by that path. `opencode.ai` itself could not be opened from this session (the session's proxy refused it), so the docs were read from the tagged source tree instead.

## Method

Everything ran on Linux in the session scratchpad, with no real provider, account or credential.

- **Isolation.** Each run is started inside `unshare -n`: a new network namespace with only loopback, so nothing outside the machine is reachable. OpenCode runs under `strace -f -e trace=connect,bind,listen`, so every connection it tries is logged. Its environment is built with `env -i` (PATH, HOME, TMPDIR, LANG, the proxy variables, OpenCode's switches), as the image's allow-list would be.
- **Fake provider** (Node `http`, port 18080). Serves `POST /anthropic/v1/messages` (Anthropic Messages API, streamed) and `POST /deepinfra/v1/openai/chat/completions` (OpenAI chat completions, streamed). It logs every request's method, path, headers and body. A marker in the prompt picks the scenario: write a file, run `git status`, run a command that must be denied, call the MCP tool, call a tool forever (for the caps), answer 429 with an overload error, or answer 402. It reports usage like the real APIs, and simulates caching from the request itself: Anthropic-style cache reads and writes from the `cache_control` marks and prefixes it has seen, and OpenAI-style `prompt_tokens_details.cached_tokens` from the longest message prefix it has seen.
- **Deny-all proxy** (port 18081), set as `HTTPS_PROXY` and `HTTP_PROXY`: refuses every CONNECT with 403 and logs the host. This is the run's egress proxy with an empty allow-list.
- **Fake MCP server** (port 18082): Streamable HTTP, JSON answers, at `/magicpath/mcp`, with one tool `echo`. It logs every request with its headers.
- **Cap wrapper prototype** (Node): spawns OpenCode, reads its JSON events, prices each step with `FOREMAN_MODEL_PRICE`, stops the run at `FOREMAN_MAX_BUDGET_USD`, and prints a result line shaped like ours.
- **Pod check.** One run in a private mount namespace: read-only root, the binary and config in a read-only folder, HOME and TMPDIR on a tmpfs (standing in for `emptyDir`), uid 1000.
- A scratch git repository with one commit and a `.foreman-scratch` file, copied fresh for each run.

The common command, simplified (most runs also set `HTTP_PROXY` to the deny proxy and `NO_PROXY=127.0.0.1`; one run checked the pod's form with `HTTPS_PROXY` only; the image's form is under "What the image needs"):

```bash
env -i PATH=/usr/bin:/bin HOME=$RUN/home TMPDIR=$RUN/tmp LANG=C.UTF-8 \
  HTTPS_PROXY=http://127.0.0.1:18081 \
  OPENCODE_CONFIG=$CONFIG OPENCODE_DISABLE_AUTOUPDATE=1 OPENCODE_DISABLE_MODELS_FETCH=1 \
  OPENCODE_DISABLE_LSP_DOWNLOAD=1 OPENCODE_DISABLE_PROJECT_CONFIG=1 OPENCODE_DISABLE_CLAUDE_CODE=1 \
  OPENCODE_DISABLE_DEFAULT_PLUGINS=1 OPENCODE_DISABLE_EXTERNAL_SKILLS=1 \
  opencode run --format json --pure --title foreman-run -m foreman-anthropic/claude-sonnet-5-5 \
  < prompt.txt > events.jsonl
```

The Developer config used (the Designer's adds the `mcp` block under check 4):

```json
{
  "autoupdate": false,
  "share": "disabled",
  "snapshot": false,
  "lsp": false,
  "formatter": false,
  "enabled_providers": ["foreman-anthropic", "foreman-deepinfra"],
  "model": "foreman-anthropic/claude-sonnet-5-5",
  "small_model": "foreman-anthropic/claude-sonnet-5-5",
  "provider": {
    "foreman-anthropic": {
      "npm": "@ai-sdk/anthropic",
      "options": {
        "baseURL": "http://127.0.0.1:18080/anthropic/v1",
        "apiKey": "foreman-placeholder-the-egress-proxy-adds-the-key"
      },
      "models": {
        "claude-sonnet-5-5": {
          "tool_call": true,
          "limit": { "context": 200000, "output": 16384 },
          "cost": { "input": 3, "output": 15, "cache_read": 0.3, "cache_write": 3.75 }
        }
      }
    },
    "foreman-deepinfra": {
      "npm": "@ai-sdk/openai-compatible",
      "options": {
        "baseURL": "http://127.0.0.1:18080/deepinfra/v1/openai",
        "apiKey": "foreman-placeholder-the-egress-proxy-adds-the-key"
      },
      "models": {
        "Qwen/Qwen3-Coder-480B-A35B-Instruct-Turbo": {
          "tool_call": true,
          "limit": { "context": 262144, "output": 16384 },
          "cost": {
            "input": 0.3,
            "output": 1.2,
            "cache_read": 0.06,
            "cache_write": 0.3
          }
        }
      }
    }
  },
  "permission": {
    "*": "deny",
    "read": "allow",
    "edit": "allow",
    "glob": "allow",
    "grep": "allow",
    "bash": { "*": "deny", "git *": "allow", "npm *": "allow" }
  },
  "agent": { "build": { "steps": 100 } }
}
```

The prices in the config are spike values, not catalog values. The provider ids are our own (`foreman-anthropic`, `foreman-deepinfra`), not OpenCode's built-in `anthropic` and `deepinfra`, so nothing from OpenCode's bundled model list (models.dev) is merged into them.

## Results

| #   | Check                      | Result      | In one line                                                                                                                                     |
| --- | -------------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Headless run, result       | **PASS**    | `opencode run --format json` streams JSON events; the wrapper sums them into our result line. Exit code 1 on a provider error                   |
| 2   | Dollar cap                 | **PARTIAL** | No dollar cap in OpenCode, and `steps` is not a hard turn cap. It prices from our config table correctly. A wrapper cap works and is required   |
| 3   | Tool permissions           | **PASS**    | D-196 maps to `permission`; denied tools are never offered, denied commands are refused with no prompt and the run goes on                      |
| 4   | MCP (Designer)             | **PASS**    | A remote MCP in the Designer's config only: tools listed (`magicpath_echo`) and called, placeholder header sent                                 |
| 5   | Prompt caching             | **PASS**    | Anthropic: `cache_control` on the system prompt and the last two messages, prefix unchanged turn to turn. DeepInfra caches by prefix on its own |
| 6   | Egress proxy, credentials  | **PASS**    | Base address and placeholder key per provider in config. With the settings below it contacts no host but the provider. Read-only root, uid 1000 |
| 6a  | Repository code at startup | **FINDING** | Despite `--pure` and `OPENCODE_DISABLE_PROJECT_CONFIG`, OpenCode runs plugins from the repository. The wrapper must refuse such a checkout      |

### 1. Headless run with a machine-readable result: PASS

`opencode run --format json` prints one JSON object per line (`packages/opencode/src/cli/cmd/run.ts`, `emit()`): `step_start`, `text`, `tool_use`, `step_finish`, `error` (and `reasoning` only with `--thinking`). Every object has `type`, `timestamp`, `sessionID` and a `part` or `error`. There is no final summary object like Claude Code's `result`, so the wrapper builds the result from the stream. A Developer run that writes one file (Anthropic fake, abbreviated):

```json
{"type":"step_start","part":{"type":"step-start", ...}}
{"type":"tool_use","part":{"type":"tool","tool":"write","state":{"status":"completed","input":{"filePath":"SPIKE.md","content":"hello from the opencode spike\n"},"output":"Wrote file successfully.", ...}}}
{"type":"step_finish","part":{"type":"step-finish","reason":"tool-calls","tokens":{"total":5488,"input":0,"output":40,"reasoning":0,"cache":{"write":5448,"read":0}},"cost":0.02103}}
{"type":"step_start", ...}
{"type":"text","part":{"type":"text","text":"Done (scenario write, after 1 tool rounds).", ...}}
{"type":"step_finish","part":{"reason":"stop","tokens":{"total":5541,"input":0,"output":12,"reasoning":0,"cache":{"write":189,"read":5340}},"cost":0.00249075}}
```

Exit code 0. The file was on disk with the expected text (checked from outside the agent).

How it maps to our result line (ADR 0106 section 4):

| Result field             | From OpenCode                                                                                                                                                                                                       |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `finalText`              | The last `text` event's `part.text`                                                                                                                                                                                 |
| `status`                 | `success` when the exit code is 0, the last `step_finish` has `reason` `stop`, and no `error` event came; `error` on an `error` event or a non-zero exit; the wrapper's own stops give `max_budget` and `max_turns` |
| `turns`                  | The number of `step_finish` events (one per model request)                                                                                                                                                          |
| `tokens.uncachedInput`   | Sum of `part.tokens.input` (OpenCode already subtracts cache reads and writes, `session.ts` `getUsage`)                                                                                                             |
| `tokens.cachedInput`     | Sum of `part.tokens.cache.read`                                                                                                                                                                                     |
| `tokens.cacheWriteInput` | Sum of `part.tokens.cache.write`                                                                                                                                                                                    |
| `tokens.output`          | Sum of `part.tokens.output` plus `part.tokens.reasoning` (OpenCode reports reasoning apart and bills it as output)                                                                                                  |
| `costUsd`                | Priced by the wrapper from the tokens with `FOREMAN_MODEL_PRICE` (check 2). OpenCode's `part.cost` agreed to the last digit when the config prices matched                                                          |
| `providerError`          | The `error` event: `error.data.statusCode`, the type from `error.data.responseBody` (`error.type`), `error.data.message`, and `retry-after` from `error.data.responseHeaders`                                       |

Failure output, Anthropic fake answering 429 with `overloaded_error` and `retry-after: 1`:

```json
{"type":"error","error":{"name":"APIError","data":{"message":"Overloaded (fake 429)","statusCode":429,"isRetryable":true,"responseHeaders":{"retry-after":"1", ...},"responseBody":"{\"type\":\"error\",\"error\":{\"type\":\"overloaded_error\",\"message\":\"Overloaded (fake 429)\"}}","metadata":{"url":"http://127.0.0.1:18080/anthropic/v1/messages"}}}}
```

The same shape came for DeepInfra's form (`statusCode` 429, body `{"error":{"type":"engine_overloaded",...}}`) and for 402 on both (`isRetryable: false`, one request, exit 1). The wrapper prototype turned the DeepInfra 429 into `"providerError":{"status":429,"type":"engine_overloaded","message":"Model is overloaded, please try again later (fake)","retryAfterSeconds":null}`.

**Retries.** OpenCode retries a retryable error itself, and this is fixed in code, not configurable (`session/retry.ts`): up to 5 retries, so 6 requests, waiting 2 s doubling with jitter, or the `retry-after` header when the response has one. Measured: 6 requests in 9 s with `retry-after: 1`, 6 requests in 70 s with no header. The 402 was not retried.

Other findings:

- Without `--title`, OpenCode first asks the model for a session title. That request is not reported in any event, so its tokens would be missing from the cost. Passing `--title <run id>` removes it (seen: 3 model requests without it, 2 with it, same task).
- The prompt should go in on stdin with no message argument. A message argument that contains a space is wrapped in quotes with inner quotes escaped before it is sent (`run.ts` line 290). From stdin it arrives byte for byte, including lines that start with `--`, and it avoids the 128 KiB argument limit. Stdin must be closed or a file: OpenCode reads all of a non-terminal stdin before it starts.
- Only events of the run's own session are printed. Subagent (`task` tool) sessions would be invisible to the wrapper; `task` is denied (check 3), so there are none.

### 2. Dollar cap: PARTIAL (no cap in OpenCode; a wrapper cap works)

- **No per-run cost or token cap exists.** The source has no budget or cost-limit setting (searched the config schema and session loop). `opencode run` has no such flag.
- **`steps` is not a hard turn cap.** `agent.build.steps` (formerly `maxSteps`) only adds a message on the last step telling the model to stop using tools (`session/prompt.ts`, `MAX_STEPS_PROMPT`); the tools are still sent. With `steps: 3` and a fake model that always calls a tool, the run did not stop: 837 requests in about 100 seconds before it was killed. So the turn limit must be enforced by the wrapper too, with the proxy's request ceiling as the backstop.
- **It prices from a table we set.** `provider.<id>.models.<model>.cost` takes `input`, `output`, `cache_read` and `cache_write` in US dollars per million tokens (`core/src/v1/config/provider.ts`). Each step's cost is uncached input, output plus reasoning, cache reads and cache writes times those prices (`session.ts` `getUsage`). Checked by hand on both fakes, for example the DeepInfra step above: 5437 × 0.3 + 40 × 1.2 = 0.0016791 USD, as printed. A field left out falls back to OpenCode's bundled price for that model id, or 0, so all four must be written; for a provider id of our own there is no bundled entry. It prices one tier only: there is no field for Flex or Priority prices.
- **The wrapper cap works.** The prototype reads each `step_finish`, prices its tokens with our catalog price (`FOREMAN_MODEL_PRICE`, Standard prices, cache write at the input rate when the catalog lists none, as O-26 says), and sends SIGTERM when the run's cost plus the last step's cost would reach the cap, since the next request rereads at least that context. Results with a fake model that never stops:

| Run                      | Cap      | Requests | Cost at stop | Result                                                              |
| ------------------------ | -------- | -------- | ------------ | ------------------------------------------------------------------- |
| Anthropic, Sonnet prices | 0.10 USD | 18       | 0.099833 USD | `max_budget`, OpenCode's own figure identical, no request in flight |
| DeepInfra, Qwen3 prices  | 0.02 USD | 39       | 0.019887 USD | `max_budget`, `cachedInput` 258,894 against `uncachedInput` 8,271   |
| DeepInfra, normal task   | 5 USD    | 2        | 0.002042 USD | `success`, final text read                                          |

So the answer to D-222's question is: OpenCode does not cap, but it reports every step's tokens as it goes, so the image's wrapper can enforce the cap from outside OpenCode, at our catalog prices, for any provider. The cap can only be checked between model requests, so one request can overshoot it; the "cost plus last step" rule keeps the stop before the cap in normal runs. The proxy's model request ceiling and the deadline stay as backstops (ADR 0106 section 6).

### 3. Tool permissions: PASS

D-196 as OpenCode permissions (`permission`, docs `permissions.mdx`, last matching rule wins):

| D-196 (Claude Code) | OpenCode                                                                         |
| ------------------- | -------------------------------------------------------------------------------- |
| `Read`              | `"read": "allow"`                                                                |
| `Edit`, `Write`     | `"edit": "allow"` (covers the `edit`, `write` and `apply_patch` tools)           |
| `Glob`, `Grep`      | `"glob": "allow"`, `"grep": "allow"`                                             |
| `Bash(git *)`       | `"bash": { "*": "deny", "git *": "allow", ... }`                                 |
| `Bash(npm *)`       | `"npm *": "allow"` in the same `bash` object                                     |
| nothing else        | `"*": "deny"` first (webfetch, websearch, task, todowrite, skill, question, ...) |
| `dontAsk`           | No `ask` anywhere; see below                                                     |

Evidence:

- Tools offered to the model, from the captured request: `bash, edit, glob, grep, read, write`. A tool whose permission is `deny` for every pattern is not sent at all.
- Commands, each run through the bash tool by the fake model:

| Command                                       | Result                                                                   |
| --------------------------------------------- | ------------------------------------------------------------------------ |
| `git status --porcelain`                      | ran                                                                      |
| `npm --version`                               | allowed (npm was not on the test PATH, so bash said "command not found") |
| `curl -s http://example.com`                  | refused                                                                  |
| `git status && curl -s http://example.com`    | refused (each command of a chain is checked)                             |
| `git status; curl -s http://example.com`      | refused                                                                  |
| `git status $(curl -s http://example.com)`    | refused (command substitution is checked)                                |
| ``git diff `curl x` ``                        | refused                                                                  |
| `ls -la`, `cat README.md`, `echo hi > /tmp/x` | refused                                                                  |
| `git log --oneline \| head -1`                | refused (`head` is not allowed)                                          |
| `git -c alias.x=!curl x`                      | **ran curl**: git runs a `!` alias through the shell                     |

- A refusal is a tool error sent back to the model ("The user has specified a rule which prevents you from using this specific tool call..."), with no prompt; the model got another turn and the run ended normally with exit 0.
- `ask` must not be used. In `opencode run` an `ask` is answered "reject" by OpenCode itself (`run.ts`, `permission.asked`), but a rejection ends the run: one step, no final text, and still exit 0 ("permission requested: bash (curl -s http://example.com); auto-rejecting" on stderr). With only `allow` and `deny` rules nothing can ask. `--auto`, `--yolo` and `--dangerously-skip-permissions` must never be passed.
- The `git -c alias` escape is not new: Claude Code's `Bash(git *)` matches it the same way, and `npm *` allows `npm exec` and package scripts by design (D-196). D-196 calls the tool list a second layer; the egress proxy is the wall.

### 4. MCP for the Designer: PASS

The Designer's config adds (and the Developer's has no `mcp` key at all):

```json
"mcp": {
  "magicpath": {
    "type": "remote",
    "url": "http://127.0.0.1:18082/magicpath/mcp",
    "enabled": true,
    "oauth": false,
    "timeout": 10000,
    "headers": { "Authorization": "Bearer foreman-placeholder-the-egress-proxy-adds-the-key" }
  }
},
"permission": { "...": "as above", "magicpath_*": "allow" }
```

- Tools offered to the model: `bash, edit, glob, grep, magicpath_echo, read, write`. OpenCode names an MCP tool `<server>_<tool>`.
- The fake model called `magicpath_echo` with `{"text":"ping"}`; the event shows `"status":"completed","output":"fake-magicpath echo: ping"`.
- What the MCP server received: `initialize` (protocol `2025-11-25`), `notifications/initialized`, a `GET` (the optional server-to-client stream), `tools/list`, `tools/call`, then `notifications/cancelled` after the call ended. Every request carried `Authorization: Bearer foreman-placeholder-the-egress-proxy-adds-the-key` and `user-agent: opencode/1.19.5`.
- `oauth: false` stops OpenCode from trying OAuth discovery. Under D-198 the proxy's MagicPath route replaces the placeholder header, as for a model provider; whether MagicPath wants `Authorization` or another header is settled at D-190's gate. The config also supports `{env:NAME}` substitution, but no credential reaches the pod, so it is not needed.

### 5. Prompt caching (D-185): PASS

**Anthropic.** With `npm: "@ai-sdk/anthropic"`, OpenCode marks the cache itself (`provider/transform.ts`, `applyCaching`): `cache_control: {"type":"ephemeral"}` on the system prompt and on the last content block of the last two messages, three breakpoints of Anthropic's four. Tools come before the system prompt in Anthropic's prefix, so they are cached with it. Captured from an 18-request run:

```
request  messages  breakpoints
1        1         system, m0
2        3         system, m1, m2
3        5         system, m3, m4
4        7         system, m5, m6
```

Each request's tools, system prompt and earlier messages were identical to the previous request's, ignoring the moving `cache_control` marks (checked by script for all 17 pairs). So the prefix up to the previous request's last breakpoint is reused each turn. The fake's cache accounting over that run: 90,763 cached input tokens, 16,481 cache-write tokens, 0 uncached. The request also carries `"thinking":{"type":"adaptive",...}` and `anthropic-beta: thinking-binding-controls-2026-08-01,structured-outputs-2025-11-13`, which only the real API can confirm.

**DeepInfra.** With `npm: "@ai-sdk/openai-compatible"` the body has no cache marks: `model`, `max_tokens`, `messages`, `tools`, `tool_choice`, `stream`, `stream_options: {"include_usage": true}`. None are needed. DeepInfra's documentation (docs.deepinfra.com/chat/prompt-caching, read 2026-10-31) says prompt caching is automatic and needs no extra parameters: a request whose prompt begins exactly like a recent one on the same model reuses its cache, the hit is reported in `usage.prompt_tokens_details.cached_tokens`, and an optional `prompt_cache_key` (a session-scoped key is recommended) improves the hit rate. The captured bodies keep the prefix identical turn to turn (system, tools and earlier messages unchanged), and OpenCode reads `cached_tokens` into `cache.read` (39-request run: 258,894 cached against 8,271 uncached in the fake). A `prompt_cache_key` can be set per run from the model's `options` in the config (captured: `"prompt_cache_key":"run-abc123"`). OpenCode's `@ai-sdk/deepinfra` provider would send the session id as `prompt_cache_key` by itself, but it did not ask for `stream_options.include_usage`, so usage might not arrive on a stream; the OpenAI-compatible provider is the safer choice.

What a fake cannot show: that the real providers report cache hits for these exact requests. ADR 0106 check 14 (cached input above zero after the first turn) on the first real run settles that.

**Service tier, seen on the way.** A model's `options` are passed into the request body. `"options": {"service_tier": "flex"}` on the DeepInfra model produced `"service_tier":"flex"` in every request. So OpenCode can set the tier itself, and D-203's proxy insertion (meant for Claude Code) is not needed for OpenCode on DeepInfra. OpenCode does not report the served tier in its events; the proxy can read it from responses (ADR 0114 section 8).

### 6. Egress proxy and credentials: PASS

**Base address and key per provider.** `provider.<id>.options.baseURL` and `options.apiKey` (shown in the config above). Captured headers:

- Anthropic: `x-api-key: foreman-placeholder-the-egress-proxy-adds-the-key`, `anthropic-version: 2023-06-01`, to `POST /anthropic/v1/messages`.
- DeepInfra: `authorization: Bearer foreman-placeholder-the-egress-proxy-adds-the-key`, to `POST /deepinfra/v1/openai/chat/completions`.
- Both also send `user-agent: opencode/1.19.5 ...`, `x-opencode-session-id`, `x-session-id` and `x-session-affinity` (the session id). The proxy drops `x-api-key` and `authorization` and sets the real credential (`src/egress-proxy/headers.ts`), so this works unchanged.

So with the proxy's providers served at `/<name>` (ADR 0106 section 2), the image sets `baseURL` to `http://<proxy>:<port>/anthropic/v1` for an Anthropic upstream of `https://api.anthropic.com`, and `http://<proxy>:<port>/deepinfra/v1/openai` for a DeepInfra upstream of `https://api.deepinfra.com`. With only `HTTPS_PROXY` set (no `HTTP_PROXY`, no `NO_PROXY`), the plain-http provider and MCP addresses were called directly, as the pod needs.

**Every host it tries.** From the deny proxy's log and `strace` (no direct connection outside loopback was attempted in any run, and no port was opened: no `bind` or `listen`):

| Host                        | Why                                                                                                                        | How it is switched off                                                                                                          |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `models.opencode.ai`        | Model list fetch (`GET /api.json`) at start                                                                                | `OPENCODE_DISABLE_MODELS_FETCH=1`. Seen only in the run without it                                                              |
| `registry.npmjs.org`        | Background `npm install @opencode-ai/plugin@1.19.5` into every writable config folder (`~/.config/opencode`), in every run | `XDG_CONFIG_HOME` pointing at a read-only folder in the image that already holds a `.gitignore` (below). Then no attempt at all |
| The provider and MCP routes | The work                                                                                                                   | n/a                                                                                                                             |

Not contacted in `opencode run`: no update check (it runs only in the terminal UI, and `autoupdate: false` and `OPENCODE_DISABLE_AUTOUPDATE=1` turn it off anyway), no telemetry (OpenTelemetry export happens only with `experimental.openTelemetry` or `OTEL_EXPORTER_OTLP_ENDPOINT`, neither set), no sharing (`share: "disabled"`; `run` says sharing is discontinued). Hosts in the source for features that are off: `mcp.exa.ai` and `search.parallel.ai` (web search, off unless `OPENCODE_ENABLE_EXA` or `OPENCODE_ENABLE_PARALLEL`), GitHub release downloads for language servers (`lsp: false`, `OPENCODE_DISABLE_LSP_DOWNLOAD=1`), and provider login flows. The registry install matters most: the Developer's pod may reach the npm registry (ADR 0106 section 3), so without the read-only folder OpenCode would install and could load a package at every run.

**Read-only root, writable HOME and tmp.** The pod-like run (read-only root, binary and config read-only, HOME and TMPDIR on tmpfs, uid 1000, network namespace with loopback only) completed the write task with exit 0 and no outbound attempt. What it writes:

- HOME: `~/.local/share/opencode/opencode.db` (SQLite with the whole session, about 4.5 MB after 18 turns), `~/.local/share/opencode/log/`, `~/.local/state/opencode/locks`, `~/.cache/opencode/`. Gone with the `emptyDir`. No placeholder or token value was found in it.
- TMPDIR: about 13 MB of native libraries Bun unpacks at each start (`.bun-*.so`, `.bun-*.node`).
- The repository: nothing (`git status --porcelain --ignored` was clean apart from the agent's own file, with `snapshot: false`).

One trap: with `XDG_CONFIG_HOME` read-only and no `.gitignore` in `opencode/` under it, OpenCode stops at start ("Unexpected error ... FileSystem.writeFile (.../opencode/.gitignore)"): it ignores a permission error there but not a read-only filesystem. The image ships the file.

### 6a. Repository code at startup: FINDING, handled by the wrapper

OpenCode 1.19.5 has a second configuration loader (`packages/core/src/config/plugin/external.ts`) that imports `.opencode/plugin/*.js` (and `plugins/`, `.ts`) from the working tree and any plugin listed under `plugin` or `plugins` in a repository `opencode.json`, and it ignores both `--pure` and `OPENCODE_DISABLE_PROJECT_CONFIG`. Tested: a file `.opencode/plugin/evil.js` in the scratch repository wrote a marker into HOME at start, and so did `opencode.json` with `{"plugins":["./p.js"]}`. The older loader does respect the switches: a repository `opencode.json` with `"permission": "allow"` did not change the permissions, an extra MCP server in it was not loaded, `.opencode/tool/*.js` was not loaded, and the repository's `AGENTS.md` did not reach the prompt.

This is not a new kind of power: the Developer may already run package scripts through `npm *` (D-196). But a plugin runs inside OpenCode's process, before any tool rule, where it could add tools or print false events to the wrapper. So the wrapper refuses to start, before any model call, when the checkout has a `.opencode` folder or an `opencode.json` or `opencode.jsonc` at its root (OpenCode searches from the working folder up to the repository root, and the run starts at the root). A file committed by an earlier run then fails the next run visibly instead of running.

## What the image needs

An `opencode` image beside `claude-code`, following the same rules (ADR 0106 section 4, ADR 0111).

**Dockerfile.**

- The binary from `opencode-linux-x64@1.19.5` at an exact version through its own lockfile, installed with `npm ci --ignore-scripts` (the postinstall only copies the binary, so it is not needed), called by its path, for example `/opt/opencode/node_modules/opencode-linux-x64/bin/opencode`. Node's slim base image is glibc, so the non-musl package. Dependabot keeps it current, and each new version reruns these checks.
- `/opt/opencode/xdg-config/opencode/.gitignore` in the image, read-only (check 6).
- git, as today. The binary adds about 214 MB to the image.

**Per-run config, written by the wrapper** to a file outside the repository (for example `$TMPDIR/foreman-opencode.json`), from the run's settings and task:

- One provider entry for the run's route: our own id, `npm` `@ai-sdk/anthropic` for Anthropic or `@ai-sdk/openai-compatible` for DeepInfra, `baseURL` the proxy address plus the provider's API path, `apiKey` the placeholder, the one model with `tool_call: true`, `limit.output` within the provider's cap (DeepInfra 16,384), `cost` from `FOREMAN_MODEL_PRICE` (all four fields), and `options.service_tier` when the route asks for Flex on DeepInfra (and `options.prompt_cache_key` set to the run id).
- `enabled_providers` with that one id, `model` and `small_model` set to it.
- `autoupdate: false`, `share: "disabled"`, `snapshot: false`, `lsp: false`, `formatter: false`.
- `permission` from the task's allowed tools (check 3). The Developer's and Designer's bot files keep D-196's names; the wrapper maps them, and refuses a name it has no mapping for.
- `instructions`: one file holding the task's instructions (written next to the config). OpenCode adds it to the system prompt, as `--append-system-prompt` does today. OpenCode's own system prompt stays in front of it.
- `mcp.magicpath` for a Designer only, once `MAGICPATH_ENABLED` is on (`./magicpath.ts`), with `magicpath_*` allowed.

**Command.** `opencode run --format json --pure --title <run id> -m <provider id>/<model>`, with the task input on stdin and no message argument, stdout piped, stderr drained and not printed (it can hold the agent's text), by path with no shell.

**Environment.** The current allow-list (`PASSED_THROUGH` in `args.ts`) plus `HOME` (the work folder), `TMPDIR`, `XDG_CONFIG_HOME=/opt/opencode/xdg-config`, `OPENCODE_CONFIG=<the per-run file>`, `OPENCODE_DISABLE_AUTOUPDATE=1`, `OPENCODE_DISABLE_MODELS_FETCH=1`, `OPENCODE_DISABLE_LSP_DOWNLOAD=1`, `OPENCODE_DISABLE_PROJECT_CONFIG=1`, `OPENCODE_DISABLE_CLAUDE_CODE=1`, `OPENCODE_DISABLE_DEFAULT_PLUGINS=1`, `OPENCODE_DISABLE_EXTERNAL_SKILLS=1`. Never `HTTP_PROXY`, `OTEL_*`, `OPENCODE_ENABLE_*` or `OPENCODE_PERMISSION`. `ANTHROPIC_BASE_URL` stops being the image's base address setting: the settings need the proxy's base address for the run's provider and which API it speaks.

**Wrapper responsibilities** (the image's `main.ts`):

1. Read settings and the price; fail closed as today (`price.ts`).
2. Refuse a checkout with `.opencode`, `opencode.json` or `opencode.jsonc` at its root (check 6a).
3. Write the config and instructions file; start OpenCode; pass SIGTERM on.
4. Read events line by line: count turns, sum tokens, price each step, keep the last text and the last error.
5. Stop with SIGTERM (then SIGKILL after the grace period) when the cost plus the last step's cost reaches the dollar cap (`max_budget`) or the turn count reaches the turn limit (`max_turns`).
6. Print the one result line (mapping under check 1), with every credential value removed, and exit 0 only on success.

The proxy settings stay. One number changes: OpenCode makes up to 6 requests on one Flex 429 before giving up, so `max_rejected_model_requests` (5 to start) cuts the last retry off with the proxy's 403, and that run would be recorded `budget_exceeded` instead of `usage_exhausted`. Set it to 6 or more for OpenCode runs, or accept that.

## Risks

- **The cap lives in the pod, beside the agent.** The wrapper is another process in the same pod and user. Code the agent runs through `npm` could signal it or OpenCode, and a repository plugin (if the check 6a rule were missed) could print false events. Claude Code's `--max-budget-usd` had the same weakness, being inside the agent's own process. The proxy's request ceiling and the deadline remain outside the model's reach. A stronger design is for the proxy to price usage from the responses it already sees and refuse past the dollar cap; that changes the proxy, so it is for Didi to decide later.
- **The cap can overshoot by one request,** since it is checked between requests. A single Sonnet request near a full context is about 0.60 USD at Standard prices for the input alone (200,000 tokens × 3 USD per million).
- **Flex retry policy is OpenCode's, not ADR 0114's.** OpenCode retries a 429 up to 5 times, 2 s doubling (about 62 s in all), or per `retry-after`; ADR 0114 section 9 wanted 3 retries starting at 30 s. It is fixed in OpenCode's code. If DeepInfra's Flex queue needs longer waits, a run ends `usage_exhausted` sooner than planned; the rehearsal measures it.
- **Served tier and Flex prices.** OpenCode prices one tier and does not report the served tier. The wrapper prices at Standard, which is never below what Flex bills, so the cap errs safe; the recorded cost uses the proxy's served tier, as ADR 0114 section 8 already plans.
- **Fake evidence only.** Real Anthropic and DeepInfra responses (cache hits, the `thinking` and `anthropic-beta` fields OpenCode sends for Claude, tool-call formats of each open model, DeepInfra's Flex rejection body) are not tested here. The image's first run against the real proxy repeats the checks.
- **A young version.** 1.19.5 was three days old when read, and OpenCode releases often. The config schema moved recently (a v1 and v2 loader side by side, `tools` replaced by `permission` in 1.1.1). Every version bump reruns these checks before the pin moves.
- **Context compaction** (automatic summary requests on long runs) was not exercised. Its requests go through the same session processor, so they should appear as `step_finish` events, but this is not confirmed; the proxy ceiling covers it meanwhile.
- **OpenCode's own system prompt** ("You are OpenCode ...", with UI hints such as "ctrl+p") comes before our instructions. Replacing it with an agent `prompt` is possible; whether that is better is for the rehearsal.

## Recommendation

**Build the OpenCode image with a wrapper-enforced cap.** Checks 1, 3, 4, 5 and 6 pass on 1.19.5. Check 2 does not pass on OpenCode alone (no dollar cap, and `steps` is advisory), but OpenCode reports each step's tokens as it goes and prices from our table, so the wrapper enforces both the dollar cap at catalog prices and the turn limit, as shown. Nothing here needs Didi before the build: no account, credential or paid plan, and the proxy needs only the `max_rejected_model_requests` value above. Two points are worth his eye when the image's PR comes: the wrapper rule that refuses a repository `.opencode` folder or `opencode.json` (check 6a), and that the dollar cap now lives in the image wrapper rather than the runtime (Risks).
