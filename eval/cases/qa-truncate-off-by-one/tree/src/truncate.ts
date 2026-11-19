/**
 * Truncates text to a maximum length, adding an ellipsis if truncated
 * @param text - The text to truncate
 * @param max - The maximum length (must be >= 1)
 * @returns The truncated text with ellipsis, or the original text if within limit
 * @throws RangeError if max is less than 1
 */
export function truncate(text: string, max: number): string {
  // Check if max is valid
  if (max < 1) {
    throw new RangeError("max must be at least 1");
  }

  // Return unchanged if text length is within limit
  if (text.length <= max) {
    return text;
  }

  // Truncate and add ellipsis
  return text.slice(0, max) + "…";
}
