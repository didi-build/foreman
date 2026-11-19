/**
 * Converts a title into a URL slug
 * @param title - The title to convert to a slug
 * @returns A URL-friendly slug string
 */
export function slugify(title: string): string {
  // Return empty string for empty input
  if (!title) return "";

  // Convert to lowercase and replace non-alphanumeric characters with hyphens
  let slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-");

  // Remove leading and trailing hyphens
  slug = slug.replace(/^-+|-+$/g, "");

  return slug;
}
