/** Tiny example module — replace with your domain code. */
export function greet(name: string): string {
  if (!name.trim()) {
    throw new Error("name is required");
  }
  return `Hello, ${name.trim()}!`;
}
