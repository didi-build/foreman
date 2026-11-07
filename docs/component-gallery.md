# Component gallery

Every Launchpad-derived repo includes a **component gallery**: a `/gallery` route that renders each registered component with its variants and props. Use it while implementing UI from approved specs and while reviewing PRs.

## Who edits what

| Role          | `design/` (spec files under `design/<area>/<feature>/`)                   | `components/` (gallery implementations)                                                   |
| ------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| **Designer**  | Create and update specs from the option Didi approved (no spec approval). | Build or update gallery components from the merged spec.                                  |
| **Developer** | No edits                                                                  | Yes, only for non-design changes: props or tiny non-design wiring fixes                   |
| **QA**        | Read specs                                                                | Verify gallery components match the approved spec (no second Didi approval on components) |

The **`design/` tree is designer-only.** Developers wire components from the gallery into `src/` (or your app tree) and do not change specs.

For Linear status names and handoffs (design ticket, developer counterpart, Didi's visual approval, QA), see [Design ticket flow](./design-workflow.md).

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
5. Run `npm run build` and open `/gallery` locally with `npm run dev:gallery`.

## Local development

```bash
npm install
npm run dev:gallery   # Vite dev server with /gallery
npm run build         # Production asset build (also runs in npm run check)
```

Pull requests get no hosted preview (D-354). CI's `preview-check` job builds the gallery on CI's own machine, serves it on 127.0.0.1 and checks that it loads and serves the head commit; see the [deploy runbook](./runbooks/deploy.md).

## Screenshots for the visual comparison (D-242, D-250)

In the factory, QA's visual comparison reads screenshots of each gallery entry and variant, taken by CI at the PR head, and of each exploration option page under `design/<area>/<feature>/options/<name>/`. Each bundle is one commit's PNGs with a `manifest.json` (version 1): for the gallery, each entry's `id` as `component`, the variant `name`, the file, its SHA-256, its size and the entry's `specPath`, plus a copy of each spec file; for options, each option's name and folder, the page's file, hash and size, and the boxes of the components the page marks. The runner checks the manifest strictly (`src/core/visual-comparison.ts`). An option page marks each component by wrapping it in an element with `data-component="<name>"` and, where it has variants, `data-variant="<name>"`, using the gallery's names (the component's entry id and the variant's name, D-255). The step that renders the page records each marked element's box as a region (`regionFromMarker`), and the runner crops the approved option by the region for the component and variant, or else the component's own; a component the page does not mark is shown whole, with no pixel comparison. CI renders both bundles at the PR head (D-275 point 1, O-81). A third bundle, `head-options`, holds every option folder at the head, rendered in the same job as the gallery; the comparison crops the approved option from it (D-281, O-86). Option names repeat across features, so it is unique by folder.

The gallery has a render mode for these screenshots: `/gallery?entry=<id>&variant=<name>` shows only that entry's variant in a plain frame (`data-gallery-shot`), with animations and transitions off, and marks the frame `data-ready="true"` once the page's fonts have loaded (`gallery/shot-mode.ts`). The normal page marks each entry with `data-gallery-entry` and `data-gallery-spec` and each variant with `data-gallery-variant`, so the render step lists them without reading the registry. The render step, `node scripts/render-screenshots.ts --kind gallery|options|head-options --commit <sha> --out <dir>`, renders at a 1280 by 800 viewport and device scale 1, in light mode with reduced motion, and refuses every request that leaves its local server. For `gallery` it builds the gallery and screenshots every entry and variant's frame. For `options` it renders `index.html` in each option folder the pull request changes (`--changed-since <base sha>`), screenshots the whole page and records each `data-component` element's box. For `head-options` it does the same for every option folder tracked at the commit. It then reads the manifest back with the runner's own check and fails on any mismatch. The Screenshots workflow (`.github/workflows/screenshots.yml`) runs it on each pull request with the Google Chrome on GitHub's runners and uploads the bundles as `foreman-screenshots-gallery`, `foreman-screenshots-options` and `foreman-screenshots-head-options`. To run it locally you need a Playwright Chromium (`npx playwright-core install chromium`) or `--browser chrome` with Google Chrome installed.

After Didi approves an option, the spec step deletes the folders of the options Didi did not pick, and the approved option's folder stays on the item's branch, so it reaches main as the reference for the comparison (D-253). CI renders it again at each head (D-281), and the runner compares only when nothing under that folder changed since Didi approved it.

See [ADR 0004](./decisions/0004-component-gallery.md) for hosting choices. [ADR 0005](./decisions/0005-preview-worker-isolation.md) (preview Worker isolation) is superseded by D-354.
