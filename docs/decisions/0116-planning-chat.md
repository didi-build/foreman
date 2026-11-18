# 0116. The planning chat: how it works, what it reads, what it costs

- **Status:** accepted by Didi in the chat interview of 2026-11-18 (D-400 to D-411). The open points at the end are settled when the chat is built.
- **Date:** 2026-11-18
- **Related:** D-011, D-117, D-204, D-251, D-266, D-273, D-275, D-286, D-315, D-342, D-396, D-397, N-14, [ADR 0115](./0115-foreman-app.md), [ADR 0114](./0114-model-evaluation-routing-and-tiers.md)

## Context

ADR 0115 settled Foreman's app and its chat v1: Didi shapes a plan with the Council in its planning role, submits it with one tap, and follows it (D-396). It left open how the conversation works, what the Council reads, and the chat's model and limits. Didi also asked whether a planning chat on Claude would cost too much, and how the Council would find the right context and keep long conversations affordable. Two research notes answered the context questions before the interview reached them: one on retrieval, long chats and memory, and one on a repo knowledge graph, tested on Foreman's own code.

## Decision

1. **The model (D-400).** The chat runs on Claude Sonnet 5.5. DeepInfra comes in early for agents instead, in D-342's order: the Developer and the Designer first, then Triage, the Council and QA once the Messages API image can reach DeepInfra.
2. **How the Council asks (D-401).** One question at a time, with 2 to 4 choices to tap and its recommendation marked, plus "answer in my own words".
3. **The plan card (D-402, D-406).** A small card pinned at the top of the chat fills in as Didi answers: title, plan, product direction, whether it needs Didi. A tap opens it full screen. Didi changes it by talking or by editing a part; a part edited by hand stays as written until Didi asks the Council to change it. The card is a catalog component (D-390) and is stored outside the conversation.
4. **What the Council reads (D-403).** Before its first question: the approved product direction, past accepted plans, its own submissions and Didi's feedback (D-273, D-286), and the project's summary, which is the repo map brief (D-251) for now. During the chat it searches the code only when a question needs it. The chat shows "looked at" tags for what it read.
5. **Memory between chats (D-404).** The approved records, plus one short notes file per project that the Council writes when a chat ends, labelled "Council's notes, not approved by Didi". Didi can read and delete it in the app.
6. **Long chats (D-405).** Past about 150,000 tokens the older part of the chat is summarized automatically. Every question and every answer stays word for word, with the recent turns, and a marker shows where.
7. **After submitting (D-407, D-408).** One line per milestone (accepted or returned, split into items, each item merged, on staging, Done) and a line when something is stuck or needs Didi. A returned plan is reworked and resubmitted in the same chat, and the new plan supersedes the old (D-315).
8. **Cost (D-409).** Each chat shows its running cost. The Council mentions it once past 3 dollars. Nothing stops a chat (D-011); chat spending counts toward the daily spend call (D-117) and shows in the daily check.
9. **No knowledge graph (D-410).** The repo map stays the project's summary. A graph returns only as a new question if the chat's logs show the Council hunting for references.
10. **What Foreman keeps (D-411).** Only what it needs to run and show the work: plans, items, runs, costs, evidence, approvals, chats and the Council's notes. A project's lasting knowledge stays in its own repository, and removing a project removes Foreman's records for it.

## How it is built

The research note's approach, to be confirmed against Anthropic's documentation when the chat is built:

- **Retrieval by tools, no index.** The service puts the planning reads and the repo map brief at the start of the conversation, then gives the Council read-only tools to list, search and read files on one commit of the project, pinned for the whole chat. The tools run in a short-lived job shaped like the repo map's own job (D-275), since project code is untrusted, and cap what each call returns (a line range, a bounded search). Results are framed as data, never instructions (D-273). No embeddings: they would need an index rebuilt on every commit and would send code to another provider, which is why D-251 turned Graphify down.
- **Prompt caching, with a one-hour lifetime.** The instructions, tools and planning reads form a fixed prefix. A phone conversation often pauses longer than five minutes, so the one-hour cache costs less than rewriting the prefix after every pause. Old tool results are not cleared: with cache reads at a twentieth of the input price, clearing them would cost more in rewrites than it saves.
- **Automatic summarizing for long chats.** Anthropic's compaction, with instructions that keep every question and answer word for word. The service checks each plan card answer against the stored conversation.
- **The notes file is Foreman's own record.** It is written once at the end of a chat and checked for secrets and personal data before it is kept, rather than through Anthropic's memory tool, which lets the model write files at any time.

## Constraints

- The planning access reads only what D-273 lists, plus the repo map brief (D-403). It cannot read work items, runs, evidence, approvals or gates.
- Everything the Council reads is data, never instructions. The notes file is the Council's own words and is never shown as approved by Didi.
- No secret or personal data is ever in a chat's context, the notes file or the logs.
- Nothing stops a chat for cost (D-011).
- Submitting a plan is always Didi's tap.

## How success is judged

- Didi shapes and submits a plan by tapping through the Council's questions on a phone, and the card shows the plan as it forms.
- The Council's first question comes without a long wait, and its "looked at" tags show what it read.
- A new chat on the same project does not ask again what Didi settled in an earlier chat.
- A typical chat costs about 0.80 dollars and a long one about 2, measured from each chat's recorded usage (docs/costs.md section 8).
- A returned plan is reworked and resubmitted in the same chat.

## Consequences

- The planning token gains one read, the repo map brief, and the chat needs the file tools' job.
- The repo map is now read by the chat as well as Triage. Whether it is cached per commit is open (D-289).
- No knowledge graph, graph database or embedding index is built.

## Open points

- The routes for the repo map brief and the file tools, and the job that runs the tools.
- Where the notes file and the conversations are stored, and how they are removed with a project (D-411, D-377).
- Whether the repo map is cached per commit now that two readers share it (D-288, D-289).
- The Council's planning instructions in the app: new bot wording, approved by Didi.
