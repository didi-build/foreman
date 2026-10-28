# Architecture overview — Foreman

Short entry point. The full design is in [technical-architecture.md](./technical-architecture.md).

## Purpose

Deterministic runner and state store for AI-driven software work. Ideas go in, and gated, verified work comes out. Windmill runs it, Postgres holds the truth, and agents do the work.

## Boundaries

- **In scope:** see [prd.md, section 7](../prd.md#7-scope) and the components in [technical-architecture.md, section 2](./technical-architecture.md#2-components).
- **Out of scope:** see [prd.md, section 5](../prd.md#5-non-goals-for-v1).

## Interfaces

- **Inbound:** the state API and webhooks, see [technical-architecture.md, sections 2.3 and 2.7](./technical-architecture.md#23-state-api-tiny-proposed).
- **Outbound:** the state store and the adapters (GitHub, Linear, agent runtimes, deploy, notification, approval), see [technical-architecture.md, sections 2.2 and 2.7](./technical-architecture.md#27-adapters).

## Environments

| Environment | Purpose             | Notes                                                                                 |
| ----------- | ------------------- | ------------------------------------------------------------------------------------- |
| local       | Developer machines  | `.env` from `.env.example`                                                            |
| PR preview  | Pull request review | `pr-N` on `<slug>-preview` Worker (`wrangler.preview.jsonc`, `preview.yml`); optional |
| staging     | Pre-production      | Fill in when you have one                                                             |
| production  | Live                | Fill in when you have one                                                             |

## Data flow

See the diagram in [technical-architecture.md, section 1](./technical-architecture.md#1-overview) and the key flows in [section 3](./technical-architecture.md#3-key-flows).

## Open questions

Unknowns are listed under Open in [decision-log.md](../decision-log.md#3-open). Resolve them via `docs/decisions/` before building the affected feature.
