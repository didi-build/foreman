# Documentation index

Project docs live here so humans and agents share the same map.

| Path                                                                               | Purpose                                                                           |
| ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| [architecture/](./architecture/)                                                   | System shape: boundaries, interfaces, environments, data flow                     |
| [decisions/](./decisions/)                                                         | Numbered decision records (context, decision, consequences)                       |
| [runbooks/](./runbooks/)                                                           | Operational notes: deploy, rollback, incidents                                    |
| [new-project-checklist.md](./new-project-checklist.md)                             | GitHub settings after creating a repo from Launchpad                              |
| [component-gallery.md](./component-gallery.md)                                     | Spec vs component directories and `/gallery` workflow                             |
| [design-workflow.md](./design-workflow.md)                                         | Linear design ticket statuses and handoffs to developer work                      |
| [prd.md](./prd.md)                                                                 | Project Factory v2 product requirements                                           |
| [spec.md](./spec.md)                                                               | State machines, roles, gates and contracts. The rule book                         |
| [architecture/technical-architecture.md](./architecture/technical-architecture.md) | Components, runner design, integrations, security, failure handling               |
| [schema.md](./schema.md)                                                           | Proposed column-level design of the state store                                   |
| [decision-log.md](./decision-log.md)                                               | Every product and build decision with its date, plus what is open and who decides |
| [build-plan.md](./build-plan.md)                                                   | Milestones and tasks, in order, with verification                                 |
| [test-plan.md](./test-plan.md)                                                     | What is tested at which seam                                                      |
| [cutover.md](./cutover.md)                                                         | Moving from the Grok routines to the runner                                       |
| [grok-mapping.md](./grok-mapping.md)                                               | What every Grok routine, rule and gate becomes in v2                              |
| [implementation-brief.md](./implementation-brief.md)                               | Prompt for starting an implementing agent on a milestone                          |
| [spikes/](./spikes/)                                                               | Milestone 0 spike records: questions, desk results, run results                   |

Start with architecture and decisions before feature code. See [AGENTS.md](../AGENTS.md). The reading order for the Project Factory v2 documents is in the [README](../README.md#read-in-this-order).
