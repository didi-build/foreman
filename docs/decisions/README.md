# Decision records

Lightweight ADRs: one file per decision, numbered in order.

## Format

Use [0000-template.md](./0000-template.md). Filename pattern: `NNNN-short-title.md`.

## When to write one

- Choosing a library, protocol, or deployment model
- Anything an agent might otherwise guess

## Numbering

- 0000 to 0099: decisions that came with the Launchpad template.
- 0100 and up: decisions for Project Factory v2. [0100](./0100-handoff-placement.md) records why. The handoff documents planned ADRs 0001 to 0011; they are numbered 0101 to 0111 here, so the last two digits stay the same.

## Sections for Project Factory v2 ADRs

Use the template, and also cover the two things `AGENTS.md` asks of every ADR: the constraints, and how success is judged. Add them as `## Constraints` and `## How success is judged` after `## Decision`.
