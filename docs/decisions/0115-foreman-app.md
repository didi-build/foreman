# 0115. Foreman's app: the chat, the views and the topology

- **Status:** direction accepted by Didi in the planning interview of 2026-11-16 (D-390 to D-399). The open points at the end are settled as the app is designed and built, each with its own decision.
- **Date:** 2026-11-16
- **Related:** D-012, D-126, D-242, D-254, D-266, D-271, D-273, D-282, D-343, D-345, D-353, D-354, D-377, D-378, N-96, [ADR 0004](./0004-component-gallery.md), [ADR 0102](./0102-state-api-hosting-and-agent-auth.md), [ADR 0106](./0106-agent-execution-environment.md)

## Context

The first rehearsal reached Done on 2026-11-16: a plan went from submission through the Council, Triage, the Developer, CI, QA, Foreman's own merge, the staging deploy and the live staging check. Didi still works Foreman through stopgaps: a Claude project to shape a plan, Windmill's submit form (D-383) to send it, Windmill's approval pages to answer, and SQL to see what is happening.

Didi wants Foreman's own frontends, built by Foreman through its own flow, which also tests that flow's quality: first a chat and planning interface that replaces the submit form, then views of the plans and items, then a map of the running system. Didi wants generative UI, a progressive web app that works on a phone first and survives a bad network, and sign-in with Google and device passkeys.

## Decision

1. **Generative UI, both ways (D-390).** The design track keeps a catalog of approved components (design as code, ADR 0004). At runtime the assistant composes screens from that catalog: a plan card, a form, a table, choices to tap. At build time Foreman's agents add or change components through the normal flow. The catalog is machine-readable: each component has a name, an input schema and a note on when to use it. A screen the assistant composes is data (component names and inputs), checked against the catalog on the server and again in the browser. Only known components with valid inputs are drawn; anything else falls back to plain text. Code or markup written by the model is never run or rendered.
2. **One app, in its own project (D-391).** One new repository made from Launchpad, working name `foreman-app`, holds one app with three sections: the chat, the plans and items views, and the topology. It has one sign-in, one catalog and one renderer. It is created by the one-approval project flow (D-377, D-378) as that flow's first real use, so the flow is built first.
3. **A progressive web app, mobile first, network resilient (D-392).** It installs to a phone's home screen and opens from its cached shell with no network. Phone layouts are explored first. A plan being written is kept on the device; a submission made offline waits in an outbox and is sent once the network is back, carrying an idempotency key so Foreman accepts it once however often it is retried. The chat resumes from its last event. Nothing secret is stored on the device: only the session and what the signed-in person may see.
4. **Sign-in (D-393).** Google sign-in and device passkeys, for one person: Didi's Google account, matched by its stable account id, and the passkeys Didi registers. Anyone else is refused, even with a valid Google account; adding a person is its own decision. A new device signs in with Google once and registers its passkey (WebAuthn); from then on that device signs in with the passkey alone. Google also recovers access when a device is lost, and a lost device's passkey can be removed from another.
5. **The server side runs in Foreman's cluster (D-394).** A new small service behind `foreman.didi.build/api` (D-343) handles sign-in, sessions, the chat's model calls, Foreman's plans and items for the signed-in person, and the topology data. Model keys stay behind the egress proxy as they do for agents; the service reaches the state API with its own narrow identity. The browser holds only a session cookie. Its code lives in `foreman` under the usual review, while the app's screens live in `foreman-app`, which Foreman's agents build.
6. **One address (D-395).** The app is served at `https://foreman.didi.build/`, and its server side under `/api` on the same address, so the session cookie never crosses addresses. A staging copy at `foreman-app.didi.build` shows each change before it goes live, as for every project (D-353). This settles N-96's direction.
7. **Chat v1: plan, submit, follow (D-396).** Didi shapes a plan with the Council in its planning role (D-266). When ready, the Council shows a plan card (title, plan, product direction, whether it needs Didi); Didi checks it and submits with one tap; then the conversation follows the plan through acceptance, Triage and its items. Each conversation belongs to one project and is kept. Approvals stay on Windmill's pages for v1; answering them in the app is v1.1.
8. **Views: what needs Didi, then where everything is (D-397).** First a Needs you list (approvals waiting, the Council's questions, stuck items: D-012's attention list), then a board by state filterable by project, then each item's full story: its plan, runs and costs, pull request and checks.
9. **Topology: a live map built from data (D-398).** The server side assembles the map from Foreman's own sources each time: the settings files (projects and their namespaces), the bot files (roles), the flows, the image pins, and a read-only view of the cluster, whose agent pods carry their role and item as labels. The app lays it out automatically and draws a kind it does not know as a plain labelled box. Optional hints only tidy grouping and labels. A test in Foreman's CI builds the map from the repository's files, so a change that would break it fails before it merges.
10. **Design review in the gallery; MagicPath out (D-399).** The Designer explores in two or three gallery option pages, which CI renders and Foreman captures, and Didi picks one on the approval form (D-242, D-254). MagicPath (D-128, D-190, D-198) leaves the plan, on Didi's condition that this review works; the first real design item confirms it.

The order of the work: the tidy-up of the rehearsal; this planning; the one-approval project flow (D-377, D-378); role playbooks for the Designer, Developer and QA, worded with Didi's approval; then the chat, the views and the topology, each through the design track and then the developer track.

## Constraints

- Only Didi signs in. No other identity, role or allowlist exists until Didi decides one.
- No credential is stored in the browser or on Cloudflare: model keys, the state API identity and the session signing key live in the cluster.
- The screens never run model-written code or markup; generative UI draws only catalog components with checked inputs.
- Project sites on Cloudflare stay code-free (D-353): the app's pages are static assets.
- A submission is accepted once, whatever the network does.
- Creating the Google OAuth client, the session key and any other new credential is Didi's gate. New tables for passkeys and sessions are a migration, a privileged path Didi reviews. Didi's Google account id is personal data and is recorded in the data map.

## How success is judged

- From a phone with no signal, Didi opens the installed app, drafts a plan, and the plan is submitted once, and only once, when the network returns.
- Didi signs in on a new device with Google once, then with a passkey alone; any other Google account is refused.
- Didi shapes and submits a plan in the chat and follows it to its items; the Windmill submit form is no longer needed.
- The assistant's plan card is a catalog component; a composed screen naming an unknown component, or with invalid inputs, falls back to text.
- Adding a role, a project or a service changes the topology map with no change to the app, and a change that would break the map fails CI.
- The first design item is reviewed in the gallery without MagicPath.

## Consequences

- The design track and the one-approval project flow get their first real use on Foreman's own UI, so their gaps show early.
- `foreman` gains one service, its migration and its review; `foreman-app` holds only screens and the catalog, so agents improving the UI never touch the runner.
- Windmill stays the place for approvals until v1.1, and for the runner's flows.

## Open points

- The service's name, and the exact routes under `/api`.
- How `foreman.didi.build/` reaches the app's static Worker while `/api/*` keeps going through the tunnel: N-96's notes suggest a route for the app with a no-Worker route for `/api/*`, to be confirmed against Cloudflare when built.
- Production deploys of `foreman-app`: projects start with no production (D-345), and a production deploy is Didi's (D-007).
- The model and limits for the planning chat.
- The catalog's manifest format and how the Designer keeps it current.
