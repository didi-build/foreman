// The gallery's render mode for CI's screenshots (D-242, D-275 point 1). `/gallery?entry=<id>&variant=<name>`
// shows exactly one entry's variant and nothing else, with animations and transitions off. It marks
// its frame ready once the page's fonts have loaded, so the render script
// (scripts/render-screenshots.ts) waits for that and screenshots only the frame. The viewport and
// device scale are fixed by the render script. The normal gallery page marks each entry and
// variant, so the script can list them without reading the registry itself.
//
// Plain constants with no React, so the render script can import them too.

/** The query parameters that turn the render mode on. */
export const SHOT_PARAMS = { entry: "entry", variant: "variant" } as const;

/** Attributes the gallery sets for the render script. */
export const SHOT_ATTRIBUTES = {
  /** On each entry's section of the normal page: the entry id. */
  entry: "data-gallery-entry",
  /** On each entry's section of the normal page: the spec the entry links. */
  spec: "data-gallery-spec",
  /** On each variant of the normal page: the variant name. */
  variant: "data-gallery-variant",
  /** On the render mode's frame, the element the script screenshots. */
  shot: "data-gallery-shot",
  /** On the frame: "true" once the fonts have loaded. */
  ready: "data-ready",
  /** Shown instead of the frame when the entry or variant does not exist. */
  missing: "data-gallery-shot-missing",
} as const;

/** The class the render mode sets on the root element; gallery.css turns animations off under it. */
export const SHOT_MODE_CLASS = "gallery-shot-mode";
