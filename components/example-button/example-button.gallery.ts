import specMarkdown from "../../design/gallery/example-button/spec.md?raw";
import type { GalleryEntry } from "../../gallery/lib/types.js";
import { ExampleButton } from "./ExampleButton.js";

export const exampleButtonGallery: GalleryEntry = {
  id: "example-button",
  title: "ExampleButton",
  specPath: "design/gallery/example-button/spec.md",
  specMarkdown,
  component: ExampleButton as GalleryEntry["component"],
  variants: [
    {
      name: "Primary",
      props: { label: "Save changes", variant: "primary" },
    },
    {
      name: "Secondary",
      props: { label: "Cancel", variant: "secondary" },
    },
    {
      name: "Disabled",
      props: { label: "Unavailable", variant: "primary", disabled: true },
    },
  ],
};
