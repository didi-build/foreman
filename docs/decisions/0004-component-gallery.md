# 0004. Add a per-repo component gallery on Cloudflare Workers

- **Status:** accepted (partially superseded by [0005](./0005-preview-worker-isolation.md))
- **Date:** 2026-10-26

## Context

New repos from Launchpad need a shared place to build UI from approved specs, preview components on every PR, and keep designer specs separate from implementation.

## Decision

1. **Hosting:** A static React gallery built with Vite and served from a Cloudflare Worker via Wrangler **static assets** (`not_found_handling: single-page-application`). No separate gallery server or Next.js app.
2. **Worker naming:** The template keeps `"name": "launchpad"` in `wrangler.jsonc` so Launchpad's own previews work. `init-project` renames the Worker to the project slug (same idea as `package.json`), so each derived repo gets its own Worker and `pr-N` previews do not collide across repos.
3. **Routes:** The gallery SPA lives at `/gallery` (root redirects there). Variants and props come from per-component gallery metadata beside each component.
4. **Directories:** `specs/` (designer-only) and `components/` (gallery implementations: Designer builds from the approved spec; Developer edits only for props or tiny non-design wiring fixes). The gallery UI is driven from `components/` and `gallery/`; each `*.gallery.ts` may import its spec markdown at build time (`?raw`) for display in the gallery only.
5. **PR previews:** `.github/workflows/preview.yml` runs `npx wrangler preview` on same-repo pull requests when `CLOUDFLARE_API_TOKEN_PREVIEW` (Workers Scripts Edit only) and `CLOUDFLARE_ACCOUNT_ID` are set; otherwise the job ends neutral with a single updated PR comment. Deletes the preview when the PR closes.

## Reasons

- **Static assets on Workers** is the lightest way to ship a `/gallery` route on every repo without a second app server.
- **Rename Worker on init** keeps the template repo deployable as `launchpad` while guaranteeing one Worker per generated repo (preview isolation).
- **Explicit gallery registry** is simpler than Storybook and matches the Workers asset model.
- **Alternatives considered:** MagicPath or external-only design tools (do not ship in every repo or tie to PR previews); Vinext / Next on Workers (heavier than needed); Storybook (extra runtime and config).

## Consequences

- `npm run check` includes `npm run build` so the gallery always compiles in CI.
- Derived repos inherit the same layout; `init-project` keeps `specs/`, `components/`, and `gallery/`.
- Preview deploy uses preview-scoped repository secret names documented in README and runbooks; missing secrets are a neutral config state for the template.
- Preview Worker isolation from production is documented in [0005](./0005-preview-worker-isolation.md).

## Note (2026-10-28)

Spec files now live under `design/<area>/<feature>/spec.md` with a `design/README.md` index (Didi Build layout convention, same as we-met). The decision bullets above still describe the original `specs/` path; new and derived repos use `design/` instead.
