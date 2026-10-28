# Design specs

This folder holds design specs for Launchpad-derived repos. Specs are organized by area and feature, not by ticket.

## Layout

```
design/<area>/<feature>/
  spec.md      purpose, variants, copy, and decisions
```

- To change a feature later, edit its existing `spec.md` in place. Git history is the record; do not add per-ticket copies.
- No ticket numbers in folder or file names.
- Spec PRs touch only files under `design/`. See [docs/component-gallery.md](../docs/component-gallery.md) for who may edit specs versus gallery components.

## Features

| Area    | Feature        | Spec                                                             |
| ------- | -------------- | ---------------------------------------------------------------- |
| gallery | Example button | [gallery/example-button/spec.md](gallery/example-button/spec.md) |
