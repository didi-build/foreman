# Pinned GitHub Action SHAs

Workflows pin third-party actions to full **40-character** commit SHAs with a `# vX.Y.Z` comment on the same line.

## Verify pins

From the repo root (requires `gh` authenticated for GitHub API):

```bash
npm run verify-action-pins
```

The script reads `.github/workflows/*.yml`, finds `uses: owner/repo@<sha> # v…` lines, resolves each tag via the GitHub API, and follows **annotated tags** (`object.type === "tag"`) to the underlying commit. It exits non-zero on any mismatch.

After changing a pin or tag comment, run this before merging.
