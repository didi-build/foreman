import type { ComponentType } from "react";

export type GalleryVariant = {
  name: string;
  props: Record<string, unknown>;
};

export type GalleryEntry = {
  id: string;
  title: string;
  specPath: string;
  specMarkdown: string;
  component: ComponentType<Record<string, unknown>>;
  variants: GalleryVariant[];
};
