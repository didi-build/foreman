# Architecture overview — {{PROJECT_NAME}}

Replace this file with your system’s architecture. Keep it short; link to deeper docs as the project grows.

## Purpose

{{PROJECT_PURPOSE}}

## Boundaries

- **In scope:** What this repository owns.
- **Out of scope:** What lives in other repos, vendors, or platforms.

## Interfaces

- **Inbound:** APIs, webhooks, CLI, UI — who calls this system and how.
- **Outbound:** Databases, queues, third-party APIs — what this system calls.

## Environments

| Environment | Purpose             | Notes                                                                                 |
| ----------- | ------------------- | ------------------------------------------------------------------------------------- |
| local       | Developer machines  | `.env` from `.env.example`                                                            |
| PR preview  | Pull request review | `pr-N` on `<slug>-preview` Worker (`wrangler.preview.jsonc`, `preview.yml`); optional |
| staging     | Pre-production      | Fill in when you have one                                                             |
| production  | Live                | Fill in when you have one                                                             |

## Data flow

Describe the main paths (request → logic → storage → response). A simple diagram or bullet flow is enough for v1.

## Open questions

List unknowns explicitly. Resolve them via `docs/decisions/` before building the affected feature.
