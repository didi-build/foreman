# Milestone 0 spikes

Spikes answer one question each with a recorded yes or no and evidence (`docs/build-plan.md`, M0.2 to M0.4). The scripts are throwaway code in `spikes/`. They are not product code: they do not follow the `src/` boundaries and are deleted or replaced once the adapters they inform exist.

## Status

| Spike | Question                                                          | Result now                                                        | Record                                                   |
| ----- | ----------------------------------------------------------------- | ----------------------------------------------------------------- | -------------------------------------------------------- |
| M0.2  | Can the runner start each agent and read its result? (V-01, V-04) | Desk result only. Not run yet: needs credentials                  | [m0.2-agent-dispatch.md](./m0.2-agent-dispatch.md)       |
| M0.3  | Can Linear's API create statuses and act as an app? (V-02)        | Desk result only. Moved to the start of Milestone 5 (D-147)       | [m0.3-linear-api.md](./m0.3-linear-api.md)               |
| M0.4  | Do Windmill approval pages work on a phone? (V-03)                | **Run 2026-10-29: yes**, with three rules for link safety (D-170) | [m0.4-windmill-approval.md](./m0.4-windmill-approval.md) |

A desk result comes from current documentation and public open-source examples. It is not a verdict. The build plan needs each spike to be run, and the run's output pasted into its record.

## Rules for every spike

- Scratch resources only: a throwaway GitHub repo, a test Linear team, a throwaway Windmill workspace folder. Never a real project, the real Didi Build team, or a production resource.
- Credentials come only from environment variables. The scripts never print their values and redact them from output. Creating a credential or an account, or starting a paid plan, is a gate: Didi does it.
- Each script prints one JSON record. Paste it into the spike's record under "Run results", with the date.
- A script that is missing a setting stops with exit code 2 and names the setting. It does nothing else.
- Scripts refuse to run (exit code 3) against anything not marked as scratch: the Claude Code spike needs a `.foreman-scratch` file in the scratch repo's root, and the Linear spike needs `LINEAR_EXPECTED_WORKSPACE` to match the token's workspace and refuses team `DIDI`.
- Agents get only an allow-listed set of environment variables, never the whole shell.

## How to run (Windows Git Bash, macOS or Linux)

Node 22 runs the TypeScript files directly. No install step is needed beyond the repo's own `npm ci`.

```bash
export SCRATCH_REPO_DIR=/path/to/a/clone/of/the/scratch/repo
export ANTHROPIC_API_KEY=...   # set it in the shell, never in a file in this repo
node spikes/m0.2-agent-dispatch/claude-code.ts
```

The settings for each script are listed at the top of the script and in its record.
