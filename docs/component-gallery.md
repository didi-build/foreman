# Component gallery

Every Launchpad-derived repo includes a **component gallery**: a `/gallery` route on the Cloudflare Worker preview that renders each registered component with its variants and props. Use it while implementing UI from approved specs and while reviewing PRs.

## Who edits what

| Role          | `design/` (spec files under `design/<area>/<feature>/`) | `components/` (gallery implementations)                                                     |
| ------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| **Designer**  | Create and update specs (Diadem approves them).         | Build or update gallery components from the spec after Diadem approves it.                  |
| **Developer** | No edits                                                | Yes, only for non-design changes: props or tiny non-design wiring fixes                     |
| **QA**        | Read specs                                              | Verify gallery components match the approved spec (no second Diadem approval on components) |

The **`design/` tree is designer-only.** Developers wire components from the gallery into `src/` (or your app tree) and do not change specs.

For Linear status names and handoffs (design ticket, developer counterpart, Diadem approval, QA), see [Design ticket flow](./design-workflow.md).

## Directories

| Path                       | Purpose                                                                                |
| -------------------------- | -------------------------------------------------------------------------------------- |
| `design/<area>/<feature>/` | Design specs (`spec.md` per feature); index in [design/README.md](../design/README.md) |
| `components/`              | Gallery components and `*.gallery.ts` metadata (variants, props, spec link)            |
| `gallery/`                 | Gallery SPA (registry, layout, styles); not the app under `src/`                       |

Gallery metadata may import spec markdown at build time for display; specs remain designer-only at edit time.

## Add a component

1. Add an approved spec at `design/<area>/<feature>/spec.md` and list it in `design/README.md`.
2. Implement the component under `components/<name>/`.
3. Add `<name>.gallery.ts` exporting a `GalleryEntry` (see `components/example-button/example-button.gallery.ts`).
4. Register it in `gallery/registry.ts`.
5. Run `npm run build` and open `/gallery` locally with `npm run dev:gallery` or on a PR preview.

## Local development

```bash
npm install
npm run dev:gallery   # Vite dev server with /gallery
npm run build         # Production asset build (also runs in npm run check)
```

Same-repo pull requests get a **gallery preview** comment from CI. When repository secrets `CLOUDFLARE_API_TOKEN_PREVIEW` and `CLOUDFLARE_ACCOUNT_ID` are set, the comment links to `/gallery` on the preview Worker (`launchpad-preview` in the template; `<slug>-preview` after `init-project`). The preview token must be **Workers Scripts Edit** only on that preview Worker; do not grant D1 or R2 Edit because PR-branch code can reach this token. Without those secrets, the Preview job is **neutral** and the comment explains that previews are not configured (expected for a fresh template until you opt in). Fork PRs never run preview deploy.

See [ADR 0004](./decisions/0004-component-gallery.md) for hosting choices and [ADR 0005](./decisions/0005-preview-worker-isolation.md) for preview Worker isolation.
