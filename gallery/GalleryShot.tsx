import { useEffect, useState } from "react";
import { galleryEntries } from "./registry.js";
import { SHOT_ATTRIBUTES, SHOT_MODE_CLASS } from "./shot-mode.js";

/** The render mode (./shot-mode.ts): one entry's variant in a plain frame, nothing else. */
export function GalleryShot({
  entryId,
  variantName,
}: {
  entryId: string;
  variantName: string;
}) {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let live = true;
    document.documentElement.classList.add(SHOT_MODE_CLASS);
    void document.fonts.ready.then(() => {
      if (live) setReady(true);
    });
    return () => {
      live = false;
      document.documentElement.classList.remove(SHOT_MODE_CLASS);
    };
  }, []);

  const entry = galleryEntries.find((e) => e.id === entryId);
  const variant = entry?.variants.find((v) => v.name === variantName);
  if (!entry || !variant) {
    return (
      <p {...{ [SHOT_ATTRIBUTES.missing]: "" }}>
        No gallery entry or variant by that name.
      </p>
    );
  }
  const Component = entry.component;
  return (
    <div
      className="gallery-shot"
      {...{
        [SHOT_ATTRIBUTES.shot]: entry.id,
        [SHOT_ATTRIBUTES.ready]: ready ? "true" : "false",
      }}
    >
      <Component {...variant.props} />
    </div>
  );
}
